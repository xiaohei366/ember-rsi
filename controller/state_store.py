"""Per-push, snapshot and review receipts in the private destination repository."""

import json
import time

from api import BridgeError
from git_ops import LEGACY_STATE_REF, STATE_REF, sha


STATE_FILE = 'progress.json'


class StateError(BridgeError):
    """A receipt could not be verified or updated."""


class GitStore:
    def __init__(self, git, remote, binding, bot):
        self.git, self.remote, self.binding, self.bot = git, remote, binding, bot
        self.tip, self.read_ref, self.key = None, STATE_REF, None
        self.events, self.review_comments = {}, {}
        self.legacy_format = False
        self.refresh()

    def refresh(self):
        tips = self.git.tips(self.remote, STATE_REF, LEGACY_STATE_REF)
        if STATE_REF in tips and LEGACY_STATE_REF in tips:
            raise StateError('Both bridge-state and gtihub-sync exist. Reconcile their receipts before syncing.')
        self.read_ref = LEGACY_STATE_REF if LEGACY_STATE_REF in tips else STATE_REF
        tip = tips.get(self.read_ref)
        if tip == self.tip:
            return
        if not tip:
            raise StateError('Private bridge receipts disappeared during this run')
        tip = self.git.fetch(self.remote, self.read_ref, shallow=True)
        try:
            raw = self.git.run('cat-file', 'blob', f'{tip}:{STATE_FILE}', binary=True).stdout
            record = json.loads(raw)
            if record['repositories'] != self.binding:
                raise StateError('Private receipts belong to a different repository or branch')
            reviews = record.get('review_comments', {})
            if not isinstance(reviews, dict):
                raise ValueError('invalid review receipts')
            if 'events' in record:
                events = record['events']
                if not isinstance(events, dict) or not events:
                    raise ValueError('invalid event receipts')
                for key, item in events.items():
                    kind, after = key.split('/')
                    sha(after)
                    if kind not in ('push', 'snapshot') or type(item['done']) is not bool:
                        raise ValueError('invalid event')
                    sha(item['master'])
                    if kind == 'push':
                        sha(item['before'])
                    if type(item['applied']) is not int or item['applied'] < 0 or 'pending' not in item:
                        raise ValueError('invalid event progress')
                    if item['done'] and item['pending'] is not None:
                        raise ValueError('unfinished event marked complete')
            else:
                # A completed legacy checkpoint is evidence for that revision only.
                # An in-flight legacy PR must finish with the version that created it.
                old = record['progress']
                if old['pending'] is not None:
                    raise StateError('Finish the pending import with the previous workflow before upgrading')
                events = {'snapshot/' + sha(old['cursor']): {
                    'applied': 0, 'master': sha(old['master']), 'pending': None, 'done': True}}
        except (KeyError, TypeError, ValueError) as error:
            raise StateError('Could not restore private bridge state') from error
        self.tip, self.events, self.review_comments = tip, events, reviews
        self.legacy_format = 'events' not in record

    def select(self, before, after):
        self.key = ('push/' if before else 'snapshot/') + sha(after)
        if before and self.progress is not None and self.progress['before'] != before:
            raise StateError('A different push already used this after SHA. Check default branch history.')

    @property
    def progress(self):
        return self.events.get(self.key)

    def completed(self, revision):
        for kind in ('push/', 'snapshot/'):
            receipt = self.events.get(kind + revision)
            if receipt and receipt['done']:
                return receipt
        return None

    def wait_for_predecessor(self, before, *, timeout=0):
        if self.progress is not None or not before:
            return
        deadline = time.monotonic() + timeout
        announced = False
        while not self.completed(before) or any(not event['done'] for event in self.events.values()):
            if not self.events:
                raise StateError('Initialize from the default branch with a manual apply before enabling push.')
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                raise StateError(f'Preceding sync ending at {before} is not ready. Rerun the unfinished event, then this push.')
            if not announced:
                print(f'WAIT for preceding push ending at {before}', flush=True)
                announced = True
            time.sleep(min(30, remaining))
            self.refresh()

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
        if not self.legacy_format and progress == self.progress and reviews == self.review_comments:
            return
        events = {**self.events, self.key: progress}
        record = {'repositories': self.binding, 'events': events, 'review_comments': reviews}
        snapshot = json.dumps(record, sort_keys=True)
        try:
            blob = sha(self.git.run('hash-object', '-w', '--stdin', input_data=snapshot + '\n').stdout.strip())
            tree = sha(self.git.run('mktree', input_data=f'100644 blob {blob}\t{STATE_FILE}\n').stdout.strip())
            parent = ('-p', self.tip) if self.tip is not None else ()
            commit = sha(self.git.run('-c', 'user.name=' + self.bot['username'],
                                      '-c', 'user.email=' + self.bot['email'],
                                      'commit-tree', tree, *parent, '-m', 'Save sync receipts').stdout.strip())
            self.git.publish_state(self.remote, commit, expected=self.tip)
        except BridgeError as error:
            raise StateError('Could not update private bridge state. Rerun the workflow.') from error
        self.tip, self.events, self.review_comments = commit, events, reviews
        self.legacy_format = False
