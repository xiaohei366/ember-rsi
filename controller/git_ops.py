"""Read Git objects and rebuild commits without checking out contribution code."""

import os
from pathlib import Path
import re
import subprocess

from api import BridgeError


STATE_REF = 'refs/heads/github-sync'
LEGACY_STATE_REFS = ('refs/heads/gtihub-sync', 'refs/heads/bridge-state')
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
    def __init__(self, directory):
        self.directory = Path(directory)
        self.directory.mkdir(parents=True, exist_ok=True)
        self.askpass = self.directory / 'askpass'
        self.askpass.write_text('#!/bin/sh\ncase "$1" in\n'
                                '*Username*) printf "%s\\n" "$SYNC_GIT_HTTPS_USERNAME" ;;\n'
                                '*Password*) printf "%s\\n" "$SYNC_GIT_HTTPS_TOKEN" ;;\n'
                                '*) exit 1 ;;\nesac\n')
        self.askpass.chmod(0o700)
        self.run('init', '--bare', '--quiet')

    def run(self, *args, remote=None, allowed=(0,), binary=False, input_data=None):
        env = {'PATH': os.environ['PATH'], 'LANG': 'C', 'GIT_CONFIG_NOSYSTEM': '1',
               'GIT_CONFIG_GLOBAL': '/dev/null', 'GIT_TERMINAL_PROMPT': '0'}
        if remote and remote.token:
            env.update(GIT_ASKPASS=str(self.askpass), SYNC_GIT_HTTPS_USERNAME=remote.username,
                       SYNC_GIT_HTTPS_TOKEN=remote.token)
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

    def tips(self, remote, *refs):
        rows = self.run('ls-remote', '--refs', '--heads', remote.url, *refs, remote=remote).stdout.splitlines()
        return {name: sha(oid) for oid, name in (row.split('\t') for row in rows) if name in refs}

    def tip(self, remote, ref):
        return self.tips(remote, ref).get(ref)

    def fetch(self, remote, ref, *, shallow=False):
        depth = ('--depth=1',) if shallow else ()
        # Offer no local object IDs when reading from GitHub.
        negotiation = ('-c', 'fetch.negotiationAlgorithm=noop') if remote.provider == 'github' else ()
        self.run(*negotiation, 'fetch', '--quiet', '--no-tags', *depth, remote.url, ref, remote=remote)
        return sha(self.run('rev-parse', 'FETCH_HEAD^{commit}').stdout.strip())

    def ensure_commit(self, remote, revision):
        revision = sha(revision)
        if self.run('cat-file', '-e', revision + '^{commit}', allowed=(0, 1, 128)).returncode:
            self.fetch(remote, revision)

    def initial_base(self, after, before):
        # The installation push can itself be skipped or overtaken by a later run.
        install = self.run('log', '--first-parent', '--diff-filter=A', '-1', '--format=%H',
                           sha(after), '--', '.github/workflows/bridge.yml').stdout.strip()
        if install:
            parents = self.run('show', '-s', '--format=%P', sha(install)).stdout.split()
            base = parents[0] if parents else install
            return before if before and self.is_ancestor(before, base) else base
        return before or after

    def is_ancestor(self, earlier, later):
        return self.run('merge-base', '--is-ancestor', sha(earlier), sha(later),
                        allowed=(0, 1, 128)).returncode == 0

    def first_parent_range(self, after, before):
        if before is None:
            return self.run('rev-list', '--first-parent', '--reverse', sha(after)).stdout.splitlines()
        if sha(after) == sha(before):
            return []
        if self.is_ancestor(before, after):
            commits = self.run('rev-list', '--first-parent', '--reverse', f'{before}..{after}').stdout.splitlines()
            if commits and self.run('show', '-s', '--format=%P', commits[0]).stdout.split()[:1] == [before]:
                return commits
        raise BridgeError('Source history diverged: the cursor is not on the first-parent history of the selected revision')

    def tree(self, commit):
        return sha(self.run('rev-parse', sha(commit) + '^{tree}').stdout.strip())

    def introduced_commits(self, first, last):
        parents = self.run('show', '-s', '--format=%P', sha(first)).stdout.split()
        base = parents[0] if parents else None
        exclude = ['^' + base] if base else []
        rows = self.run('rev-list', '--parents', '--reverse', '--topo-order', sha(last), *exclude)
        return base, [line.split() for line in rows.stdout.splitlines()]

    def history_by_tree(self, head):
        by_tree = {}
        for row in self.run('log', '--format=%T %H', sha(head)).stdout.splitlines():
            tree, commit = row.split()
            by_tree.setdefault(tree, commit)
        return by_tree

    def alignment_counts(self, master, source):
        changes = self.run('diff', '--no-renames', '--name-status', '-z', sha(master), sha(source),
                           '--', binary=True).stdout
        statuses = changes.split(b'\0')[:-1:2]
        added = statuses.count(b'A')
        deleted = statuses.count(b'D')
        return added, len(statuses) - added - deleted, deleted

    def verify_identity(self, commit, account):
        raw = self.run('cat-file', 'commit', sha(commit), binary=True).stdout
        headers = raw.partition(b'\n\n')[0].split(b'\n')
        identity = f'{account["username"]} <{account["email"]}>'.encode('utf-8')
        for field in (b'author ', b'committer '):
            people = [line.rsplit(b' ', 2)[0] for line in headers if line.startswith(field)]
            if people != [field + identity]:
                raise BridgeError('Commit author and committer must both match the selected destination account')

    def staged_authors(self, first, last, staged):
        """Read legacy author choices in source-parent order for a deterministic rebuild."""
        _, graph = self.introduced_commits(first, last)
        translated, authors = {last: staged}, {}
        for source, *parents in reversed(graph):
            if source not in translated:
                return None
            fields = self.run('show', '-s', '--format=%P%x00%an%x00%ae', translated[source]).stdout
            target_parents, name, email = fields.rstrip('\n').split('\0')
            target_parents = target_parents.split()
            if parents and len(parents) != len(target_parents):
                return None
            for parent, target in zip(parents, target_parents):
                if translated.setdefault(parent, target) != target:
                    return None
            authors[source] = {'username': name, 'email': email}
        return authors

    def verify_merge_identity(self, head, master, bot):
        # A fast-forward has no extra commit. A normal PR merge introduces head
        # as a secondary parent, even if master advanced again before our fetch.
        merges = self.run('rev-list', '--first-parent', '--merges', '--parents',
                          f'{sha(head)}..{sha(master)}').stdout.splitlines()
        for row in merges:
            fields = row.split()
            if head in fields[2:]:
                self.verify_identity(fields[0], bot)
                break

    def rebuild(self, source, parents, account, *, maintenance_message=None):
        raw = self.run('cat-file', 'commit', sha(source), binary=True).stdout
        headers, separator, message = raw.partition(b'\n\n')
        if not separator:
            raise BridgeError(f'Malformed source commit {source}')
        lines = headers.splitlines()
        identity = f'{account["username"]} <{account["email"]}>'.encode('utf-8')
        identities = []
        for field in (b'author', b'committer'):
            original = next((line for line in lines if line.startswith(field + b' ')), b'')
            date = re.search(rb' (-?[0-9]+ [+-][0-9]{4})$', original)
            if not date:
                raise BridgeError(f'Missing valid {field.decode("ascii")} date in source commit {source}')
            identities.append(field + b' ' + identity + b' ' + date.group(1))
        # Use the source tree object itself, including deletions, modes and symlinks.
        new_headers = [f'tree {self.tree(source)}'.encode('ascii')]
        new_headers.extend(f'parent {sha(p)}'.encode('ascii') for p in dict.fromkeys(parents))
        new_headers.extend(identities)
        if maintenance_message is not None:
            message = maintenance_message.encode('ascii')
        else:
            new_headers.extend(line for line in lines if line.startswith(b'encoding '))
        commit = b'\n'.join(new_headers) + b'\n\n' + message
        output = self.run('hash-object', '-t', 'commit', '-w', '--stdin', binary=True, input_data=commit)
        rebuilt = sha(output.stdout.strip().decode('ascii'))
        self.verify_identity(rebuilt, account)
        return rebuilt

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

    def rename_legacy_state(self, remote, old_ref, expected):
        if remote.provider != 'gitcode':
            raise BridgeError('Only the destination can receive checkpoints')
        if old_ref not in LEGACY_STATE_REFS:
            raise BridgeError('Unknown legacy state branch')
        tip = sha(expected)
        self.run('push', '--quiet', '--atomic', f'--force-with-lease={old_ref}:{tip}',
                 f'--force-with-lease={STATE_REF}:', remote.url, f'{tip}:{STATE_REF}',
                 f':{old_ref}', remote=remote)
