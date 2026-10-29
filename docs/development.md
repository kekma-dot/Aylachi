# Development and verification

## Supported runtime

Use Node.js >=22.19 <23. `scripts/run-tests.mjs` fails immediately on another major version and on Node 22 older than 22.19. This is intentional: a failed run on an unsupported runtime is not evidence about the supported contract.

```sh
npm run bootstrap
npm test
```

Useful narrow commands:

```sh
node --test --test-timeout=30000 runtime/server.test.mjs
node --test --test-timeout=30000 integration/browser-themes.test.mjs
node --test --test-timeout=30000 desktop-ui/usability.test.mjs
```

Some fixture subprocesses require `AYLACHI_SDK_ROOT` to point at the trusted installed Pi SDK root. Set it to the same dependency used by the checkout; do not replace it with an unrelated global installation.

## Interactive browser fixtures

These fixtures exercise real React DOM input/click behavior without production accounts or data:

```sh
node desktop-ui/canvas-layout.test.mjs --browser
node desktop-ui/usability-browser.test.mjs --browser
```

The first covers Canvas layout, draft/receipt behavior and pointer targets. The second covers two-finger Canvas panning, theme draft preservation, preset create/re-activation, rollback defaults, Browser new-tab input, Theme-node removal and Artifact Preview/Source behavior. Their normal Node test mode checks fixture availability; the interactive run and its recorded results are separate evidence.

## Builds

```sh
npm run build --prefix desktop-ui
npm run build:ui --prefix desktop-native
npm run tauri --prefix desktop-native -- build --debug
```

For native changes, also run the Rust and launcher tests owned by `desktop-native/`. A web fixture is not a native WKWebView check.

The launcher uses canonical `/srv/aylachi/coding-repos/aylachi/runtime/server.mjs` by default. For an isolated preview, pass `--server-entry /srv/aylachi/coding-repos/<worktree>/runtime/server.mjs` explicitly; do not replace canonical code to make a preview work.

## Change protocol

1. Inspect status/diff and identify the owning contract.
2. Reproduce a defect or record the current UX scenario.
3. Add the smallest regression that fails for that reason.
4. Make the minimal compatible change; do not weaken guards to obtain green tests.
5. Run syntax/targeted tests, the affected integration/restart tests and `npm test` on Node 22.
6. Run production UI/native builds for user-facing changes.
7. Compare interactive scenarios before/after where practical.
8. Obtain independent review for non-trivial logic or UX changes.
9. Check `git diff --check`, generated files, secrets and documentation.

Record blocked or unrun checks explicitly. A green subset is not a full-suite or production claim.

## Verification evidence

Keep verification artifacts and runtime data out of source control. Record the exact command, result and limitations for non-trivial checks. Never commit credentials, session data, cookies, private notes or real workspace content.

Commit, push, merge and release are separate operations, not implicit steps of a successful test run.
