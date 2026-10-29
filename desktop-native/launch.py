#!/usr/bin/env python3
"""Launch the real development desktop; its server is started separately on Ayla."""
import argparse
import hashlib
import os
from pathlib import Path
import re
import selectors
import shlex
import signal
import socket
import stat
import subprocess
import tempfile
import time
from contextlib import ExitStack

PORT = 46231
SSH = ['/usr/bin/ssh', '-T', '-o', 'BatchMode=yes', '-o', 'ConnectTimeout=5',
       '-o', 'ControlMaster=no', '-o', 'ControlPath=none',
       '-o', 'ServerAliveInterval=5', '-o', 'ServerAliveCountMax=2']
REMOTE_ENTRY = '/srv/aylachi/coding-repos/aylachi/runtime/server.mjs'
NODE = os.environ.get('AYLACHI_REMOTE_NODE', '/opt/node-v22.23.2/bin/node')


def verify_binary(path, expected):
    if not re.fullmatch('[a-f0-9]{64}', expected):
        raise RuntimeError('BINARY_HASH_REQUIRED')
    info = path.lstat()
    if not stat.S_ISREG(info.st_mode) or info.st_uid != os.getuid() or info.st_mode & 0o022:
        raise RuntimeError('UNTRUSTED_BINARY')
    if hashlib.sha256(path.read_bytes()).hexdigest() != expected:
        raise RuntimeError('BINARY_HASH_MISMATCH')


def stop(child):
    if child is None or child.poll() is not None:
        return
    child.terminate()
    try:
        child.wait(timeout=3)
    except subprocess.TimeoutExpired:
        child.kill()
        child.wait(timeout=3)


def read_bootstrap(child, timeout=10):
    token = bytearray()
    deadline = time.monotonic() + timeout
    try:
        with selectors.DefaultSelector() as selector:
            selector.register(child.stdout, selectors.EVENT_READ)
            while True:
                left = deadline - time.monotonic()
                if left <= 0 or not selector.select(left):
                    raise RuntimeError('BOOTSTRAP_TIMEOUT')
                part = os.read(child.stdout.fileno(), 66 - len(token))
                if not part:
                    break
                token.extend(part)
                if len(token) > 65:
                    raise RuntimeError('BOOTSTRAP_INVALID')
        if child.wait(timeout=max(0.01, deadline - time.monotonic())) != 0:
            raise RuntimeError('BOOTSTRAP_FAILED')
        if not re.fullmatch(b'[a-f0-9]{64}\n', token):
            raise RuntimeError('BOOTSTRAP_INVALID')
        return token
    except BaseException:
        token[:] = b'\0' * len(token)
        raise


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--state-root', required=True, help='Dedicated server state root on Ayla')
    parser.add_argument('--binary-sha256', required=True, help='Expected SHA-256 from the verified native build')
    parser.add_argument('--binary', type=Path, default=Path(__file__).parent / 'target/aarch64-apple-darwin/debug/aylachi-desktop')
    parser.add_argument('--server-entry', default=REMOTE_ENTRY, help='Absolute runtime/server.mjs on Ayla; use an isolated preview worktree when needed')
    parser.add_argument('--clients', type=int, default=1, help='Number of isolated native clients sharing one Hub (1-4)')
    args = parser.parse_args(argv)
    if not args.state_root.startswith('/') or '\0' in args.state_root:
        raise RuntimeError('INVALID_STATE_ROOT')
    if not args.server_entry.startswith('/') or '\0' in args.server_entry:
        raise RuntimeError('INVALID_SERVER_ENTRY')
    if not 1 <= args.clients <= 4:
        raise RuntimeError('INVALID_CLIENT_COUNT')
    args.binary = Path(os.path.abspath(args.binary))
    verify_binary(args.binary, args.binary_sha256)
    # Refuse an existing listener rather than accidentally using another service.
    with socket.socket() as check:
        check.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
        check.bind(('127.0.0.1', PORT))
    forward = bootstrap = None
    natives = []
    token = bytearray()
    try:
        forward = subprocess.Popen(SSH + ['-o', 'ExitOnForwardFailure=yes', '-N',
            '-L', f'127.0.0.1:{PORT}:127.0.0.1:{PORT}', 'ayla'],
            stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        deadline = time.monotonic() + 10
        while True:
            if forward.poll() is not None or time.monotonic() >= deadline:
                raise RuntimeError('FORWARD_FAILED')
            try:
                with socket.create_connection(('127.0.0.1', PORT), timeout=0.1):
                    break
            except OSError:
                time.sleep(0.05)
        remote = shlex.join([NODE, args.server_entry, '--bootstrap', '--state-root', args.state_root])
        # sshd-owned stdout fails the runtime private-output check. A private
        # owned FIFO forwards the same single token without a persistent file.
        command = ('d=$(mktemp -d) || exit; trap \'rm -f "$d/out"; rmdir "$d"\' EXIT; '
                   'mkfifo -m 600 "$d/out" || exit; cat "$d/out" & reader=$!; '
                   f'{remote} > "$d/out"; rc=$?; wait "$reader"; exit "$rc"')
        bootstrap = subprocess.Popen(SSH + ['ayla', command], stdin=subprocess.DEVNULL,
            stdout=subprocess.PIPE, stderr=subprocess.DEVNULL)
        token = read_bootstrap(bootstrap)
        # Profiles/cache only; authoritative chats and documents stay on Ayla.
        with ExitStack() as profiles:
            homes = [profiles.enter_context(tempfile.TemporaryDirectory(prefix='aylachi-desktop-home-'))
                     for _ in range(args.clients)]
            try:
                try:
                    for home in homes:
                        env = {'HOME': home, 'PATH': '/usr/bin:/bin:/usr/sbin:/sbin', 'AYLACHI_BOOTSTRAP_STDIN': '1'}
                        native = subprocess.Popen([str(args.binary)], stdin=subprocess.PIPE,
                            stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, env=env)
                        natives.append(native)
                        native.stdin.write(token)
                        native.stdin.close()  # Rust deliberately waits for EOF after the 65-byte record.
                finally:
                    token[:] = b'\0' * len(token)  # Best effort, not a secure-memory guarantee.
                pids = ', '.join(str(native.pid) for native in natives)
                print(f'Aylachi desktop started (pids {pids}); server remains independent.', flush=True)
                while any(native.poll() is None for native in natives):
                    if forward.poll() is not None:
                        raise RuntimeError('FORWARD_EXITED')
                    time.sleep(0.2)
                return next((native.returncode for native in natives if native.returncode), 0)
            finally:
                for native in reversed(natives):
                    stop(native)  # Reap before removing the owned temporary WebView profiles.
    finally:
        token[:] = b'\0' * len(token)
        try:
            for native in reversed(natives):
                stop(native)
        finally:
            try:
                stop(bootstrap)
            finally:
                stop(forward)
        # No remote stop command: closing this client must not stop server-owned work.


def interrupted(*_):
    raise KeyboardInterrupt()


if __name__ == '__main__':
    signal.signal(signal.SIGTERM, interrupted)
    try:
        raise SystemExit(main())
    except KeyboardInterrupt:
        raise SystemExit(130)
    except Exception:
        print('Aylachi desktop launch failed; check the server and verified build.', file=__import__('sys').stderr)
        raise SystemExit(1)
