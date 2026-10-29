#!/usr/bin/env python3
"""Bounded denial/positive checks in the already-owned Aylachi bwrap fixture."""
import hashlib
import json
import os
from pathlib import Path
import re
import shutil
import subprocess

BWRAP = Path('/usr/bin/bwrap')
EXPECTED_BWRAP_SHA256 = 'e318903862396f96de3df57264e0158682b952fd3fb53ac23d876413e7b30f71'
FIXTURE = Path('/srv/aylachi/security-labs/aylachi/v1-fixture-20261021')
WORKSPACE = FIXTURE / 'workspace'
FAKEHOST = FIXTURE / 'fakehost'
CANARY = FAKEHOST / 'canary.txt'
PROBE = FIXTURE / 'fixture-negative-probe'
C_SOURCE = Path('/srv/aylachi/coding-repos/aylachi/security/fixture-negative-probe.c')
RUNNER = Path('/srv/aylachi/coding-repos/aylachi/security/fixture-negative-probe.py')
EVIDENCE = Path('/srv/aylachi/assessment-evidence/aylachi/v1-orch-20261021/L01/security-negative-plan.json')
LIBC = Path('/lib/x86_64-linux-gnu/libc.so.6')
LOADER = Path('/lib64/ld-linux-x86-64.so.2')
TRUE = Path('/usr/bin/true')
CAT = Path('/usr/bin/cat')
CANARY_BYTES = b'AYLACHI_SYNTHETIC_CANARY_ONLY\n'


def need(ok, why):
    if not ok:
        raise RuntimeError(why)


def sha(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def run(argv, timeout=10, env=None):
    return subprocess.run(argv, stdin=subprocess.DEVNULL, stdout=subprocess.PIPE,
                          stderr=subprocess.PIPE, text=True, timeout=timeout,
                          check=False, close_fds=True,
                          env={'PATH': '/usr/bin:/bin', 'LC_ALL': 'C'} if env is None else env)


def mounts_argv(command):
    argv = [str(BWRAP), '--unshare-user', '--unshare-pid', '--unshare-net',
            '--unshare-ipc', '--unshare-uts', '--die-with-parent', '--new-session',
            '--cap-drop', 'ALL', '--clearenv']
    for path in ('/bin', '/usr', '/usr/bin', '/lib', '/lib64',
                 '/lib/x86_64-linux-gnu', '/proc', '/dev', '/tmp', '/run', '/workspace'):
        argv += ['--dir', path]
    argv += ['--ro-bind', str(TRUE), '/bin/true',
             '--ro-bind', str(CAT), '/usr/bin/cat',
             '--ro-bind', str(PROBE), '/probe',
             '--ro-bind', str(LIBC), str(LIBC),
             '--ro-bind', str(LOADER), str(LOADER),
             '--proc', '/proc', '--dev', '/dev', '--tmpfs', '/tmp', '--tmpfs', '/run',
             '--bind', str(WORKSPACE), '/workspace', '--remount-ro', '/',
             '--chdir', '/workspace', '--', *command]
    return argv


def parse_mountinfo(text):
    out = []
    for line in text.splitlines():
        left, right = line.split(' - ', 1)
        fields, tail = left.split(), right.split()
        out.append({'mountpoint': fields[4], 'options': fields[5], 'fstype': tail[0]})
    return sorted(out, key=lambda x: x['mountpoint'])


def main():
    need(FIXTURE.is_dir() and WORKSPACE.is_dir(), 'expected owned fixture/workspace absent; refusing restart')
    expected_links = {'abs-canary-link', 'rel-canary-link'}
    need({p.name for p in WORKSPACE.iterdir()} <= expected_links, 'unexpected workspace content; preserve and stop')
    need(not PROBE.exists(), 'compiled probe already exists; preserve and stop')
    if FAKEHOST.exists():
        need(FAKEHOST.is_dir() and CANARY.is_file() and CANARY.read_bytes() == CANARY_BYTES,
             'existing fakehost content is not this runner-owned canary; preserve and stop')
    need(sha(BWRAP) == EXPECTED_BWRAP_SHA256, 'bwrap hash changed; fail closed')
    for path in (LIBC, LOADER, TRUE, CAT, C_SOURCE, RUNNER):
        need(path.is_file(), f'required file unavailable: {path}')
    need(shutil.which('/usr/bin/cc') == '/usr/bin/cc', 'existing cc unavailable')

    if not FAKEHOST.exists():
        FAKEHOST.mkdir()
        CANARY.write_bytes(CANARY_BYTES)
    before = sha(CANARY)
    abs_link = WORKSPACE / 'abs-canary-link'
    rel_link = WORKSPACE / 'rel-canary-link'
    for link, target in ((abs_link, str(CANARY)), (rel_link, '../fakehost/canary.txt')):
        if link.is_symlink():
            need(os.readlink(link) == target, f'unexpected existing link target: {link}')
        elif not link.exists():
            link.symlink_to(target)
        else:
            need(False, f'unexpected existing link path: {link}')

    compile_argv = ['/usr/bin/cc', '-std=c11', '-O2', '-Wall', '-Wextra', '-Werror',
                    '-Wl,--build-id=none', '-o', str(PROBE), str(C_SOURCE)]
    compile_result = run(compile_argv, timeout=20, env={'PATH': '/usr/bin:/bin', 'LC_ALL': 'C'})
    need(compile_result.returncode == 0, f'cc failed: {compile_result.stderr[:1000]}')
    deps = run(['/usr/bin/ldd', str(PROBE)])
    need(deps.returncode == 0, f'ldd failed: {deps.stderr[:500]}')
    resolved = sorted(set(re.findall(r'=>\s+(/\S+)|^\s*(/\S+)\s+\(', deps.stdout, re.M)))
    dep_paths = sorted({a or b for a, b in resolved})
    need(set(dep_paths) <= {str(LIBC), str(LOADER)} and str(LIBC) in dep_paths,
         f'unapproved dynamic dependencies; no broad runtime mounts: {dep_paths}')

    evidence = {
        'status': 'running', 'fixture': str(FIXTURE), 'scope': 'synthetic shared-kernel bwrap only; not VM/arbitrary-code claim',
        'bwrap': {'path': str(BWRAP), 'version': run([str(BWRAP), '--version']).stdout.strip(), 'sha256': sha(BWRAP),
                  'package': run(['/usr/bin/dpkg-query', '-W', 'bubblewrap']).stdout.strip()},
        'compiler': {'path': '/usr/bin/cc', 'version': run(['/usr/bin/cc', '--version']).stdout.splitlines()[0],
                     'source_sha256': sha(C_SOURCE), 'binary_sha256': sha(PROBE), 'ldd': deps.stdout, 'resolved_dependencies': dep_paths},
        'runner_sha256': sha(RUNNER),
        'fake_canary': {'path_host_only': str(CANARY), 'sha256_before': before, 'sha256_after': None,
                        'not_mounted': True, 'content': CANARY_BYTES.decode().strip()},
        'network': 'NOT_TESTED; not needed for this bounded check',
        'commands': [],
    }

    # Independent reporter: validate every observed exit and the host-owned canary/workspace result.
    tests = [
        ('positive_workspace_tmp_and_root_denial', ['/probe'], True),
        ('cat_unmounted_fakehost_absolute', ['/usr/bin/cat', '/fakehost/canary.txt'], False),
        ('cat_unmounted_host_absolute', ['/usr/bin/cat', str(CANARY)], False),
        ('cat_absolute_symlink', ['/usr/bin/cat', '/workspace/abs-canary-link'], False),
        ('cat_relative_escape_symlink', ['/usr/bin/cat', '/workspace/rel-canary-link'], False),
        ('mount_inventory', ['/usr/bin/cat', '/proc/self/mountinfo'], True),
    ]
    try:
        for name, command, expected_ok in tests:
            argv = mounts_argv(command)
            result = run(argv)
            item = {'name': name, 'argv': argv, 'exit': result.returncode,
                    'stdout': result.stdout[:4000], 'stderr': result.stderr[:1500]}
            if name == 'mount_inventory' and result.returncode == 0:
                observed = parse_mountinfo(result.stdout)
                root = next((x for x in observed if x['mountpoint'] == '/'), None)
                workspace = next((x for x in observed if x['mountpoint'] == '/workspace'), None)
                tmp = next((x for x in observed if x['mountpoint'] == '/tmp'), None)
                item['mounts_observed'] = observed
                item['mount_digest_sha256'] = hashlib.sha256(json.dumps(observed, sort_keys=True, separators=(',', ':')).encode()).hexdigest()
                item['reporter_assertions'] = {'root_read_only': bool(root and 'ro' in root['options'].split(',')),
                                               'workspace_read_write': bool(workspace and 'rw' in workspace['options'].split(',')),
                                               'tmp_private_rw': bool(tmp and tmp['fstype'] == 'tmpfs' and 'rw' in tmp['options'].split(','))}
                need(all(item['reporter_assertions'].values()), 'mount reporter rejected root/workspace/tmp options')
            evidence['commands'].append(item)
            need((result.returncode == 0) == expected_ok, f'{name} unexpected exit {result.returncode}')
            if name.startswith('cat_'):
                need(result.returncode != 0 and not result.stdout, f'{name} unexpectedly read canary')
        need((WORKSPACE / 'positive.txt').read_bytes() == b'workspace-ok\n', 'workspace positive write/read postcondition failed')
        need(sha(CANARY) == before, 'outside-workspace fake canary changed')
        evidence['fake_canary']['sha256_after'] = sha(CANARY)
        evidence['reporter_assertions'] = {'canary_unchanged': sha(CANARY) == before,
                                          'workspace_write_read_verified': (WORKSPACE / 'positive.txt').read_bytes() == b'workspace-ok\n',
                                          'all_cat_denials_nonzero_empty_stdout': all(x['exit'] != 0 and not x['stdout'] for x in evidence['commands'] if x['name'].startswith('cat_')),
                                          'root_read_only_workspace_tmp_writable': all(x.get('reporter_assertions', {}).get(k) for x in evidence['commands'] if x['name'] == 'mount_inventory' for k in ('root_read_only', 'workspace_read_write', 'tmp_private_rw'))}
        need(all(evidence['reporter_assertions'].values()), 'independent reporter assertion failed')
        evidence['status'] = 'bounded synthetic checks passed; stop for L08/parent review'
    except Exception as exc:
        evidence['status'] = 'blocked-or-failed; preserve fixture for review'
        evidence['error'] = f'{type(exc).__name__}: {exc}'
        EVIDENCE.parent.mkdir(parents=True, exist_ok=True)
        EVIDENCE.write_text(json.dumps(evidence, indent=2) + '\n')
        raise
    EVIDENCE.parent.mkdir(parents=True, exist_ok=True)
    EVIDENCE.write_text(json.dumps(evidence, indent=2) + '\n')
    print(json.dumps({'status': evidence['status'], 'evidence': str(EVIDENCE), 'fixture': str(FIXTURE)}, indent=2))


if __name__ == '__main__':
    main()
