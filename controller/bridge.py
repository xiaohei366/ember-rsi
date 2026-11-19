#!/usr/bin/env python3
"""Import the GitHub default branch into the destination's master."""

import argparse
from itertools import groupby
import json
import os
from pathlib import Path
import re
import sys
from tempfile import TemporaryDirectory

from api import Api, ApiError, BridgeError, same_account
from git_ops import CommitIdentityMismatch, Git, MASTER_BRANCH, MASTER_REF, Remote, repository, sha
from review_comments import CommentDelivery, first_comments
from state_store import GitStore, checkpoint


MEMBER_SECRET_NAME = re.compile(r'GITCODE_MEMBER_[1-9][0-9]*_TOKEN')
DEFAULT_MEMBERS_FILE = Path(__file__).resolve().parents[1] / '.github' / 'gitcode-members.json'
EMAIL = re.compile(r'[^@<>\x00-\x20\x7f]+@[^@<>\x00-\x20\x7f]+')
ZERO_SHA = '0' * 40


def validate_account(account, *, github=False, bot=False):
    fields = {'id', 'username', 'email'} if bot else {'id', 'username'}
    if not isinstance(account, dict) or set(account) != fields:
        raise BridgeError('Account fields must be id and username, plus email only in the bot configuration')
    pattern = r'[0-9]+' if github else r'[A-Za-z0-9_-]+'
    if not isinstance(account['id'], str) or not re.fullmatch(pattern, account['id']):
        raise BridgeError('Invalid account ID in the configuration')
    if not isinstance(account['username'], str) or not re.fullmatch(r'[A-Za-z0-9_.-]+', account['username']):
        raise BridgeError('Invalid account username in the configuration')
    if bot and not (isinstance(account['email'], str) and EMAIL.fullmatch(account['email'])):
        raise BridgeError('Enter the email bound to the destination bot')


def config_read(filename, members_file=DEFAULT_MEMBERS_FILE):
    cfg = json.loads(Path(filename).read_text(encoding='utf-8'))
    if not isinstance(cfg, dict) or set(cfg) != {'gitcode'} or not isinstance(cfg['gitcode'], dict):
        raise BridgeError('GITCODE_SYNC_CONFIG_JSON must contain only gitcode with repo and bot')
    gitcode = cfg['gitcode']
    if set(gitcode) != {'repo', 'bot'}:
        raise BridgeError('Expected gitcode.repo and gitcode.bot in GITCODE_SYNC_CONFIG_JSON')
    repository(gitcode['repo'])
    validate_account(gitcode['bot'], bot=True)
    members = json.loads(Path(members_file).read_text(encoding='utf-8'))
    if not isinstance(members, list):
        raise BridgeError('The member mapping must be a JSON array')
    seen = set()
    secret_owners, member_secrets = {}, {}
    for item in members:
        if not isinstance(item, dict) or set(item) != {'github', 'gitcode', 'gitcode_pr_token_secret'}:
            raise BridgeError('Each member mapping requires github, gitcode and gitcode_pr_token_secret')
        validate_account(item['github'], github=True)
        validate_account(item['gitcode'])
        source, member_id = item['github']['id'], item['gitcode']['id']
        if source in seen:
            raise BridgeError('Duplicate GitHub account ID in the mapping')
        seen.add(source)
        secret = item['gitcode_pr_token_secret']
        if (not isinstance(secret, str) or not MEMBER_SECRET_NAME.fullmatch(secret)
                or secret_owners.setdefault(secret, member_id) != member_id
                or member_secrets.setdefault(member_id, secret) != secret):
            raise BridgeError('Use one distinct numbered gitcode_pr_token_secret per mapped GitCode account')
        if member_id == gitcode['bot']['id']:
            raise BridgeError('The bot is the fallback and must not be a member mapping')
    return {'gitcode': gitcode, 'members': members}


def workflow_range():
    """A rerun reads the original event file and checkout revision."""
    event_name = os.environ['GITHUB_EVENT_NAME']
    after = sha(os.environ['GITHUB_SHA'])
    if event_name in ('schedule', 'workflow_dispatch'):
        return None, after
    if event_name != 'push':
        raise BridgeError('Expected a push, schedule or workflow_dispatch event')
    event = json.loads(Path(os.environ['GITHUB_EVENT_PATH']).read_text(encoding='utf-8'))
    if event['ref'] != os.environ['GITHUB_REF'] or event['after'] != after or event.get('deleted'):
        raise BridgeError('Push ref and after must match the checked-out revision')
    before = sha(event['before'])
    if (before == ZERO_SHA) != (event.get('created') is True) or after == ZERO_SHA:
        raise BridgeError('Invalid push boundaries')
    return (None if before == ZERO_SHA else before), after


class MemberUnavailable(BridgeError):
    """This member cannot supply a verified identity for the current run."""


MEMBER_AUTH_DENIED = (401, 403, 404)


def commit_email(api, profile, configured=None):
    address = profile.get('email')
    if (isinstance(address, str) and EMAIL.fullmatch(address)
            and address.rpartition('@')[2].casefold() == 'noreply.gitcode.com'
            and (configured is None or configured == address)):
        return address
    rows = api.request('GET', '/emails')
    if isinstance(rows, dict):
        rows = [rows]
    confirmed = {row['email'] for row in rows if row.get('state') == 'confirmed'
                 and isinstance(row.get('email'), str) and EMAIL.fullmatch(row['email'])}
    if configured is not None:
        if configured in confirmed:
            return configured
        raise BridgeError('The configured bot email must be confirmed or match its GitCode-issued noreply address')
    if address in confirmed:
        return address
    if len(confirmed) == 1:
        return next(iter(confirmed))
    raise MemberUnavailable('Select a confirmed email or the GitCode noreply address on the mapped member profile')


def checked_repo(api):
    info = api.call('GET')
    actual_path = info.get('full_path') or info.get('full_name') or ''
    if actual_path.casefold() != api.repo.casefold():
        raise BridgeError('Repository path does not match the configuration')
    return info


def pull_number(pull):
    value = str(pull.get('number', ''))
    if not re.fullmatch(r'[1-9][0-9]*', value):
        raise BridgeError('Repository API returned an invalid PR number')
    return value


def pull_is_merged(pull):
    return pull.get('state') == 'merged' or bool(pull.get('merged_at'))


class Bridge:
    def __init__(self, cfg, git, source_repo, bot_token, github_token=None, *, member_tokens=None):
        self.git = git
        self.bot = cfg['gitcode']['bot']
        self.mapping = {item['github']['id']: item['gitcode'] for item in cfg['members']}
        self.member_secrets = {item['gitcode']['id']: item['gitcode_pr_token_secret']
                               for item in cfg['members']}
        self.member_tokens = member_tokens or {}
        self.verified_members = {}
        self.unavailable_members = set()
        self.source = Remote('github', source_repo, github_token, 'x-access-token')
        self.github_api = Api('github', github_token, self.source.repo)
        source_info = checked_repo(self.github_api)
        self.source_branch = source_info['default_branch']
        self.source_ref = git.branch_ref(self.source_branch)
        if os.environ.get('GITHUB_ACTIONS') == 'true' and (
                os.environ.get('GITHUB_REPOSITORY', '').casefold() != self.source.repo.casefold()
                or os.environ.get('GITHUB_REF') != self.source_ref):
            raise BridgeError('Run the workflow from the source repository default branch')

        self.target = Remote('gitcode', cfg['gitcode']['repo'], bot_token, self.bot['username'])
        self.target_api = Api('gitcode', bot_token, self.target.repo)
        profile = self.target_api.request('GET', '/user')
        if not same_account(profile, self.bot):
            raise BridgeError('The destination token does not belong to the configured bot')
        commit_email(self.target_api, profile, self.bot['email'])
        target_info = checked_repo(self.target_api)

        self.binding = {
            'source': [self.source.repo.casefold(), source_info['id'], self.source_ref],
            'destination': [self.target.repo.casefold(), target_info['id'], MASTER_REF],
        }

    def disable_member(self, account, reason):
        member = account['id']
        self.unavailable_members.add(member)
        slot = self.member_secrets.get(member, 'previous member mapping')
        print(f'WARNING {slot}: {reason}. Using the robot for this member.')

    def credentials(self, account):
        member = account['id']
        if member == self.bot['id'] or member in self.unavailable_members:
            return self.bot, self.target_api
        if member in self.verified_members:
            return self.verified_members[member]
        token = self.member_tokens.get(self.member_secrets.get(member))
        try:
            if not token:
                raise MemberUnavailable('member PAT unavailable')
            api = Api('gitcode', token, self.target.repo)
            profile = api.request('GET', '/user')
            if not same_account(profile, account):
                raise MemberUnavailable('PAT belongs to a different account')
            resolved = {**account, 'email': commit_email(api, profile)}
        except MemberUnavailable as error:
            self.disable_member(account, str(error))
        except ApiError as error:
            if error.code not in MEMBER_AUTH_DENIED:
                raise
            self.disable_member(account, f'member credential lookup returned HTTP {error.code}')
        else:
            self.verified_members[member] = (resolved, api)
            return resolved, api
        return self.bot, self.target_api

    def mapped_account(self, github_user):
        account = self.mapping.get(str((github_user or {}).get('id')), self.bot)
        return self.credentials(account)[0]

    def author(self, commit, legacy_emails):
        if not self.mapping:
            return self.bot
        source = self.github_api.call('GET', '/commits/' + sha(commit))
        account = self.mapping.get(str((source.get('author') or {}).get('id')), self.bot)
        if account['id'] in legacy_emails:
            return {**account, 'email': legacy_emails[account['id']]}
        return self.credentials(account)[0]

    def post_as(self, account, post):
        """Retry as the robot only after a definitive member authorization rejection."""
        actual, api = self.credentials(account)
        try:
            return post(actual, api)
        except ApiError as error:
            if actual['id'] == self.bot['id'] or error.code not in MEMBER_AUTH_DENIED:
                raise
            self.disable_member(actual, f'member write rejected with HTTP {error.code}')
        return post(self.bot, self.target_api)

    def source_pull(self, commit):
        matches, exact = set(), set()
        for pull in self.github_api.pages(f'/commits/{sha(commit)}/pulls'):
            base = pull.get('base') or {}
            if (not pull.get('merged_at') or base.get('ref') != self.source_branch
                    or (base.get('repo') or {}).get('id') != self.binding['source'][1]):
                continue
            number = pull_number(pull)
            matches.add(number)
            if pull.get('merge_commit_sha') == commit:
                exact.add(number)
        matches = exact or matches
        if len(matches) > 1:
            raise BridgeError(f'GitHub returned multiple source PRs for commit {commit}')
        return next(iter(matches), None)

    def source_link(self, pending):
        repo_url = f'https://github.com/{self.source.repo}'
        if pending.get('alignment'):
            source = sha(pending['source'])
            return f'GitHub 基线 {source[:12]}', f'{repo_url}/commit/{source}'
        github_pull = pending['github_pull']
        if github_pull is not None:
            number = pull_number({'number': github_pull})
            return f'GitHub PR #{number}', f'{repo_url}/pull/{number}'
        source = sha(pending['source'])
        if pending.get('previous'):
            return 'GitHub 变更', f'{repo_url}/compare/{sha(pending["previous"])}...{source}'
        return 'GitHub 提交', f'{repo_url}/commit/{source}'

    def source_pr(self, number):
        if number is None:
            return None
        number = pull_number({'number': number})
        pull = self.github_api.call('GET', f'/pulls/{number}')
        if (not isinstance(pull, dict) or pull_number(pull) != number
                or not isinstance(pull.get('title'), str) or not pull['title'].strip()
                or 'body' not in pull or (pull['body'] is not None and not isinstance(pull['body'], str))):
            raise BridgeError('Could not read the original GitHub PR title and Markdown description')
        opener = pull.get('user')
        if 'user' not in pull or (opener is not None and (
                not isinstance(opener, dict) or not re.fullmatch(r'[1-9][0-9]*', str(opener.get('id'))))):
            raise BridgeError('Could not read the GitHub PR opener account ID')
        return pull

    def pr_creator(self, source_pr):
        account = self.mapped_account(source_pr['user']) if source_pr is not None else self.bot
        return {'id': account['id'], 'username': account['username']}

    def pending_number(self, pending):
        if 'number' in pending:
            return pull_number(pending)
        creator = pending.get('creator', self.bot)
        number = None
        for row in self.target_api.pages('/pulls', state='all', base=MASTER_BRANCH, author=creator['username']):
            if (row.get('head') or {}).get('ref') == pending['branch']:
                if number is not None:
                    raise BridgeError('Multiple destination PRs use the pending sync branch')
                number = pull_number(row)
        return number

    def prepare_pull(self, store, progress, number, original):
        pending = progress['pending']
        creator = pending.get('creator', self.bot)
        branch = pending['branch']
        if 'previous' not in pending:
            pending = {**pending, 'previous': progress['cursor']}
        label, source_url = self.source_link(pending)
        source_link = f'[{label}]({source_url})'
        title = original['title'] if original is not None else f'同步 {label}'
        description = (original['body'] or '') if original is not None else ''
        suffix = '\n\n' + description if description else ''
        draft_body = source_link + suffix if original is not None else '- ' + source_link
        if number is None:
            fields = {
                'title': title, 'head': branch, 'base': MASTER_BRANCH, 'body': draft_body,
                'draft': True, 'squash': False, 'prune_source_branch': True,
                'close_related_issue': False, 'inner_issue_nums': '',
            }

            def create(actual, api):
                identity = {'id': actual['id'], 'username': actual['username']}
                intent = {**pending, 'creator': identity}
                store.save({**progress, 'pending': intent})
                return intent, pull_number(api.call('POST', '/pulls', fields))

            pending, number = self.post_as(creator, create)
            creator = pending['creator']
        number = pull_number({'number': number})
        path = f'/pulls/{number}'
        pull = self.target_api.call('GET', path)
        head = pull.get('head') or {}
        merged = pull_is_merged(pull)
        if (not same_account(pull.get('user') or {}, creator)
                or (pull.get('base') or {}).get('ref') != MASTER_BRANCH
                or (not merged and (head.get('ref') != branch or head.get('sha') != pending['head']))):
            raise BridgeError('The destination PR does not match the prepared import')
        store.save({**progress, 'pending': {**pending, 'number': number}})
        if not merged and pull.get('state') not in ('open', 'opened', 'reopen', 'reopened'):
            raise BridgeError('The destination PR is closed. Reopen it before rerunning the workflow.')

        target_url = f'https://gitcode.com/{self.target.repo}/pull/{number}'
        target_link = f'[GitCode PR #{number}]({target_url})'
        stored = pull.get('body') or pull.get('description') or ''
        if original is not None:
            body = f'{source_link} <-> {target_link}{suffix}'
        else:
            # Direct pushes and baseline alignment have no source PR text to copy.
            body = stored
            missing = [f'- {link}' for link, url in ((source_link, source_url), (target_link, target_url))
                       if f']({url})' not in stored]
            if missing:
                separator = '\n' if body == draft_body else '\n\n'
                body = (body + separator if body else '') + '\n'.join(missing)

        if body != stored or (original is not None and pull.get('title') != title) or (not merged and pull.get('draft')):
            fields = {'body': body}
            if original is not None:
                fields['title'] = title
            if not merged:
                fields['draft'] = False
            self.target_api.call('PATCH', path, fields)
            published = self.target_api.call('GET', path)
            if ((published.get('body') or published.get('description')) != body
                    or (original is not None and published.get('title') != title)
                    or (not merged and published.get('draft'))):
                raise BridgeError('Could not confirm the published destination PR title and Markdown description')
        return path, merged

    def verify_pending_refs(self, pending):
        if self.git.tip(self.target, self.git.branch_ref(pending['branch'])) != pending['head']:
            raise BridgeError('The destination sync branch changed before merge')
        if 'base' in pending and self.git.tip(self.target, MASTER_REF) != pending['base']:
            raise BridgeError('Destination master advanced before merge. Rerun to prepare the current base.')

    def verify_landed_merge(self, pending, master, path):
        # Both callers have confirmed that master contains the exact head staged by the bridge.
        try:
            self.git.verify_merge_identity(pending['head'], master, self.bot)
        except CommitIdentityMismatch as error:
            if self.git.tree(master) != self.git.tree(pending['source']):
                raise BridgeError('Current master has a different tree from GitHub after a non-robot merge') from error
            if path is None:
                raise BridgeError('Could not identify the GitCode PR for the non-robot merge') from error
            pull = self.target_api.call('GET', path)
            if (not pull_is_merged(pull) or (pull.get('base') or {}).get('ref') != MASTER_BRANCH
                    or not same_account(pull.get('user') or {}, pending.get('creator', self.bot))):
                raise BridgeError('Could not confirm the prepared GitCode PR was merged into master') from error
            print(f'WARNING GitCode PR #{pull_number(pull)}: merge commit attribution differs from the configured robot. '
                  f'The prepared commits are in master and its tree matches GitHub {pending["source"]}.')

    def finish_pull(self, store, progress, original, number=None):
        pending = progress['pending']
        path, merged = self.prepare_pull(store, progress, number, original)
        if not merged:
            if original is not None:
                CommentDelivery(self, store, path).run(original)
            self.verify_pending_refs(pending)
            try:
                self.target_api.call('PUT', path + '/merge', {
                    'merge_method': 'merge', 'squash': False, 'force_merge': False,
                })
            except ApiError as error:
                raise BridgeError(f'Could not merge the destination PR. {error}') from error
        master = self.git.fetch(self.target, MASTER_REF)
        if not self.git.is_ancestor(pending['head'], master):
            raise BridgeError('Destination master does not contain the prepared commits after the PR merge')
        self.verify_landed_merge(pending, master, path)
        if self.git.tree(master) != self.git.tree(pending['source']):
            raise BridgeError('Destination master changed during the merge. Rerun to align it to GitHub.')
        return master

    def rebuild(self, commits, master, *, preview=False, alignment=False, pinned=None, legacy_emails=None):
        if alignment:
            source = commits[-1]
            message = f'Align master to GitHub {source}\n'
            return self.git.rebuild(source, [master], self.bot, maintenance_message=message), 0, {}

        # Each push follows the first-parent chain. Commits introduced by a merge
        # also include its topic branches. Translate those parents before the merge.
        base, graph = self.git.introduced_commits(commits[0], commits[-1])
        translated = {base: master} if base else {}
        existing_trees = None
        authors = {}
        for commit, *parents in graph:
            for parent in parents:
                if parent in translated:
                    continue
                # A topic may have branched before this batch. Preserve the true
                # parent tree so its first author's diff excludes unrelated changes.
                if existing_trees is None:
                    existing_trees = self.git.history_by_tree(master)
                tree = self.git.tree(parent)
                if tree not in existing_trees:
                    message = f'Anchor imported branch at GitHub {parent}\n'
                    existing_trees[tree] = self.git.rebuild(parent, [master], self.bot, maintenance_message=message)
                translated[parent] = existing_trees[tree]
            destination_parents = [translated[parent] for parent in parents]
            if not parents and commit == commits[0]:
                destination_parents = [master]
            author = pinned.get(commit, self.bot) if pinned is not None else self.author(commit, legacy_emails or {})
            if pinned is None and author['id'] != self.bot['id']:
                authors[commit] = author
            translated[commit] = self.git.rebuild(commit, destination_parents, author)
            if preview:
                print(f'{commit} | {"bot" if author["username"] == self.bot["username"] else "mapped"}')
        return translated[commits[-1]], len(graph), authors

    def import_batch(self, store, progress, batch, master, github_pull, *, previous, check, alignment=False):
        source = batch[-1]
        original = self.source_pr(github_pull)
        creator = self.pr_creator(original)
        if original is not None:
            kind = 'bot' if creator['id'] == self.bot['id'] else 'mapped'
            print(f'GitHub PR #{github_pull} | PR creator {kind}')
        head, count, authors = self.rebuild(batch, master, preview=check, alignment=alignment)
        if check:
            if original is not None:
                roots, skipped, replies = first_comments(self.github_api, github_pull)
                print(f'REVIEW preview | {len(roots)} candidate roots, {skipped} without a supported line, '
                      f'{replies} replies ignored')
            return head, count
        branch = f'bridge/github-{source[:12]}-{head[:20]}'
        pending = {'source': source, 'previous': previous, 'head': head, 'branch': branch, 'github_pull': github_pull,
                   'creator': creator, 'alignment': alignment, 'base': master}
        pending['authors'] = authors
        progress = {**progress, 'pending': pending}
        store.save(progress)
        self.git.stage(self.target, branch, head)
        return self.finish_pull(store, progress, original), count

    def resume(self, store, progress, master, *, check):
        pending = progress['pending']
        source = sha(pending['source'])
        self.git.ensure_commit(self.source, source)
        alignment = pending.get('alignment', False)
        batch = [source] if alignment else self.git.first_parent_range(source, progress['cursor'])
        original = self.source_pr(pending['github_pull'])
        number = self.pending_number(pending)
        if self.git.is_ancestor(pending['head'], master):
            path = f'/pulls/{number}' if number is not None else None
            self.verify_landed_merge(pending, master, path)
            if not check and number is not None:
                self.prepare_pull(store, progress, number, original)
                CommentDelivery(self, store, path).recover()
            return master, 0

        pinned = pending.get('authors')
        if (pinned is None and not alignment and pending.get('base') == master
                and self.git.tip(self.target, self.git.branch_ref(pending['branch'])) == pending['head']):
            # Older checkpoints stored the staged SHA but not each author choice.
            # Rebuild with the historic signatures and compare the entire DAG hash.
            self.git.ensure_commit(self.target, pending['head'])
            pinned = self.git.staged_authors(batch[0], source, pending['head'])
        expected, count, _ = self.rebuild(batch, master, preview=check, alignment=alignment,
                                          pinned=pinned, legacy_emails=pending.get('member_emails'))
        if expected != pending['head']:
            if number is not None:
                pull = self.target_api.call('GET', f'/pulls/{number}')
                if pull.get('state') != 'closed' or pull.get('merged_at'):
                    raise BridgeError('The pending PR is obsolete. Close it unmerged before rebuilding.')
            return self.import_batch(store, progress, batch, master, pending['github_pull'],
                                     previous=progress['cursor'], check=check, alignment=alignment)
        if check:
            ref = self.git.tip(self.target, self.git.branch_ref(pending['branch']))
            if ref != expected and (ref is not None or number is not None):
                raise BridgeError('The destination sync branch differs from the prepared commits')
            return expected, count
        if number is None:
            self.git.stage(self.target, pending['branch'], expected)
        return self.finish_pull(store, progress, original, number), count

    def align(self, store, progress, revision, master, *, check):
        if self.git.tree(master) == self.git.tree(revision):
            return master
        added, changed, deleted = self.git.alignment_counts(master, revision)
        print(f'ALIGN {revision} | add {added}, change {changed}, delete {deleted} tracked paths')
        master, _ = self.import_batch(store, progress, [revision], master, None,
                                      previous=progress['cursor'], check=check, alignment=True)
        return master

    def run(self, store, before, after, *, check=False):
        after = sha(after)
        if self.git.fetch(self.source, after) != after:
            raise BridgeError('GitHub did not return the selected revision')
        master = self.git.fetch(self.target, MASTER_REF)
        progress = store.restore(self.git, self.source, master)
        if check:
            status = 'MATCH' if self.git.tree(master) == self.git.tree(after) else 'DIFF'
            print(f'LIVE {status} against GitHub {after}')
            for account in self.mapping.values():
                self.credentials(account)
        if progress:
            if not self.git.is_ancestor(progress['master'], master):
                raise BridgeError('Destination master no longer contains the last confirmed commit')
            if progress['cursor']:
                self.git.ensure_commit(self.source, progress['cursor'])
        else:
            progress = checkpoint(None, master)

        def confirm(revision, destination):
            confirmed = checkpoint(revision, destination)
            if not check:
                store.save(confirmed)
            return confirmed

        count = 0
        if progress['pending']:
            revision = sha(progress['pending']['source'])
            master, count = self.resume(store, progress, master, check=check)
            # A merge can land just as another destination change lands. Confirm
            # the saved source tree before advancing past this unfinished batch.
            master = self.align(store, progress, revision, master, check=check)
            progress = confirm(revision, master)
        if progress['cursor'] is None:
            if before:
                self.git.first_parent_range(after, before)
            base = self.git.initial_base(after, before)
            master = self.align(store, progress, base, master, check=check)
            progress = confirm(base, master)

        cursor = progress['cursor']
        if self.git.is_ancestor(after, cursor):
            if not check:
                store.save(progress)  # Also persists a converted legacy receipt on an idle run.
            print(f'CURRENT selected GitHub revision {after} is covered by cursor {cursor}')
        else:
            commits = self.git.first_parent_range(after, cursor)
            master = self.align(store, progress, cursor, master, check=check)
            progress = confirm(cursor, master)
            for github_pull, group in groupby(commits, key=self.source_pull):
                batch = list(group)
                master, imported = self.import_batch(store, progress, batch, master, github_pull,
                                                     previous=progress['cursor'], check=check)
                count += imported
                progress = confirm(batch[-1], master)
            if self.git.tree(after) != self.git.tree(master):
                raise BridgeError('Destination tree does not match the selected GitHub revision')
            if not check:
                print(f'VERIFIED master tree matches GitHub {after}')
        if check:
            print(f'CHECK {count} source commits')
        elif count:
            print(f'IMPORTED {count} source commits')


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--config', default='bridge.json')
    parser.add_argument('--members', default=DEFAULT_MEMBERS_FILE)
    parser.add_argument('--source-repo', metavar='OWNER/REPO', default=os.environ.get('GITHUB_REPOSITORY'))
    mode = parser.add_mutually_exclusive_group(required=True)
    mode.add_argument('--check', action='store_true', help='Preview the import without remote writes')
    mode.add_argument('--apply', action='store_true', help='Apply one synchronization')
    args = parser.parse_args()
    if not args.source_repo:
        parser.error('--source-repo is required outside GitHub Actions')

    bot_token = os.environ.get('GITCODE_ROBOT_TOKEN')
    if not bot_token:
        raise BridgeError('Set GITCODE_ROBOT_TOKEN in the gitcode-sync environment')
    cfg = config_read(args.config, args.members)
    with TemporaryDirectory(prefix='bridge-') as directory:
        root = Path(directory)
        member_tokens = {key: value for key, value in os.environ.items() if MEMBER_SECRET_NAME.fullmatch(key)}
        bridge = Bridge(cfg, Git(root / 'import'), args.source_repo, bot_token,
                        os.environ.get('GITHUB_TOKEN'),
                        member_tokens=member_tokens)
        store = GitStore(Git(root / 'state'), bridge.target, bridge.binding, bridge.bot)
        if os.environ.get('GITHUB_EVENT_NAME') or os.environ.get('GITHUB_ACTIONS') == 'true':
            before, after = workflow_range()
        else:
            before, after = None, bridge.git.tip(bridge.source, bridge.source_ref)
        bridge.run(store, before, after, check=args.check)


if __name__ == '__main__':
    try:
        main()
    except BridgeError as error:
        print('ERROR ' + str(error), file=sys.stderr)
        sys.exit(1)
    except (AttributeError, KeyError, TypeError, ValueError, OSError):
        print('ERROR Invalid configuration, unexpected API response, or missing local dependency', file=sys.stderr)
        sys.exit(1)
