use std::{error::Error, fmt, io::Read};

const BOOTSTRAP_LINE_LEN: usize = 65;
const TRUSTED_APP_URL: &str = r#"(() => {
    const u = new URL(globalThis.location.href);
    const authority = u.href.slice(u.protocol.length + 2).split(/[/?#]/, 1)[0];
    return u.protocol === "tauri:" && u.hostname === "localhost" && u.port === ""
        && u.username === "" && u.password === "" && !authority.includes("@");
})()"#;
const ORIGIN_PROBE_BODY: &str = r#"void fetch("http://127.0.0.1:46231/origin-probe", {
    method: "GET",
    mode: "cors",
    credentials: "omit",
    redirect: "error",
    cache: "no-store",
}).catch(() => {});"#;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum StartupMode {
    Normal,
    OriginProbe,
    BootstrapStdin,
}

#[derive(Debug)]
struct StartupError;

impl fmt::Display for StartupError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str("native startup failed")
    }
}

impl Error for StartupError {}

struct BootstrapToken([u8; 64]);

fn env_is_one(name: &str) -> bool {
    std::env::var_os(name).as_deref() == Some(std::ffi::OsStr::new("1"))
}

fn select_mode(origin_probe: bool, bootstrap_stdin: bool) -> Result<StartupMode, StartupError> {
    match (origin_probe, bootstrap_stdin) {
        (true, true) => Err(StartupError),
        (true, false) => Ok(StartupMode::OriginProbe),
        (false, true) => Ok(StartupMode::BootstrapStdin),
        (false, false) => Ok(StartupMode::Normal),
    }
}

fn parse_bootstrap(input: &[u8]) -> Result<BootstrapToken, StartupError> {
    if input.len() != BOOTSTRAP_LINE_LEN
        || input[64] != b'\n'
        || !input[..64]
            .iter()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(byte))
    {
        return Err(StartupError);
    }

    let mut token = [0; 64];
    token.copy_from_slice(&input[..64]);
    Ok(BootstrapToken(token))
}

fn read_bootstrap(reader: &mut impl Read) -> Result<BootstrapToken, StartupError> {
    let mut line = [0; BOOTSTRAP_LINE_LEN];
    reader.read_exact(&mut line).map_err(|_| StartupError)?;

    // The caller must close the pipe after the 65-byte line; one byte detects trailing input.
    let mut extra = [0];
    if reader.read(&mut extra).map_err(|_| StartupError)? != 0 {
        return Err(StartupError);
    }

    parse_bootstrap(&line)
}

fn bootstrap_for_mode(
    mode: StartupMode,
    read: impl FnOnce() -> Result<BootstrapToken, StartupError>,
) -> Result<Option<BootstrapToken>, StartupError> {
    match mode {
        StartupMode::BootstrapStdin => read().map(Some),
        StartupMode::Normal | StartupMode::OriginProbe => Ok(None),
    }
}

fn is_trusted_app_url(url: &tauri::Url) -> bool {
    let Some((_, rest)) = url.as_str().split_once("://") else {
        return false;
    };
    let authority = rest
        .split(|ch| matches!(ch, '/' | '?' | '#'))
        .next()
        .unwrap_or("");

    url.scheme() == "tauri"
        && url.host_str() == Some("localhost")
        && url.port().is_none()
        && url.username().is_empty()
        && url.password().is_none()
        && !authority.contains('@')
}

fn is_allowed_navigation(url: &tauri::Url) -> bool {
    is_trusted_app_url(url) || url.as_str() == "about:srcdoc"
}

fn guarded_script(body: &str) -> String {
    let mut script = String::from("if (");
    script.push_str(TRUSTED_APP_URL);
    script.push_str(") {\n");
    script.push_str(body);
    script.push_str("\n}");
    script
}

fn bootstrap_script(token: &BootstrapToken) -> Result<String, StartupError> {
    let token = std::str::from_utf8(&token.0).map_err(|_| StartupError)?;
    let mut body = String::from(
        r#"Object.defineProperty(globalThis, "__AYLACHI_CONNECTION__", {
    value: Object.freeze({ baseUrl: "http://127.0.0.1:46231", bearer: ""#,
    );
    body.push_str(token);
    body.push_str(
        r#"" }),
    writable: false,
    configurable: true
});"#,
    );
    Ok(guarded_script(&body))
}

fn run() -> Result<(), StartupError> {
    let mode = select_mode(
        env_is_one("AYLACHI_ORIGIN_PROBE"),
        env_is_one("AYLACHI_BOOTSTRAP_STDIN"),
    )?;
    let bootstrap = bootstrap_for_mode(mode, || {
        let stdin = std::io::stdin();
        let mut input = stdin.lock();
        read_bootstrap(&mut input)
    })?;

    tauri::Builder::default()
        .setup(move |app| {
            let window_config = app
                .config()
                .app
                .windows
                .first()
                .expect("missing window config");
            let mut builder =
                tauri::WebviewWindowBuilder::from_config(app.handle(), window_config)?
                    .on_navigation(is_allowed_navigation)
                    .on_new_window(|_, _| tauri::webview::NewWindowResponse::Deny);

            match mode {
                StartupMode::OriginProbe => {
                    builder = builder.initialization_script(guarded_script(ORIGIN_PROBE_BODY));
                }
                StartupMode::BootstrapStdin => {
                    let token = bootstrap.as_ref().ok_or(StartupError)?;
                    builder = builder.initialization_script(bootstrap_script(token)?);
                }
                StartupMode::Normal => {}
            }
            builder.build().map_err(|_| StartupError)?;
            Ok(())
        })
        .run(tauri::generate_context!())
        .map_err(|_| StartupError)
}

fn main() {
    if run().is_err() {
        eprintln!("Aylachi native startup failed");
        std::process::exit(1);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Cursor;

    fn valid_line() -> Vec<u8> {
        let mut line = vec![b'a'; 64];
        line.push(b'\n');
        line
    }

    #[test]
    fn accepts_exact_lowercase_hex_line() {
        let line = valid_line();
        let token = parse_bootstrap(&line).unwrap();
        assert_eq!(&token.0, &line[..64]);
        assert_eq!(read_bootstrap(&mut Cursor::new(line)).unwrap().0, token.0);
    }

    #[test]
    fn bootstrap_script_uses_only_the_validated_ephemeral_token() {
        let token = parse_bootstrap(&valid_line()).unwrap();
        let script = bootstrap_script(&token).unwrap();
        assert!(script.contains("__AYLACHI_CONNECTION__"));
        assert!(script.contains("http://127.0.0.1:46231"));
        assert!(script.contains(&format!("bearer: \"{}\"", "a".repeat(64))));
        assert!(script.contains("writable: false"));
        assert!(script.contains("configurable: true"));
    }

    #[test]
    fn rejects_invalid_character() {
        let mut line = valid_line();
        line[17] = b'G';
        assert!(parse_bootstrap(&line).is_err());
    }

    #[test]
    fn rejects_wrong_length_crlf_and_trailing_bytes() {
        let line = valid_line();
        assert!(parse_bootstrap(&line[..64]).is_err());

        let mut crlf = line.clone();
        crlf.insert(64, b'\r');
        assert!(parse_bootstrap(&crlf).is_err());

        let mut trailing = line;
        trailing.push(b'x');
        assert!(parse_bootstrap(&trailing).is_err());
        assert!(read_bootstrap(&mut Cursor::new(trailing)).is_err());
    }

    #[test]
    fn does_not_read_without_bootstrap_mode() {
        assert!(
            bootstrap_for_mode(StartupMode::Normal, || panic!("unexpected stdin read"))
                .unwrap()
                .is_none()
        );
        assert!(
            bootstrap_for_mode(StartupMode::OriginProbe, || panic!("unexpected stdin read"))
                .unwrap()
                .is_none()
        );
    }

    #[test]
    fn rejects_mutually_enabled_modes() {
        assert!(select_mode(true, true).is_err());
        assert_eq!(select_mode(false, false).unwrap(), StartupMode::Normal);
    }

    #[test]
    fn allows_only_sandboxed_srcdoc_in_addition_to_the_trusted_app() {
        assert!(is_allowed_navigation(
            &tauri::Url::parse("about:srcdoc").unwrap()
        ));
        assert!(is_allowed_navigation(
            &tauri::Url::parse("tauri://localhost/").unwrap()
        ));
        for url in [
            "about:blank",
            "data:text/html,hello",
            "https://example.com/",
        ] {
            assert!(!is_allowed_navigation(&tauri::Url::parse(url).unwrap()));
        }
    }

    #[test]
    fn accepts_only_the_trusted_app_url_without_userinfo_or_port() {
        assert!(is_trusted_app_url(
            &tauri::Url::parse("tauri://localhost/").unwrap()
        ));
        for url in [
            "https://localhost/",
            "tauri://other/",
            "tauri://localhost:1234/",
            "tauri://user@localhost/",
        ] {
            assert!(!is_trusted_app_url(&tauri::Url::parse(url).unwrap()));
        }
    }
}
