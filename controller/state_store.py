"""Checkpoints stored in the existing private destination repository."""

import json

from api import BridgeError
from git_ops import STATE_REF, sha


STATE_FILE = 'progress.json'


class StateError(BridgeError):
    """The current reconciliation must stop because its state is unconfirmed."""


class GitStore:
    def __init__(self, git, remote, binding, bot):
        self.git, self.remote, self.binding = git, remote, binding
        self.bot = bot
        self.tip = git.tip(remote, STATE_REF)
        self.progress = None
        if self.tip is None:
            return
        if git.fetch(remote, STATE_REF, shallow=True) != self.tip:
            raise StateError('State branch changed during restore. Rerun the workflow.')
        try:
            raw = git.run('cat-file', 'blob', f'{self.tip}:{STATE_FILE}', binary=True).stdout
            record = json.loads(raw)
            if record['repositories'] != binding:
                raise StateError('State branch belongs to a different bridge configuration')
            self.progress = record['progress']
            if not isinstance(self.progress, dict) or not {'cursor', 'master', 'pending'} <= self.progress.keys():
                raise StateError('State branch is missing import progress')
        except (BridgeError, KeyError, TypeError, ValueError) as error:
            raise StateError('Could not restore private bridge state') from error

    def save(self, progress):
        if progress == self.progress:
            return
        snapshot = json.dumps({'repositories': self.binding, 'progress': progress}, sort_keys=True)
        try:
            blob = sha(self.git.run('hash-object', '-w', '--stdin', input_data=snapshot + '\n').stdout.strip())
            tree = sha(self.git.run('mktree', input_data=f'100644 blob {blob}\t{STATE_FILE}\n').stdout.strip())
            parent = ('-p', self.tip) if self.tip is not None else ()
            commit = sha(self.git.run('-c', 'user.name=' + self.bot['username'],
                                      '-c', 'user.email=' + self.bot['email'],
                                      'commit-tree', tree, *parent, '-m', 'Save bridge state').stdout.strip())
            self.git.publish_state(self.remote, commit, expected=self.tip)
        except BridgeError as error:
            raise StateError('Could not update private bridge state. Rerun the workflow.') from error
        self.tip = commit
        self.progress = progress
