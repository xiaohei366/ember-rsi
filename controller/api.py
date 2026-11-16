"""Fixed-origin API requests for the inbound bridge."""

import json
from urllib.error import HTTPError, URLError
from urllib.parse import urlencode
from urllib.request import HTTPRedirectHandler, Request, build_opener


class BridgeError(RuntimeError):
    pass


class ApiError(BridgeError):
    def __init__(self, provider, code):
        super().__init__(f'{"Destination" if provider == "gitcode" else "GitHub"} API request failed (HTTP {code})')


class NoRedirect(HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None


class Api:
    def __init__(self, provider, token, repo):
        self.provider, self.token, self.repo = provider, token, repo
        self.origin = {'github': 'https://api.github.com',
                       'gitcode': 'https://api.gitcode.com/api/v5'}[provider]
        self.opener = build_opener(NoRedirect())

    def request(self, method, path, body=None, **params):
        if not path.startswith('/') or path.startswith('//'):
            raise BridgeError('API path must stay on its configured origin')
        if self.provider == 'github' and (method != 'GET' or body is not None):
            raise BridgeError('The GitHub API connection is read-only')
        address = self.origin + path
        if params:
            address += '?' + urlencode(params)
        headers = {'Accept': 'application/json', 'Content-Type': 'application/json',
                   'User-Agent': 'repository-reader/1.0'}
        if self.token:
            headers['Authorization'] = 'Bearer ' + self.token
        if self.provider == 'github':
            headers.update(Accept='application/vnd.github+json',
                           **{'X-GitHub-Api-Version': '2026-03-10'})
        data = json.dumps(body, ensure_ascii=False).encode('utf-8') if body is not None else None
        try:
            with self.opener.open(Request(address, data, headers, method=method), timeout=30) as response:
                raw = response.read()
                return json.loads(raw) if raw else None
        except HTTPError as error:
            raise ApiError(self.provider, error.code) from None
        except (URLError, OSError, ValueError) as error:
            raise BridgeError(f'Repository API request failed ({type(error).__name__})') from None

    def call(self, method, path='', body=None, **params):
        return self.request(method, '/repos/' + self.repo + path, body, **params)

    def pages(self, path, **params):
        for page in range(1, 1001):
            rows = self.call('GET', path, page=page, per_page=100, **params)
            if not isinstance(rows, list):
                raise BridgeError('Repository API returned an unexpected page')
            yield from rows
            if len(rows) < 100:
                return
        raise BridgeError('Repository API pagination limit reached')
