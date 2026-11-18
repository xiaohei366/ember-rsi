#!/usr/bin/env python3
"""Import the GitHub default branch into the private destination's master."""

import argparse
from itertools import groupby
import json
import os
from pathlib import Path
import re
import sys
from tempfile import TemporaryDirectory
from urllib.parse import quote

from api import Api, ApiError, BridgeError
from git_ops import Git, MASTER_BRANCH, MASTER_REF, Remote, repository, sha
from state_store import GitStore


DEFAULT_MEMBER_SECRET = 'BRIDGE_PR_CREATOR_TOKEN'
MEMBER_SECRET_NAME = re.compile(r'BRIDGE_PR_CREATOR_TOKEN(?:_[1-9][0-9]*)?')


def validate_account(account, *, github=False):
    pattern = r'[0-9]+' if github else r'[A-Za-z0-9_-]+'
    if not isinstance(account['id'], str) or not re.fullmatch(pattern, account['id']):
        raise BridgeError('Invalid account ID in the configuration')
    if not re.fullmatch(r'[A-Za-z0-9_.-]+', account['username']):
        raise BridgeError('Invalid account username in the configuration')
    if not github and not re.fullmatch(
            r'[^@<>\x00-\x20\x7f]+@[^@<>\x00-\x20\x7f]+', account['email']):
        raise BridgeError('Enter the email bound to each destination account')


def config_read(filename):
    cfg = json.loads(Path(filename).read_text(encoding='utf-8'))
    if cfg.get('schema') != 4:
        raise BridgeError('Expected schema 4')
    if not isinstance(cfg.setdefault('identities', []), list):
        raise BridgeError('identities must be an array')

    github, gitcode = cfg['github'], cfg['gitcode']
    if github.get('start_from') is not None:
        sha(github['start_from'])
    repository(gitcode['repo'])
    validate_account(gitcode['bot'])
    seen = set()
    secret_owners, member_secrets = {}, {}
    for item in cfg['identities']:
        validate_account(item['github'], github=True)
        validate_account(item['gitcode'])
        source = item['github']['id']
        if source in seen:
            raise BridgeError('Duplicate GitHub account ID in the mapping')
        seen.add(source)
        member_id = item['gitcode']['id']
        if member_id != gitcode['bot']['id']:
            secret = item.get('pr_token_secret', DEFAULT_MEMBER_SECRET)
            if not isinstance(secret, str) or not MEMBER_SECRET_NAME.fullmatch(secret):
                raise BridgeError('identities[].pr_token_secret must be BRIDGE_PR_CREATOR_TOKEN or a numbered slot')
            if (secret_owners.setdefault(secret, member_id) != member_id
                    or member_secrets.setdefault(member_id, secret) != secret):
                raise BridgeError('Use one distinct pr_token_secret per mapped GitCode account')
    return cfg


def same_account(obj, account):
    return str(obj.get('id')) == account['id'] and (obj.get('login') or '').casefold() == account['username'].casefold()


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


class Bridge:
    def __init__(self, cfg, git, source_repo, bot_token, github_token=None, *, member_tokens=None):
        self.cfg, self.git = cfg, git
        self.bot = cfg['gitcode']['bot']
        self.mapping = {item['github']['id']: item['gitcode'] for item in cfg['identities']}
        self.member_secrets = {item['gitcode']['id']: item.get('pr_token_secret', DEFAULT_MEMBER_SECRET)
                               for item in cfg['identities']}
        self.member_tokens = member_tokens or {}
        self.member_apis = {}
        self.verified_accounts = set()
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
        email = self.bot['email']
        authenticated_alias = (email.rpartition('@')[2].casefold() == 'noreply.gitcode.com'
                               and profile.get('email') == email)
        if not authenticated_alias:
            emails = self.target_api.request('GET', '/emails')
            if isinstance(emails, dict):
                emails = [emails]
            if not isinstance(emails, list) or not any(
                    item.get('email') == email and item.get('state') == 'confirmed' for item in emails):
                raise BridgeError('The configured bot email must be confirmed on the destination account '
                                  'or match its GitCode-issued noreply address')
        target_info = checked_repo(self.target_api)
        if target_info.get('private') not in (1, True) or target_info.get('public') in (1, True):
            raise BridgeError('The destination repository must be private')

        self.binding = {
            'source': [self.source.repo.casefold(), source_info['id'], self.source_ref],
            'destination': [self.target.repo.casefold(), target_info['id'], MASTER_REF],
        }

    def verify_account(self, account):
        key = (account['id'], account['username'])
        if key not in self.verified_accounts:
            obj = self.target_api.request('GET', '/users/' + quote(account['username'], safe=''))
            if not same_account(obj, account):
                raise BridgeError('A mapped destination account ID does not match its configured username')
            self.verified_accounts.add(key)

    def mapped_account(self, github_user):
        account = self.mapping.get(str((github_user or {}).get('id')))
        if account is None:
            return self.bot
        self.verify_account(account)
        return account

    def author(self, commit):
        if not self.mapping:
            return self.bot
        source_commit = self.github_api.call('GET', '/commits/' + sha(commit))
        return self.mapped_account(source_commit.get('author'))

    def creator_api(self, account):
        account_id = account['id']
        if account_id == self.bot['id']:
            return self.target_api
        if account_id not in self.member_apis:
            secret = self.member_secrets[account_id]
            token = self.member_tokens.get(secret)
            if not token:
                raise BridgeError(f'Set {secret} for the mapped PR opener in the bridge-sync environment')
            api = Api('gitcode', token, self.target.repo)
            if not same_account(api.request('GET', '/user'), account):
                raise BridgeError(f'{secret} does not belong to the mapped PR opener')
            self.member_apis[account_id] = api
        return self.member_apis[account_id]

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

    def source_link(self, pending, cursor):
        repo_url = f'https://github.com/{self.source.repo}'
        if pending.get('alignment'):
            source = sha(pending['source'])
            return f'GitHub 基线 {source[:12]}', f'{repo_url}/commit/{source}'
        github_pull = pending['github_pull']
        if github_pull is not None:
            number = pull_number({'number': github_pull})
            return f'GitHub PR #{number}', f'{repo_url}/pull/{number}'
        source = sha(pending['source'])
        if cursor:
            return 'GitHub 变更', f'{repo_url}/compare/{sha(cursor)}...{source}'
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
        label, source_url = self.source_link(pending, progress['cursor'])
        source_link = f'[{label}]({source_url})'
        title = original['title'] if original is not None else f'同步 {label}'
        description = (original['body'] or '') if original is not None else ''
        suffix = '\n\n' + description if description else ''
        draft_body = source_link + suffix if original is not None else '- ' + source_link
        if number is None:
            created = self.creator_api(creator).call('POST', '/pulls', {
                'title': title,
                'head': branch,
                'base': MASTER_BRANCH,
                'body': draft_body,
                'draft': True,
                'squash': False,
                'prune_source_branch': True,
                'close_related_issue': False,
                'inner_issue_nums': '',
            })
            number = pull_number(created)
        number = pull_number({'number': number})
        path = f'/pulls/{number}'
        pull = self.target_api.call('GET', path)
        head = pull.get('head') or {}
        merged = pull.get('state') == 'merged' or bool(pull.get('merged_at'))
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

    def finish_pull(self, store, progress, original, number=None):
        pending = progress['pending']
        path, merged = self.prepare_pull(store, progress, number, original)
        if not merged:
            if self.git.tip(self.target, self.git.branch_ref(pending['branch'])) != pending['head']:
                raise BridgeError('The destination sync branch changed before merge')
            if 'base' in pending and self.git.tip(self.target, MASTER_REF) != pending['base']:
                raise BridgeError('Destination master advanced before merge. Rerun to prepare the current base.')
            try:
                self.target_api.call('PUT', path + '/merge', {
                    'merge_method': 'merge', 'squash': False, 'force_merge': False,
                })
            except ApiError as error:
                raise BridgeError(f'Could not merge the destination PR. {error}') from error
        master = self.git.fetch(self.target, MASTER_REF)
        if not self.git.is_ancestor(pending['head'], master):
            raise BridgeError('Destination master does not contain the prepared commits after the PR merge')
        self.git.verify_merge_identity(pending['head'], master, self.bot)
        if self.git.tree(master) != self.git.tree(pending['source']):
            raise BridgeError('Destination master changed during the merge. Rerun to align it to GitHub.')
        return master

    def rebuild(self, commits, master, *, preview=False, alignment=False):
        if alignment:
            source = commits[-1]
            message = f'Align master to GitHub {source}\n'
            return self.git.rebuild(source, [master], self.bot, maintenance_message=message), 0

        # The cursor is first-parent; the commits introduced by a normal merge
        # also include its topic branches. Translate those parents before the merge.
        base, graph = self.git.introduced_commits(commits[0], commits[-1])
        translated = {base: master} if base else {}
        existing_trees = None
        for commit, *parents in graph:
            for parent in parents:
                if parent in translated:
                    continue
                # A topic may have branched before the cursor. Preserve the true
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
            author = self.author(commit)
            translated[commit] = self.git.rebuild(commit, destination_parents, author)
            if preview:
                print(f'{commit} | {"bot" if author is self.bot else "mapped"}')
        return translated[commits[-1]], len(graph)

    def import_batch(self, store, progress, batch, master, github_pull, *, check, alignment=False):
        cursor = batch[-1]
        original = self.source_pr(github_pull)
        creator = self.pr_creator(original)
        self.creator_api(creator)
        if original is not None:
            kind = 'bot' if creator['id'] == self.bot['id'] else 'mapped'
            print(f'GitHub PR #{github_pull} | PR creator {kind}')
        head, count = self.rebuild(batch, master, preview=check, alignment=alignment)
        if check:
            return head, count
        branch = f'bridge/github-{cursor[:12]}-{head[:20]}'
        self.git.stage(self.target, branch, head)
        pending = {'source': cursor, 'head': head, 'branch': branch, 'github_pull': github_pull,
                   'creator': creator, 'alignment': alignment, 'base': master}
        progress = {**progress, 'pending': pending}
        store.save(progress)
        return self.finish_pull(store, progress, original), count

    def resume(self, store, progress, commits, master, *, check):
        """Return source cursor, target head, consumed first-parent entries and imported commit count."""
        pending = progress['pending']
        source = pending['source']
        alignment = pending.get('alignment', False)
        if alignment and source == progress['cursor']:
            consumed = 0
        elif source in commits:
            consumed = commits.index(source) + 1
        else:
            raise BridgeError('GitHub default branch no longer contains the pending import')
        if self.git.is_ancestor(pending['head'], master):
            self.git.verify_merge_identity(pending['head'], master, self.bot)
            if not check and 'branch' in pending:
                number = self.pending_number(pending)
                if number is not None:
                    self.prepare_pull(store, progress, number, self.source_pr(pending['github_pull']))
            return source, master, consumed, 0
        if 'branch' in pending:
            batch = [source] if alignment else commits[:consumed]
            expected, count = self.rebuild(batch, master, preview=check, alignment=alignment)
            number = self.pending_number(pending)
            if expected == pending['head']:
                original = self.source_pr(pending['github_pull'])
                creator = self.pr_creator(original)
                if creator['id'] != pending.get('creator', self.bot)['id']:
                    if number is not None:
                        prior = self.target_api.call('GET', f'/pulls/{number}')
                        if prior.get('state') != 'closed' or prior.get('merged_at'):
                            raise BridgeError('The pending PR has a different creator. Close it unmerged '
                                              'and rerun to create it with the mapped identity.')
                    self.creator_api(creator)
                    pending = dict(pending, creator=creator)
                    pending.pop('number', None)
                    progress = dict(progress, pending=pending)
                    number = self.pending_number(pending)
                    if not check:
                        self.git.stage(self.target, pending['branch'], expected)
                        store.save(progress)
                if check:
                    if self.git.tip(self.target, self.git.branch_ref(pending['branch'])) != expected:
                        raise BridgeError('The destination sync branch differs from the prepared commits')
                    master = expected
                else:
                    master = self.finish_pull(store, progress, original, number)
                return source, master, consumed, count
            # An older controller or a newly changed master can leave a staged PR
            # with the wrong tree or identity. Never merge it as a recovery step.
            if number is not None:
                pull = self.target_api.call('GET', f'/pulls/{number}')
                if pull.get('state') != 'closed' or pull.get('merged_at'):
                    raise BridgeError('The pending PR is obsolete. Close it unmerged in the destination '
                                      'and rerun to rebuild it from GitHub.')
        if not check:
            store.save({**progress, 'pending': None})
        return progress['cursor'], master, 0, 0

    def run(self, store, *, check=False):
        source_head = self.git.fetch(self.source, self.source_ref)
        master = self.git.fetch(self.target, MASTER_REF)
        progress = store.progress
        if progress is None:
            progress = {'cursor': self.cfg['github'].get('start_from'), 'master': master, 'pending': None}
        if not self.git.is_ancestor(progress['master'], master):
            raise BridgeError('Destination master no longer contains the last confirmed commit')
        cursor = progress['cursor']
        commits = self.git.first_parent_range(source_head, cursor)
        if check:
            status = 'MATCH' if self.git.tree(master) == self.git.tree(source_head) else 'DIFF'
            print(f'LIVE {status} against GitHub {source_head}')
            for account in self.mapping.values():
                self.verify_account(account)
                self.creator_api(account)
        count = 0
        if progress['pending']:
            cursor, master, consumed, count = self.resume(store, progress, commits, master, check=check)
            commits = commits[consumed:]
        # A recorded cursor is not evidence that the two file trees match. This
        # also repairs legacy checkpoints and drift after a successful merge.
        if cursor and self.git.tree(master) != self.git.tree(cursor):
            added, changed, deleted = self.git.alignment_counts(master, cursor)
            print(f'ALIGN {cursor} | add {added}, change {changed}, delete {deleted} tracked paths')
            master, _ = self.import_batch(store, progress, [cursor], master, None, check=check, alignment=True)
        progress = {'cursor': cursor, 'master': master, 'pending': None}
        if not check and (store.progress is not None or not commits):
            store.save(progress)
        for github_pull, group in groupby(commits, key=self.source_pull):
            batch = list(group)
            master, imported = self.import_batch(store, progress, batch, master, github_pull, check=check)
            count += imported
            progress = {'cursor': batch[-1], 'master': master, 'pending': None}
            if not check:
                store.save(progress)
        if self.git.tree(source_head) != self.git.tree(master):
            raise BridgeError('Destination tree does not match the selected GitHub default branch revision')
        if check:
            print(f'CHECK {count} source commits')
        elif count:
            print(f'IMPORTED {count} source commits')
            print(f'VERIFIED master tree matches GitHub {source_head}')
        else:
            print('CURRENT destination tree matches the GitHub default branch')


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--config', default='bridge.json')
    parser.add_argument('--source-repo', metavar='OWNER/REPO', default=os.environ.get('GITHUB_REPOSITORY'))
    mode = parser.add_mutually_exclusive_group(required=True)
    mode.add_argument('--check', action='store_true', help='Preview the import without remote writes')
    mode.add_argument('--apply', action='store_true', help='Apply one synchronization')
    args = parser.parse_args()
    if not args.source_repo:
        parser.error('--source-repo is required outside GitHub Actions')

    bot_token = os.environ.get('BRIDGE_TARGET_TOKEN')
    if not bot_token:
        raise BridgeError('Missing the destination workflow secret')
    cfg = config_read(args.config)
    with TemporaryDirectory(prefix='bridge-') as directory:
        root = Path(directory)
        member_tokens = {key: value for key, value in os.environ.items() if MEMBER_SECRET_NAME.fullmatch(key)}
        bridge = Bridge(cfg, Git(root / 'import'), args.source_repo, bot_token,
                        os.environ.get('BRIDGE_SOURCE_READ_TOKEN'),
                        member_tokens=member_tokens)
        store = GitStore(Git(root / 'state'), bridge.target, bridge.binding, bridge.bot)
        bridge.run(store, check=args.check)


if __name__ == '__main__':
    try:
        main()
    except BridgeError as error:
        print('ERROR ' + str(error), file=sys.stderr)
        sys.exit(1)
    except (AttributeError, KeyError, TypeError, ValueError, OSError):
        print('ERROR Invalid configuration, unexpected API response, or missing local dependency', file=sys.stderr)
        sys.exit(1)
