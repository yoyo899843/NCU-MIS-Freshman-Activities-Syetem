"""Final Scoreboard: aggregate the four activities into one public board."""
from __future__ import annotations

import json
import mimetypes
import os
from pathlib import Path
from urllib.error import HTTPError, URLError
from urllib.request import Request, urlopen

ROOT = Path(__file__).resolve().parent
PUBLIC = ROOT / 'static'
SOURCES = {
    # 對抗賽成績在獨立的 Match Competition 服務；這裡只讀結果，換算成分數仍由總積分榜負責
    'match': ('MATCH_URL', 'http://match-competition-app:8000', '/api/results'),
    'stock': ('STOCK_URL', 'http://stock-app:3000', '/api/market/leaderboard'),
    'territory': ('TIMEWARFARE_URL', 'http://timewarfare-app:3000', '/api/scores'),
    'rpg': ('RPG_URL', 'http://rpg-app:3000', '/api/scoreboard'),
}


def json_response(start_response, status, body):
    payload = json.dumps(body, ensure_ascii=False).encode('utf-8')
    start_response(status, [('Content-Type', 'application/json; charset=utf-8'),
                            ('Content-Length', str(len(payload))), ('Cache-Control', 'no-store')])
    return [payload]


def load_source(source):
    if source not in SOURCES:
        raise ValueError('unknown source')
    env_name, default_url, endpoint = SOURCES[source]
    base_url = os.getenv(env_name, default_url).rstrip('/')
    request = Request(base_url + endpoint, headers={'Accept': 'application/json'})
    with urlopen(request, timeout=8) as response:
        if response.status != 200:
            raise RuntimeError(f'upstream returned HTTP {response.status}')
        data = json.loads(response.read().decode('utf-8'))

    if source == 'match':
        # 對抗賽回的是勝平負而不是分數，原樣交給前端，讓它照自己的計分規則換算
        entries = [{'name': row.get('name', ''), 'a': row.get('a', ''), 'b': row.get('b', '')}
                   for row in data.get('schools', [])]
    elif source == 'stock':
        entries = [{'name': row.get('name', ''), 'score': row.get('total', 0), 'rank': row.get('rank')}
                   for row in data.get('teams', [])]
    elif source == 'territory':
        entries = [{'name': row.get('name', ''), 'score': row.get('total', 0), 'rank': row.get('rank')}
                   for row in data.get('teams', [])]
    else:
        entries = [{'name': row.get('displayName', ''), 'score': row.get('totalScore', 0), 'rank': index + 1}
                   for index, row in enumerate(data)]
    return {'source': source, 'entries': entries}


def application(environ, start_response):
    method = environ.get('REQUEST_METHOD', 'GET')
    path = environ.get('PATH_INFO', '/')
    if method == 'GET' and path == '/health':
        return json_response(start_response, '200 OK', {'ok': True})
    if method == 'GET' and path.startswith('/api/source/'):
        source = path.rsplit('/', 1)[-1]
        try:
            return json_response(start_response, '200 OK', load_source(source))
        except ValueError:
            return json_response(start_response, '404 Not Found', {'error': 'unknown source'})
        except HTTPError as err:
            return json_response(start_response, '502 Bad Gateway', {'error': f'{source} API 回傳 HTTP {err.code}'})
        except (URLError, TimeoutError) as err:
            return json_response(start_response, '502 Bad Gateway', {
                'error': f'無法連線到 {source} API：{getattr(err, "reason", str(err))}'
            })
        except Exception as err:  # Do not expose a traceback to a public scoreboard.
            return json_response(start_response, '502 Bad Gateway', {'error': f'載入 {source} API 失敗：{err}'})

    if method != 'GET':
        return json_response(start_response, '405 Method Not Allowed', {'error': 'method not allowed'})
    requested = 'index.html' if path == '/' else path.lstrip('/')
    file_path = (PUBLIC / requested).resolve()
    if PUBLIC not in file_path.parents or not file_path.is_file():
        return json_response(start_response, '404 Not Found', {'error': 'not found'})
    content = file_path.read_bytes()
    content_type = mimetypes.guess_type(str(file_path))[0] or 'application/octet-stream'
    start_response('200 OK', [('Content-Type', content_type), ('Content-Length', str(len(content))),
                              ('Cache-Control', 'no-store')])
    return [content]


if __name__ == '__main__':
    from wsgiref.simple_server import make_server
    port = int(os.getenv('PORT', '8000'))
    print(f'final-scoreboard listening on {port}')
    make_server('0.0.0.0', port, application).serve_forever()
