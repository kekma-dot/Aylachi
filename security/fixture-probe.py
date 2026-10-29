#!/usr/bin/env python3
"""One-shot benign bwrap qualification for the owned Aylachi fixture."""
import hashlib
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys

BWRAP = Path('/usr/bin/bwrap')
EXPECTED_BWRAP_SHA256 = 'e318903862396f96de3df57264e0158682b952fd3fb53ac23d876413e7b30f71'
FIXTURE = Path('/srv/aylachi/security-labs/aylachi/v1-fixture-20261021')
WORKSPACE = FIXTURE / 'workspace'
EVIDENCE = Path('/srv/aylachi/assessment-evidence/aylachi/v1-orch-20261021/L01/security-plan.json')
LIBC = Path('/lib/x86_64-linux-gnu/libc.so.6')
LOADER = Path('/lib64/ld-linux-x86-64.so.2')
TRUE = Path('/usr/bin/true')
CAT = Path('/usr/bin/cat')


def require(condition, message):
    if not condition:
        raise RuntimeError(message)


def base_argv(workspace):
    args = [str(BWRAP), '--unshare-user', '--unshare-pid', '--unshare-net',
            '--unshare-ipc', '--unshare-uts', '--die-with-parent', '--new-session',
            '--cap-drop', 'ALL', '--clearenv']
    for path in ('/bin', '/usr', '/usr/bin', '/lib', '/lib64',
                 '/lib/x86_64-linux-gnu', '/proc', '/dev', '/tmp', '/run', '/workspace'):
        args += ['--dir', path]
    args += ['--ro-bind', str(TRUE), '/bin/true',
             '--ro-bind', str(CAT), '/usr/bin/cat',
             '--ro-bind', str(LIBC), str(LIBC),
             '--ro-bind', str(LOADER), str(LOADER),
             '--proc', '/proc', '--dev', '/dev', '--tmpfs', '/tmp', '--tmpfs', '/run',
             '--bind', str(workspace), '/workspace', '--chdir', '/workspace', '--']
    return args


def run(argv):
    return subprocess.run(argv, stdin=subprocess.DEVNULL, stdout=subprocess.PIPE,
                          stderr=subprocess.PIPE, text=True, timeout=10, check=False,
                          close_fds=True, env={})


def main():
    require(not FIXTURE.exists(), f'fixture target already exists; refusing overwrite: {FIXTURE}')
    require(BWRAP.is_file() and shutil.which(str(BWRAP)) == str(BWRAP), 'bwrap unavailable')
    digest = hashlib.sha256(BWRAP.read_bytes()).hexdigest()
    require(digest == EXPECTED_BWRAP_SHA256, 'bwrap hash differs from reviewed baseline; fail closed')
    for path in (LIBC, LOADER, TRUE, CAT):
        require(path.is_file(), f'required runtime file unavailable: {path}')
    WORKSPACE.mkdir(parents=True, exist_ok=False)
    evidence = {
        'status': 'pending',
        'fixture': str(FIXTURE),
        'fixture_precondition': 'absent before runner; created by this run',
        'bwrap': {'path': str(BWRAP), 'version': subprocess.run([str(BWRAP), '--version'], capture_output=True, text=True, timeout=5, check=True).stdout.strip(), 'sha256': digest, 'package': subprocess.run(['dpkg-query', '-W', 'bubblewrap'], capture_output=True, text=True, timeout=5, check=True).stdout.strip()},
        'policy': {'shared_kernel': True, 'vm_claim': False, 'arbitrary_plugins': False, 'no_network': True, 'user_pid_ipc_uts_namespaces': True, 'cap_drop_all': True, 'clear_environment': True, 'host_root_home_ssh_pi_baza_source_reporter_run_socket_binds': False},
        'mounts': [
            {'source': str(TRUE), 'target': '/bin/true', 'mode': 'ro'},
            {'source': str(CAT), 'target': '/usr/bin/cat', 'mode': 'ro'},
            {'source': str(LIBC), 'target': str(LIBC), 'mode': 'ro'},
            {'source': str(LOADER), 'target': str(LOADER), 'mode': 'ro'},
            {'source': 'new procfs', 'target': '/proc', 'mode': 'private'},
            {'source': 'new devtmpfs', 'target': '/dev', 'mode': 'private'},
            {'source': 'new tmpfs', 'target': '/tmp', 'mode': 'private'},
            {'source': 'new tmpfs', 'target': '/run', 'mode': 'private'},
            {'source': str(WORKSPACE), 'target': '/workspace', 'mode': 'rw synthetic fixture only'},
        ],
    }
    commands = [
        ('positive_true', base_argv(WORKSPACE) + ['/bin/true']),
        ('mount_inventory', base_argv(WORKSPACE) + ['/usr/bin/cat', '/proc/self/mountinfo']),
    ]
    evidence['commands'] = []
    try:
        for name, argv in commands:
            result = run(argv)
            item = {'name': name, 'argv': argv, 'exit': result.returncode, 'stderr': result.stderr[:2000]}
            if name == 'mount_inventory':
                parsed = []
                for line in result.stdout.splitlines():
                    left, right = line.split(' - ', 1)
                    fields, tail = left.split(), right.split()
                    parsed.append({'mountpoint': fields[4], 'mount_options': fields[5], 'fstype': tail[0]})
                item['mounts_observed'] = parsed
            evidence['commands'].append(item)
            require(result.returncode == 0, f'{name} failed closed with exit {result.returncode}: {result.stderr[:500]}')
        evidence['status'] = 'positive-control-passed; awaiting review before negative fixtures'
    except Exception as exc:
        evidence['status'] = 'blocked-fail-closed'
        evidence['error'] = f'{type(exc).__name__}: {exc}'
        EVIDENCE.parent.mkdir(parents=True, exist_ok=True)
        EVIDENCE.write_text(json.dumps(evidence, indent=2) + '\n')
        raise
    EVIDENCE.parent.mkdir(parents=True, exist_ok=True)
    EVIDENCE.write_text(json.dumps(evidence, indent=2) + '\n')
    print(json.dumps({'status': evidence['status'], 'fixture': str(FIXTURE), 'evidence': str(EVIDENCE)}, indent=2))


if __name__ == '__main__':
    main()
