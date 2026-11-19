"""Persist one confirmed source cursor, its destination head and unfinished writes."""

import json

from api import BridgeError
from git_ops import LEGACY_STATE_REFS, STATE_REF, sha


STATE_FILE = 'progress.json'


class StateError(BridgeError):
    """A checkpoint could not be verified or updated."""


def checkpoint(cursor, master, pending=None):
    if pending is not None:
        if not isinstance(pending, dict) or not {'source', 'head'} <= pending.keys():
            raise StateError('Checkpoint contains an incomplete pending import')
        sha(pending['source'])
        sha(pending['head'])
    return {'cursor': sha(cursor) if cursor is not None else None, 'master': sha(master), 'pending': pending}


def migrate_events(events, git, source, master):
    """Resolve old event ordering by Git ancestry. Keep any partially applied batch."""
    completed, active = {}, []
    for key, event in events.items():
        kind, after = key.split('/')
        sha(after)
        landed = sha(event['master'])
        if kind not in ('snapshot', 'push') or type(event['done']) is not bool:
            raise StateError('Invalid event receipt')
        if type(event['applied']) is not int or event['applied'] < 0:
            raise StateError('Invalid event batch count')
        before = sha(event['before']) if kind == 'push' else None
        if event['done']:
            if event['pending'] is not None:
                raise StateError('A completed event still contains a pending PR')
            completed.setdefault(after, set()).add(landed)
        else:
            active.append((before, after, event))
    if len(active) > 1 or not (completed or active):
        raise StateError('Cannot unambiguously migrate the event receipts')

    progress = None
    if completed:
        for revision in completed:
            git.ensure_commit(source, revision)
        # JSON key order, commit dates, and the revision of the waking run can
        # all differ from the latest completed position on the source branch.
        tip = git.run('rev-list', '--first-parent', '--topo-order', '--max-count=1', '--stdin',
                      input_data='\n'.join(completed) + '\n').stdout.strip()
        history = git.run('rev-list', '--first-parent', sha(tip)).stdout.splitlines()
        if not completed.keys() <= set(history):
            raise StateError('Completed event receipts diverge on the GitHub first-parent history')
        targets = completed[tip]
        dest_history = git.run('rev-list', '--first-parent', master).stdout.splitlines()
        if not targets.issubset(dest_history):
            raise StateError('Destination master no longer contains the confirmed event history')
        progress = checkpoint(tip, next(oid for oid in dest_history if oid in targets))

    if active:
        before, after, event = active[0]
        git.ensure_commit(source, after)
        batch = git.first_parent_range(after, before) if before else []
        applied = event['applied']
        if applied > len(batch) or (progress and (before or after) != progress['cursor']):
            raise StateError('The unfinished event does not continue the confirmed cursor')
        if progress and not git.is_ancestor(progress['master'], event['master']):
            raise StateError('The unfinished event has unrelated destination history')
        cursor = batch[applied - 1] if applied else (before or (progress and progress['cursor']))
        # An interrupted first snapshot may have landed its alignment before the
        # old runner saved done=true. Its tree is rechecked before confirmation.
        if cursor is None and event['pending'] is None:
            if git.tree(event['master']) != git.tree(after):
                raise StateError('Initial snapshot is incomplete and has no prepared PR')
            cursor = after
        progress = checkpoint(cursor, event['master'], event['pending'])
    return progress


class GitStore:
    def __init__(self, git, remote, binding, bot):
        self.git, self.remote, self.binding, self.bot = git, remote, binding, bot
        tips = git.tips(remote, STATE_REF, *LEGACY_STATE_REFS)
        if len(tips) > 1:
            raise StateError('Multiple state branches exist. Reconcile their histories before syncing.')
        self.read_ref, self.tip = next(iter(tips.items()), (STATE_REF, None))
        self.progress, self.old_events, self.review_comments = None, None, {}
        if self.tip is None:
            return
        if self.git.fetch(remote, self.read_ref, shallow=True) != self.tip:
            raise StateError('State branch changed during restore. Retry the run.')
        try:
            record = json.loads(git.run('cat-file', 'blob', f'{self.tip}:{STATE_FILE}', binary=True).stdout)
            if record['repositories'] != binding:
                raise StateError('State belongs to a different repository or branch')
            self.review_comments = record.get('review_comments', {})
            if not isinstance(self.review_comments, dict):
                raise ValueError('invalid review receipts')
            if 'events' in record:
                self.old_events = record['events']
                if not isinstance(self.old_events, dict) or not self.old_events or 'progress' in record:
                    raise ValueError('invalid event receipts')
            else:
                old = record['progress']
                self.progress = checkpoint(old['cursor'], old['master'], old['pending'])
        except (KeyError, TypeError, ValueError) as error:
            raise StateError('Could not restore bridge state') from error

    def restore(self, git, source, master):
        if self.old_events is not None:
            try:
                self.progress = migrate_events(self.old_events, git, source, master)
            except (KeyError, TypeError, ValueError) as error:
                raise StateError('Could not migrate bridge event receipts') from error
        return self.progress

    def migrate_legacy_branch(self):
        if self.read_ref != STATE_REF:
            try:
                self.git.rename_legacy_state(self.remote, self.read_ref, self.tip)
            except BridgeError as error:
                raise StateError('Could not rename the old state branch to github-sync. Check branch permissions.') from error
            self.read_ref = STATE_REF
            print('MIGRATED checkpoint branch to github-sync')

    def save(self, progress, *, review_comments=None):
        self.migrate_legacy_branch()
        reviews = self.review_comments if review_comments is None else review_comments
        if self.old_events is None and progress == self.progress and reviews == self.review_comments:
            return
        record = {'repositories': self.binding, 'progress': progress, 'review_comments': reviews}
        snapshot = json.dumps(record, sort_keys=True)
        try:
            blob = sha(self.git.run('hash-object', '-w', '--stdin', input_data=snapshot + '\n').stdout.strip())
            tree = sha(self.git.run('mktree', input_data=f'100644 blob {blob}\t{STATE_FILE}\n').stdout.strip())
            parent = ('-p', self.tip) if self.tip is not None else ()
            commit = sha(self.git.run('-c', 'user.name=' + self.bot['username'],
                                      '-c', 'user.email=' + self.bot['email'],
                                      'commit-tree', tree, *parent, '-m', 'Save sync checkpoint').stdout.strip())
            self.git.publish_state(self.remote, commit, expected=self.tip)
        except BridgeError as error:
            raise StateError('Could not update bridge state. A later run can retry.') from error
        self.tip, self.progress, self.review_comments = commit, progress, reviews
        self.old_events = None
