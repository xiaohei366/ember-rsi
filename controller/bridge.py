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


def validate_account(account, *, github=False, require_email=True):
    pattern = r'[0-9]+' if github else r'[A-Za-z0-9_-]+'
    if not isinstance(account['id'], str) or not re.fullmatch(pattern, account['id']):
        raise BridgeError('Invalid account ID in the configuration')
    if not re.fullmatch(r'[A-Za-z0-9_.-]+', account['username']):
        raise BridgeError('Invalid account username in the configuration')
    if not github and require_email and not re.fullmatch(
            r'[^@<>\x00-\x20\x7f]+@[^@<>\x00-\x20\x7f]+', account['email']):
        raise BridgeError('Enter the email bound to each destination account')


def config_read(filename):
    cfg = json.loads(Path(filename).read_text(encoding='utf-8'))
    if cfg.get('schema') != 4:
        raise BridgeError('Expected schema 4')
    if not isinstance(cfg.setdefault('lfs', False), bool):
        raise BridgeError('lfs must be a boolean')
    if not isinstance(cfg.setdefault('identities', []), list):
        raise BridgeError('identities must be an array')

    github, gitcode = cfg['github'], cfg['gitcode']
    if github.get('start_from') is not None:
        sha(github['start_from'])
    repository(gitcode['repo'])
    validate_account(gitcode['bot'])
    creator = gitcode.get('pr_creator')
    if creator is not None:
        if not isinstance(creator, dict):
            raise BridgeError('gitcode.pr_creator must be an account object')
        validate_account(creator, require_email=False)

    seen = set()
    for item in cfg['identities']:
        validate_account(item['github'], github=True)
        validate_account(item['gitcode'])
        source = item['github']['id']
        if source in seen:
            raise BridgeError('Duplicate GitHub account ID in the mapping')
        seen.add(source)
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
    def __init__(self, cfg, git, source_repo, bot_token, github_token=None, *, creator_token=None):
        self.cfg, self.git = cfg, git
        self.bot = cfg['gitcode']['bot']
        configured_creator = cfg['gitcode'].get('pr_creator')
        if bool(creator_token) != (configured_creator is not None):
            raise BridgeError('Configure both gitcode.pr_creator and BRIDGE_PR_CREATOR_TOKEN')
        creator = self.bot if configured_creator is None else configured_creator
        self.pr_creator = {'id': creator['id'], 'username': creator['username']}
        self.mapping = {item['github']['id']: item['gitcode'] for item in cfg['identities']}
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

        self.creator_api = self.target_api
        if configured_creator is not None:
            self.creator_api = Api('gitcode', creator_token, self.target.repo)
            creator_profile = self.creator_api.request('GET', '/user')
            if not same_account(creator_profile, self.pr_creator):
                raise BridgeError('The PR creator token does not belong to the configured creator')

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

    def author(self, commit):
        if self.mapping:
            source_commit = self.github_api.call('GET', '/commits/' + sha(commit))
            account_id = (source_commit.get('author') or {}).get('id')
            account = self.mapping.get(str(account_id))
            if account is not None:
                self.verify_account(account)
                return account
        return self.bot

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

    def finish_pull(self, store, progress, number=None):
        pending = progress['pending']
        creator = pending.get('creator', self.bot)
        branch = pending['branch']
        label, source_url = self.source_link(pending, progress['cursor'])
        source_line = f'- [{label}]({source_url})'
        if number is None:
            if (creator['id'] != self.pr_creator['id']
                    or creator['username'].casefold() != self.pr_creator['username'].casefold()):
                raise BridgeError('Restore the pending PR creator before creating the missing destination PR')
            created = self.creator_api.call('POST', '/pulls', {
                'title': f'同步 {label}',
                'head': branch,
                'base': MASTER_BRANCH,
                'body': source_line,
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
        body = pull.get('body') or pull.get('description') or ''
        links = [(label, source_url), (f'GitCode PR #{number}', target_url)]
        missing = [f'- [{name}]({url})' for name, url in links if f']({url})' not in body]
        if missing or pull.get('draft'):
            if missing:
                separator = '\n' if body == source_line else '\n\n'
                body = (body + separator if body else '') + '\n'.join(missing)
            updated = self.target_api.call('PATCH', path, {'body': body, 'draft': False})
            published = (updated or {}).get('body') or ''
            if not all(f']({url})' in published for _, url in links):
                raise BridgeError('Could not confirm both links in the destination PR description')

        if not merged:
            if self.git.tip(self.target, self.git.branch_ref(branch)) != pending['head']:
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
        self.git.check_lfs(commits[-1])
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
        head, count = self.rebuild(batch, master, preview=check, alignment=alignment)
        if check:
            return head, count
        branch = f'bridge/github-{cursor[:12]}-{head[:20]}'
        self.git.transfer_lfs(self.source, self.target, cursor)
        self.git.stage(self.target, branch, head)
        pending = {'source': cursor, 'head': head, 'branch': branch, 'github_pull': github_pull,
                   'creator': self.pr_creator, 'alignment': alignment, 'base': master}
        progress = {**progress, 'pending': pending}
        store.save(progress)
        return self.finish_pull(store, progress), count

    def resume(self, store, progress, commits, master, *, check):
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
            return source, master, consumed, 0
        if 'branch' in pending:
            batch = [source] if alignment else commits[:consumed]
            expected, count = self.rebuild(batch, master, preview=check, alignment=alignment)
            number = self.pending_number(pending)
            if expected == pending['head']:
                if check:
                    if self.git.tip(self.target, self.git.branch_ref(pending['branch'])) != expected:
                        raise BridgeError('The destination sync branch differs from the prepared commits')
                    master = expected
                else:
                    master = self.finish_pull(store, progress, number)
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
        progress = store.progress or {'cursor': self.cfg['github'].get('start_from'),
                                      'master': master, 'pending': None}
        if not self.git.is_ancestor(progress['master'], master):
            raise BridgeError('Destination master no longer contains the last confirmed commit')
        cursor = progress['cursor']
        commits = self.git.first_parent_range(source_head, cursor)
        if check:
            status = 'MATCH' if self.git.tree(master) == self.git.tree(source_head) else 'DIFF'
            print(f'LIVE {status} against GitHub {source_head}')
            for account in self.mapping.values():
                self.verify_account(account)
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
        bridge = Bridge(cfg, Git(root / 'import', cfg['lfs']), args.source_repo, bot_token,
                        os.environ.get('BRIDGE_SOURCE_READ_TOKEN'),
                        creator_token=os.environ.get('BRIDGE_PR_CREATOR_TOKEN'))
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
