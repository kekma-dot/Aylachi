import hashlib
import importlib.util
import io
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch, MagicMock

spec = importlib.util.spec_from_file_location('aylachi_launch', Path(__file__).with_name('launch.py'))
launch = importlib.util.module_from_spec(spec)
spec.loader.exec_module(launch)
PUBLIC_LINE = b'a' * 64 + b'\n'


class Child:
    def __init__(self, running=True, stdin=None):
        self.returncode = None if running else 0
        self.stdin = stdin
        self.pid = 100
        self.actions = []
        self.home = None

    def poll(self):
        return self.returncode

    def terminate(self):
        if self.home:
            assert Path(self.home).is_dir(), 'profile removed before native termination'
        self.actions.append('terminate')
        self.returncode = -15

    def kill(self):
        self.actions.append('kill')
        self.returncode = -9

    def wait(self, timeout=None):
        self.actions.append('wait')
        return self.returncode


class Input:
    def __init__(self, fail=False):
        self.fail = fail
        self.value = b''
        self.closed = False

    def write(self, value):
        if self.fail:
            raise BrokenPipeError()
        self.value += value

    def close(self):
        self.closed = True


class LaunchTests(unittest.TestCase):
    def test_binary_pin_rejects_mismatch_symlink_and_writable_file(self):
        with tempfile.TemporaryDirectory() as root:
            binary = Path(root) / 'binary'
            binary.write_bytes(b'not executed')
            binary.chmod(0o700)
            good = hashlib.sha256(binary.read_bytes()).hexdigest()
            launch.verify_binary(binary, good)
            with self.assertRaises(RuntimeError):
                launch.verify_binary(binary, '0' * 64)
            link = Path(root) / 'link'
            link.symlink_to(binary)
            with self.assertRaises(RuntimeError):
                launch.verify_binary(link, good)
            binary.chmod(0o722)
            with self.assertRaises(RuntimeError):
                launch.verify_binary(binary, good)

    def child(self, data, extra=''):
        return subprocess.Popen([sys.executable, '-c', f'import os,time; os.write(1,{data!r}); {extra}'],
                                stdout=subprocess.PIPE, stderr=subprocess.DEVNULL)

    def test_exact_private_record_requires_eof_and_zero_exit(self):
        child = self.child(PUBLIC_LINE)
        try:
            self.assertEqual(launch.read_bootstrap(child), PUBLIC_LINE)
        finally:
            launch.stop(child)
            child.stdout.close()
        for value in [PUBLIC_LINE[:-1], PUBLIC_LINE[:-1] + b'\r\n', PUBLIC_LINE + b'x', b'A' * 64 + b'\n']:
            child = self.child(value)
            try:
                with self.assertRaises(RuntimeError):
                    launch.read_bootstrap(child)
            finally:
                launch.stop(child)
                child.stdout.close()
        child = self.child(PUBLIC_LINE, 'raise SystemExit(3)')
        try:
            with self.assertRaises(RuntimeError):
                launch.read_bootstrap(child)
        finally:
            launch.stop(child)
            child.stdout.close()

    def test_eof_timeout_is_bounded(self):
        child = self.child(PUBLIC_LINE, 'time.sleep(3)')
        try:
            with self.assertRaisesRegex(RuntimeError, 'BOOTSTRAP_TIMEOUT'):
                launch.read_bootstrap(child, timeout=0.15)
        finally:
            launch.stop(child)
            child.stdout.close()

    def test_stop_escalates_only_owned_child(self):
        child = Child()
        original = child.wait
        count = 0
        def wait(timeout=None):
            nonlocal count
            count += 1
            if count == 1:
                raise subprocess.TimeoutExpired('owned-child', timeout)
            return original(timeout)
        child.wait = wait
        launch.stop(child)
        self.assertEqual(child.actions, ['terminate', 'kill', 'wait'])
        launch.stop(child)
        self.assertEqual(child.actions, ['terminate', 'kill', 'wait'])

    def run_pipeline(self, write_fails=False, server_entry=None, clients=1):
        with tempfile.TemporaryDirectory() as root:
            binary = Path(root) / 'binary'
            binary.write_bytes(b'fixture never executed')
            binary.chmod(0o700)
            pin = hashlib.sha256(binary.read_bytes()).hexdigest()
            streams = [Input(fail=write_fails) for _ in range(clients)]
            forward, bootstrap = Child(), Child(running=False)
            natives = [Child(running=write_fails, stdin=stream) for stream in streams]
            children = [forward, bootstrap, *natives]
            calls = []
            def spawn(args, **kwargs):
                calls.append((args, kwargs))
                child = children[len(calls) - 1]
                if len(calls) >= 3:
                    natives[len(calls) - 3].home = kwargs['env']['HOME']
                return child
            token = bytearray(PUBLIC_LINE)
            with patch.object(launch.subprocess, 'Popen', side_effect=spawn), \
                 patch.object(launch.socket, 'socket', return_value=MagicMock()), \
                 patch.object(launch.socket, 'create_connection', return_value=MagicMock()), \
                 patch.object(launch, 'read_bootstrap', return_value=token), \
                 patch('sys.stdout', new_callable=io.StringIO):
                args = ['--state-root', '/srv/aylachi/private state;not-a-command', '--binary', str(binary), '--binary-sha256', pin]
                if server_entry:
                    args.extend(['--server-entry', server_entry])
                if clients != 1:
                    args.extend(['--clients', str(clients)])
                if write_fails:
                    with self.assertRaises(BrokenPipeError):
                        launch.main(args)
                else:
                    self.assertEqual(launch.main(args), 0)
            self.assertEqual(len(calls), 2 + clients)
            self.assertIn('-N', calls[0][0])
            self.assertIn("'/srv/aylachi/private state;not-a-command'", calls[1][0][-1])
            self.assertIn(server_entry or launch.REMOTE_ENTRY, calls[1][0][-1])
            self.assertIn('mkfifo -m 600', calls[1][0][-1])
            self.assertNotIn('StrictHostKeyChecking=no', str(calls))
            expected_env = {'HOME', 'PATH', 'AYLACHI_BOOTSTRAP_STDIN'}
            for index, native in enumerate(natives):
                self.assertEqual(calls[index + 2][0], [str(binary)])
                self.assertEqual(set(calls[index + 2][1]['env']), expected_env)
                self.assertFalse(Path(native.home).exists())
            self.assertEqual(len({native.home for native in natives}), clients)
            self.assertEqual(token, b'\0' * 65)
            self.assertIn('terminate', forward.actions)
            self.assertNotIn('kill', forward.actions)
            if not write_fails:
                for stream in streams:
                    self.assertEqual(stream.value, PUBLIC_LINE)
                    self.assertTrue(stream.closed)
            else:
                for native in natives:
                    self.assertIn('terminate', native.actions)
            # No extra SSH call may stop the remote server after desktop closure.
            self.assertFalse(any('kill ' in ' '.join(args) for args, _ in calls))

    def test_real_launcher_control_flow_private_pipe_and_gui_independence(self):
        self.run_pipeline()

    def test_two_native_clients_share_one_hub_with_isolated_profiles(self):
        self.run_pipeline(clients=2)

    def test_invalid_client_count_prevents_network_or_native_launch(self):
        with tempfile.TemporaryDirectory() as root:
            binary = Path(root) / 'binary'
            binary.write_bytes(b'fixture')
            binary.chmod(0o700)
            pin = hashlib.sha256(binary.read_bytes()).hexdigest()
            with patch.object(launch.subprocess, 'Popen') as spawn:
                for count in ['0', '5']:
                    with self.assertRaisesRegex(RuntimeError, 'INVALID_CLIENT_COUNT'):
                        launch.main(['--state-root', '/srv/aylachi/owned', '--binary', str(binary),
                                     '--binary-sha256', pin, '--clients', count])
                spawn.assert_not_called()

    def test_native_stops_before_owned_profile_cleanup_on_pipe_failure(self):
        self.run_pipeline(write_fails=True)

    def test_isolated_server_entry_is_explicit_and_absolute(self):
        self.run_pipeline(server_entry='/srv/aylachi/coding-repos/aylachi-preview/runtime/server.mjs')
        with tempfile.TemporaryDirectory() as root:
            binary = Path(root) / 'binary'
            binary.write_bytes(b'fixture')
            binary.chmod(0o700)
            pin = hashlib.sha256(binary.read_bytes()).hexdigest()
            with patch.object(launch.subprocess, 'Popen') as spawn:
                for invalid in ['relative/server.mjs', '/tmp/bad\0entry']:
                    with self.assertRaises(RuntimeError):
                        launch.main(['--state-root', '/srv/aylachi/owned', '--binary', str(binary), '--binary-sha256', pin,
                                     '--server-entry', invalid])
                spawn.assert_not_called()

    def test_bad_pin_prevents_network_or_native_launch(self):
        with tempfile.TemporaryDirectory() as root:
            binary = Path(root) / 'binary'
            binary.write_bytes(b'fixture')
            binary.chmod(0o700)
            with patch.object(launch.subprocess, 'Popen') as spawn:
                with self.assertRaisesRegex(RuntimeError, 'BINARY_HASH_MISMATCH'):
                    launch.main(['--state-root', '/srv/aylachi/owned', '--binary', str(binary), '--binary-sha256', '0' * 64])
                spawn.assert_not_called()


if __name__ == '__main__':
    unittest.main()
