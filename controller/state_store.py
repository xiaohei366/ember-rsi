"""Checkpoints stored in the existing private destination repository."""

import json

from api import BridgeError
from git_ops import LEGACY_STATE_REF, STATE_REF, sha


STATE_FILE = 'progress.json'


class StateError(BridgeError):
    """The current reconciliation must stop because its state is unconfirmed."""


class GitStore:
    def __init__(self, git, remote, binding, bot):
        self.git, self.remote, self.binding = git, remote, binding
        self.bot = bot
        tips = git.tips(remote, STATE_REF, LEGACY_STATE_REF)
        if STATE_REF in tips and LEGACY_STATE_REF in tips:
            raise StateError('Both bridge-state and gtihub-sync exist. Reconcile their checkpoints before syncing.')
        self.read_ref = LEGACY_STATE_REF if LEGACY_STATE_REF in tips else STATE_REF
        self.tip = tips.get(self.read_ref)
        self.progress = None
        self.review_comments = {}
        if self.tip is None:
            return
        if git.fetch(remote, self.read_ref, shallow=True) != self.tip:
            raise StateError('State branch changed during restore. Rerun the workflow.')
        try:
            raw = git.run('cat-file', 'blob', f'{self.tip}:{STATE_FILE}', binary=True).stdout
            record = json.loads(raw)
            if record['repositories'] != binding:
                raise StateError('State branch belongs to a different bridge configuration')
            self.progress = record['progress']
            self.review_comments = record.get('review_comments', {})
            if not isinstance(self.review_comments, dict):
                raise StateError('State branch has invalid review comment receipts')
            if not isinstance(self.progress, dict) or not {'cursor', 'master', 'pending'} <= self.progress.keys():
                raise StateError('State branch is missing import progress')
        except (BridgeError, KeyError, TypeError, ValueError) as error:
            raise StateError('Could not restore private bridge state') from error

    def migrate_legacy_branch(self):
        if self.read_ref == LEGACY_STATE_REF:
            try:
                self.git.rename_legacy_state(self.remote, self.tip)
            except BridgeError as error:
                raise StateError('Could not rename bridge-state to gtihub-sync. Check branch permissions and rerun.') from error
            self.read_ref = STATE_REF
            print('MIGRATED checkpoint branch to gtihub-sync')

    def save(self, progress, *, review_comments=None):
        reviews = self.review_comments if review_comments is None else review_comments
        if progress == self.progress and reviews == self.review_comments:
            return
        record = {'repositories': self.binding, 'progress': progress}
        if reviews:
            record['review_comments'] = reviews
        snapshot = json.dumps(record, sort_keys=True)
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
        self.review_comments = reviews
