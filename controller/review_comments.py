"""Mirror first, exactly anchored line comments before merging a destination PR."""

import re

from api import ApiError, BridgeError, same_account


HUNK = re.compile(r'^@@ -[0-9]+(?:,[0-9]+)? \+([0-9]+)(?:,([0-9]+))? @@')


def right_lines(patch):
    """Only count right-side lines actually present in a published diff hunk."""
    lines = {}
    current, remaining = 0, 0
    for row in patch.split('\n'):
        match = HUNK.match(row)
        if match:
            current = int(match[1])
            remaining = int(match[2]) if match[2] is not None else 1
        elif remaining and row.startswith((' ', '+')):
            lines[current] = row[1:]
            current += 1
            remaining -= 1
    return lines


def first_comments(api, number):
    roots = []
    skipped = replies = 0
    for row in api.pages(f'/pulls/{number}/comments'):
        if row.get('in_reply_to_id') is not None:
            replies += 1
            continue
        line = row.get('line')
        if (row.get('subject_type', 'line') != 'line' or row.get('side') != 'RIGHT'
                or type(line) is not int or line < 1 or row.get('position', 1) is None
                or row.get('start_line') not in (None, line) or row.get('start_side') not in (None, 'RIGHT')):
            skipped += 1
            continue
        user = row.get('user')
        if (not str(row['id']).isdecimal() or not isinstance(row['path'], str) or not row['path']
                or not isinstance(row['body'], str) or 'user' not in row
                or (user is not None and (not isinstance(user, dict) or not str(user.get('id')).isdecimal()))):
            raise BridgeError('GitHub returned an incomplete review comment')
        roots.append(row)
    return roots, skipped, replies


def review_files(api, pr_path, wanted, *, destination=False):
    files = {}
    for row in api.pages(pr_path + '/files'):
        path = row.get('filename')
        if path not in wanted:
            continue
        patch = row.get('patch')
        if destination and isinstance(patch, dict):
            if patch.get('too_large') or patch.get('deleted_file') or patch.get('new_path') != path:
                continue
            patch = patch.get('diff')
        blob = row.get('blob_id' if destination else 'sha')
        if isinstance(patch, str) and isinstance(blob, str) and re.fullmatch(r'[0-9a-f]{40}', blob):
            files[path] = (blob, right_lines(patch))
    return files


def exact_line(comment, source_files, target_files):
    path, line = comment['path'], comment['line']
    source, target = source_files.get(path), target_files.get(path)
    if not source or not target or source[0] != target[0]:
        return False
    return line in source[1] and line in target[1] and source[1][line] == target[1][line]


class CommentDelivery:
    """Keep a write intent and the verified destination note ID outside comment text."""

    def __init__(self, bridge, store, path):
        self.bridge, self.store, self.path = bridge, store, path
        self.number = path.rsplit('/', 1)[1]
        self.records = dict(store.review_comments.get(self.number, {}))

    def save(self, source_id, record):
        updated = dict(self.records)
        if record is None:
            updated.pop(source_id)
        else:
            updated[source_id] = record
        self.store.save(self.store.progress, review_comments={**self.store.review_comments, self.number: updated})
        self.records = updated

    def notes(self):
        return list(self.bridge.target_api.pages(self.path + '/comments', comment_type='diff_comment'))

    def find_new(self, intent, notes):
        matches_found = []
        before = set(intent['before'])
        handle = intent.get('handle')
        payload = intent['payload']
        line = payload['position']
        for note in notes:
            note_id = str(note['id'])
            if note_id in before or (handle and handle not in (note_id, str(note.get('discussion_id')))):
                continue
            span = note.get('diff_position') or {}
            if (note.get('body') != payload['body'] or not same_account(note.get('user') or {}, intent['account'])
                    or span.get('end_new_line') != line or span.get('start_new_line') not in (None, line)):
                continue
            if not re.fullmatch(r'[1-9][0-9]*', note_id):
                raise BridgeError('Destination returned an invalid inline note ID')
            # The list supplies the mapped account ID. The detail supplies the path and head SHA.
            detail = self.bridge.target_api.call('GET', '/pulls/comments/' + note_id)
            pos = detail.get('position') or {}
            if (str(detail.get('id')) == note_id and detail.get('discussion_id') == note.get('discussion_id')
                    and detail.get('body') == payload['body'] and not detail.get('is_outdated')
                    and pos.get('position_type') == 'text' and pos.get('new_path') == payload['path']
                    and pos.get('new_line') == line and pos.get('head_sha') == self.store.progress['pending']['head']):
                matches_found.append(note_id)
        if len(matches_found) > 1:
            raise BridgeError('Ambiguous inline comment receipt. Check the private pending record before retrying.')
        return next(iter(matches_found), None)

    def post(self, source_id, intent):
        api = self.bridge.account_api(intent['account'])
        self.save(source_id, intent)
        try:
            response = api.call('POST', self.path + '/comments', intent['payload'])
        except ApiError as error:
            # Definite rejections have no note to reconcile. Other outcomes retain the intent.
            if error.code in (400, 401, 403, 404, 422):
                self.save(source_id, None)
            raise
        handle = str(response.get('id') or '') if isinstance(response, dict) else ''
        intent = dict(intent, handle=handle)
        self.save(source_id, intent)
        found = self.find_new(intent, self.notes())
        if not found:
            raise BridgeError('Could not confirm the inline comment body, account, path and line before merge.')
        self.save(source_id, found)

    def recover(self):
        # Recover an interrupted write even if GitHub has since edited or removed the source comment.
        for source_id, record in list(self.records.items()):
            if isinstance(record, dict):
                found = self.find_new(record, self.notes())
                if not found:
                    raise BridgeError(f'Inline comment {source_id} has an unconfirmed write. Check the private '
                                      'receipt and the destination PR before authorizing another POST.')
                self.save(source_id, found)

    def run(self, original):
        number = str(original['number'])
        self.recover()
        roots, skipped, replies = first_comments(self.bridge.github_api, number)
        fresh = [row for row in roots if str(row['id']) not in self.records]
        if fresh:
            self.bridge.verify_pending_refs(self.store.progress['pending'])
            paths = {row['path'] for row in fresh}
            source_files = review_files(self.bridge.github_api, f'/pulls/{number}', paths)
            target_files = review_files(self.bridge.target_api, self.path, paths, destination=True)
            for row in fresh:
                if not exact_line(row, source_files, target_files):
                    skipped += 1
                    continue
                account = self.bridge.mapped_account(row['user'])
                intent = {'account': {'id': account['id'], 'username': account['username']},
                          'payload': {'body': row['body'], 'path': row['path'],
                                      'position': row['line'], 'position_type': 'text'},
                          'before': [str(note['id']) for note in self.notes()]}
                self.post(str(row['id']), intent)
        print(f'REVIEW GitHub PR #{number} | confirmed {len(self.records)}, skipped {skipped}, replies ignored {replies}')
