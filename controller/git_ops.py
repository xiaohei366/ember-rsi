"""Read Git objects and rebuild commits without checking out contribution code."""

import os
from pathlib import Path
import re
import subprocess

from api import BridgeError


STATE_REF = 'refs/heads/bridge-state'
MASTER_BRANCH = 'master'
MASTER_REF = 'refs/heads/' + MASTER_BRANCH


def sha(value):
    if not isinstance(value, str) or not re.fullmatch(r'[0-9a-f]{40}', value):
        raise BridgeError('Invalid SHA-1 object ID')
    return value


def repository(value):
    if not isinstance(value, str) or not re.fullmatch(r'[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+', value):
        raise BridgeError('Invalid owner/repository')
    if any(part in ('.', '..') for part in value.split('/')):
        raise BridgeError('Invalid owner/repository')
    return value


class Remote:
    def __init__(self, provider, repo, token, username):
        self.provider, self.repo = provider, repository(repo)
        self.token, self.username = token, username
        self.url = f'https://{provider}.com/{self.repo}.git'


class Git:
    def __init__(self, directory, lfs=False):
        self.directory, self.lfs = Path(directory), lfs
        self.directory.mkdir(parents=True, exist_ok=True)
        self.askpass = self.directory / 'askpass'
        self.askpass.write_text('#!/bin/sh\ncase "$1" in\n'
                                '*Username*) printf "%s\\n" "$BRIDGE_GIT_USERNAME" ;;\n'
                                '*Password*) printf "%s\\n" "$BRIDGE_GIT_TOKEN" ;;\n'
                                '*) exit 1 ;;\nesac\n')
        self.askpass.chmod(0o700)
        self.run('init', '--bare', '--quiet')

    def run(self, *args, remote=None, allowed=(0,), binary=False, input_data=None):
        env = {'PATH': os.environ['PATH'], 'LANG': 'C', 'GIT_CONFIG_NOSYSTEM': '1',
               'GIT_CONFIG_GLOBAL': '/dev/null', 'GIT_TERMINAL_PROMPT': '0',
               'GIT_LFS_SKIP_SMUDGE': '1'}
        if remote and remote.token:
            env.update(GIT_ASKPASS=str(self.askpass), BRIDGE_GIT_USERNAME=remote.username,
                       BRIDGE_GIT_TOKEN=remote.token)
        try:
            result = subprocess.run(['git', '-c', 'credential.helper=', '-c', 'core.hooksPath=/dev/null',
                                     '-c', 'http.followRedirects=false', '-c', 'http.lowSpeedLimit=100',
                                     '-c', 'http.lowSpeedTime=30', *args], cwd=self.directory, env=env,
                                    capture_output=True, text=not binary, input=input_data, timeout=600)
        except subprocess.TimeoutExpired:
            raise BridgeError(f'git {args[0]} timed out; outcome unknown') from None
        if result.returncode not in allowed:
            raise BridgeError(f'git {args[0]} failed ({result.returncode}); command output withheld')
        return result

    def branch_ref(self, name):
        ref = 'refs/heads/' + name
        self.run('check-ref-format', ref)
        return ref

    def tip(self, remote, ref):
        rows = self.run('ls-remote', '--refs', '--heads', remote.url, ref, remote=remote).stdout.splitlines()
        return next((sha(oid) for oid, name in (row.split('\t') for row in rows) if name == ref), None)

    def fetch(self, remote, ref, *, shallow=False):
        depth = ('--depth=1',) if shallow else ()
        # Offer no local object IDs when reading from GitHub.
        negotiation = ('-c', 'fetch.negotiationAlgorithm=noop') if remote.provider == 'github' else ()
        self.run(*negotiation, 'fetch', '--quiet', '--no-tags', *depth, remote.url, ref, remote=remote)
        return sha(self.run('rev-parse', 'FETCH_HEAD^{commit}').stdout.strip())

    def is_ancestor(self, earlier, later):
        return self.run('merge-base', '--is-ancestor', sha(earlier), sha(later),
                        allowed=(0, 1, 128)).returncode == 0

    def first_parent_range(self, head, cursor):
        if head == cursor:
            return []
        history = self.run('rev-list', '--first-parent', sha(head)).stdout.splitlines()
        if cursor:
            try:
                history = history[:history.index(sha(cursor))]
            except ValueError:
                raise BridgeError('GitHub default branch no longer has the recorded first-parent history') from None
        return list(reversed(history))

    def rebuild(self, source, parent, account):
        raw = self.run('cat-file', 'commit', sha(source), binary=True).stdout
        headers, separator, message = raw.partition(b'\n\n')
        if not separator:
            raise BridgeError(f'Malformed source commit {source}')
        lines = headers.splitlines()
        first_parent = next((line[7:].decode('ascii') for line in lines if line.startswith(b'parent ')), None)
        if first_parent is None:
            first_parent = self.run('mktree', input_data='').stdout.strip()
        patch = self.run('diff', '--binary', '--full-index', '--no-ext-diff', '--no-textconv',
                         '--no-renames', '--no-color', first_parent, source, '--', binary=True).stdout
        self.run('read-tree', sha(parent))
        if patch:
            result = self.run('apply', '--cached', '--3way', '--whitespace=nowarn', binary=True,
                              input_data=patch, allowed=(0, 1))
            if result.returncode:
                raise BridgeError(f'Destination master conflicts with source commit {source}')
        tree = sha(self.run('write-tree').stdout.strip())
        identity = f'{account["username"]} <{account["email"]}>'.encode('utf-8')
        identities = []
        for field in (b'author', b'committer'):
            original = next((line for line in lines if line.startswith(field + b' ')), b'')
            date = re.search(rb' (-?[0-9]+ [+-][0-9]{4})$', original)
            if not date:
                raise BridgeError(f'Missing valid {field.decode("ascii")} date in source commit {source}')
            identities.append(field + b' ' + identity + b' ' + date.group(1))
        new_headers = [f'tree {tree}'.encode('ascii'), f'parent {parent}'.encode('ascii'), *identities]
        new_headers.extend(line for line in lines if line.startswith(b'encoding '))
        commit = b'\n'.join(new_headers) + b'\n\n' + message
        output = self.run('hash-object', '-t', 'commit', '-w', '--stdin', binary=True, input_data=commit)
        return sha(output.stdout.strip().decode('ascii'))

    def check_lfs(self, source_head):
        if self.lfs:
            self.run('lfs', 'version')
        else:
            attributes = self.run('log', '-p', '-m', '--format=', sha(source_head),
                                  '--', '.gitattributes', '**/.gitattributes', binary=True).stdout
            if re.search(rb'filter\s*=\s*lfs', attributes):
                raise BridgeError('Git LFS attributes detected; enable lfs before importing')

    def transfer_lfs(self, source, target, source_head):
        if self.lfs:
            if source.provider != 'github' or target.provider != 'gitcode':
                raise BridgeError('LFS transfers must go from GitHub to GitCode')
            for name, remote in (('lfs-source', source), ('lfs-target', target)):
                self.run('config', f'remote.{name}.url', remote.url)
            self.run('-c', 'lfs.url=' + source.url + '/info/lfs', 'lfs', 'fetch', '--all', 'lfs-source',
                     sha(source_head), remote=source)
            self.run('-c', 'lfs.url=' + target.url + '/info/lfs', 'lfs', 'push', '--all', 'lfs-target',
                     sha(source_head), remote=target)

    def stage(self, remote, branch, head):
        if remote.provider != 'gitcode' or not branch.startswith('bridge/'):
            raise BridgeError('Imported commits can only be pushed to destination bridge branches')
        ref = self.branch_ref(branch)
        current = self.tip(remote, ref)
        if current == head:
            return
        if current is not None:
            raise BridgeError('The destination sync branch already points to another commit')
        self.run('push', '--quiet', f'--force-with-lease={ref}:', remote.url, f'{sha(head)}:{ref}', remote=remote)

    def publish_state(self, remote, head, expected):
        if remote.provider != 'gitcode':
            raise BridgeError('Only the destination can receive checkpoints')
        # Compare-and-swap protects the checkpoint against concurrent writers. The
        # caller builds the new state commit with the expected state as its parent.
        self.run('push', '--quiet', f'--force-with-lease={STATE_REF}:{expected or ""}', remote.url,
                 f'{sha(head)}:{STATE_REF}', remote=remote)
