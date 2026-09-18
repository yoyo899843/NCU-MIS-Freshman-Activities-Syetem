"""Final Scoreboard: public rankings with a password-protected score editor."""
from __future__ import annotations

import hmac
import json
import mimetypes
import os
import secrets
import tempfile
import threading
import time
from datetime import datetime, timezone
from pathlib import Path
from urllib.error import HTTPError, URLError
from urllib.request import Request, urlopen

ROOT = Path(__file__).resolve().parent
PUBLIC = ROOT / 'static'
DEFAULT_SCHOOLS = ['數據鷹學派', '金流獾學派', '系統蛇學派', '邏輯獅學派', '管理狼學派']
SOURCES = {
    'stock': ('STOCK_URL', 'http://stock-app:3000', '/api/market/leaderboard'),
    'rpg': ('RPG_URL', 'http://rpg-app:3000', '/api/scoreboard'),
}
DATA_PATH = Path(os.getenv('SCOREBOARD_DATA_PATH', '/data/scoreboard.json'))
DATA_LOCK = threading.Lock()
SESSIONS: dict[str, float] = {}
SESSION_LOCK = threading.Lock()
SESSION_TTL_SECONDS = 8 * 60 * 60


def json_response(start_response, status, body):
    payload = json.dumps(body, ensure_ascii=False).encode('utf-8')
    start_response(status, [
        ('Content-Type', 'application/json; charset=utf-8'),
        ('Content-Length', str(len(payload))),
        ('Cache-Control', 'no-store'),
        ('X-Content-Type-Options', 'nosniff'),
    ])
    return [payload]


def default_scoreboard():
    return {
        'rows': [
            {'name': name, 'match': '', 'stock': '', 'rpg': '', 'sources': {}}
            for name in DEFAULT_SCHOOLS
        ],
        'updatedAt': None,
    }


def valid_number(value):
    if value in ('', None):
        return ''
    if isinstance(value, bool):
        raise ValueError('分數格式不正確')
    number = float(value)
    if not number == number or abs(number) > 1_000_000_000_000:
        raise ValueError('分數格式不正確')
    return number


def clean_scoreboard(data):
    if not isinstance(data, dict) or not isinstance(data.get('rows'), list) or len(data['rows']) != len(DEFAULT_SCHOOLS):
        raise ValueError('資料格式不正確')
    rows = []
    for index, raw in enumerate(data['rows']):
        if not isinstance(raw, dict):
            raise ValueError('資料格式不正確')
        name = str(raw.get('name', '')).strip()
        if not name or len(name) > 80:
            raise ValueError(f'第 {index + 1} 個學派名稱不正確')
        raw_sources = raw.get('sources') if isinstance(raw.get('sources'), dict) else {}
        rows.append({
            'name': name,
            'match': valid_number(raw.get('match')),
            'stock': valid_number(raw.get('stock')),
            'rpg': valid_number(raw.get('rpg')),
            'sources': {key: 'api' for key in ('stock', 'rpg') if raw_sources.get(key) == 'api'},
        })
    return {'rows': rows, 'updatedAt': data.get('updatedAt') if isinstance(data.get('updatedAt'), str) else None}


def read_scoreboard():
    with DATA_LOCK:
        if not DATA_PATH.is_file():
            return default_scoreboard()
        try:
            return clean_scoreboard(json.loads(DATA_PATH.read_text(encoding='utf-8')))
        except (OSError, json.JSONDecodeError, ValueError):
            return default_scoreboard()


def write_scoreboard(scoreboard):
    with DATA_LOCK:
        DATA_PATH.parent.mkdir(parents=True, exist_ok=True)
        fd, temp_path = tempfile.mkstemp(prefix='.scoreboard-', suffix='.json', dir=DATA_PATH.parent)
        try:
            with os.fdopen(fd, 'w', encoding='utf-8') as file:
                json.dump(scoreboard, file, ensure_ascii=False, separators=(',', ':'))
                file.flush()
                os.fsync(file.fileno())
            os.replace(temp_path, DATA_PATH)
        finally:
            if os.path.exists(temp_path):
                os.unlink(temp_path)


def admin_credentials():
    return os.getenv('SCOREBOARD_ADMIN_USERNAME', ''), os.getenv('SCOREBOARD_ADMIN_PASSWORD', '')


def issue_session():
    token = secrets.token_urlsafe(32)
    now = time.time()
    with SESSION_LOCK:
        SESSIONS[token] = now + SESSION_TTL_SECONDS
        for old_token, expires_at in list(SESSIONS.items()):
            if expires_at <= now:
                del SESSIONS[old_token]
    return token


def token_from_request(environ):
    value = environ.get('HTTP_AUTHORIZATION', '')
    return value[7:] if value.startswith('Bearer ') else ''


def is_authenticated(environ):
    token = token_from_request(environ)
    if not token:
        return False
    with SESSION_LOCK:
        expires_at = SESSIONS.get(token, 0)
        if expires_at <= time.time():
            SESSIONS.pop(token, None)
            return False
        return True


def revoke_session(environ):
    token = token_from_request(environ)
    if token:
        with SESSION_LOCK:
            SESSIONS.pop(token, None)


def request_json(environ):
    try:
        length = int(environ.get('CONTENT_LENGTH') or 0)
    except ValueError:
        raise ValueError('Content-Length 不正確')
    if length < 1 or length > 100_000:
        raise ValueError('請求內容不正確')
    try:
        return json.loads(environ['wsgi.input'].read(length).decode('utf-8'))
    except (UnicodeDecodeError, json.JSONDecodeError):
        raise ValueError('JSON 格式不正確')


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
    if source == 'stock':
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
    if method == 'GET' and path == '/api/scoreboard':
        return json_response(start_response, '200 OK', read_scoreboard())

    if method == 'POST' and path == '/api/admin/login':
        try:
            body = request_json(environ)
        except ValueError as err:
            return json_response(start_response, '400 Bad Request', {'error': str(err)})
        expected_username, expected_password = admin_credentials()
        if not expected_username or not expected_password:
            return json_response(start_response, '503 Service Unavailable', {'error': '尚未設定管理帳號或密碼'})
        username = str(body.get('username', '')) if isinstance(body, dict) else ''
        password = str(body.get('password', '')) if isinstance(body, dict) else ''
        if not (hmac.compare_digest(username, expected_username) and hmac.compare_digest(password, expected_password)):
            return json_response(start_response, '401 Unauthorized', {'error': '帳號或密碼錯誤'})
        return json_response(start_response, '200 OK', {'token': issue_session()})

    if path.startswith('/api/admin/') or path.startswith('/api/source/'):
        if not is_authenticated(environ):
            return json_response(start_response, '401 Unauthorized', {'error': '請先登入管理後台'})
        if method == 'POST' and path == '/api/admin/logout':
            revoke_session(environ)
            return json_response(start_response, '200 OK', {'ok': True})
        if method == 'GET' and path == '/api/admin/session':
            return json_response(start_response, '200 OK', {'ok': True})
        if method == 'GET' and path == '/api/admin/scoreboard':
            return json_response(start_response, '200 OK', read_scoreboard())
        if method == 'PUT' and path == '/api/admin/scoreboard':
            try:
                body = clean_scoreboard(request_json(environ))
                body['updatedAt'] = datetime.now(timezone.utc).isoformat()
                write_scoreboard(body)
            except ValueError as err:
                return json_response(start_response, '400 Bad Request', {'error': str(err)})
            except OSError:
                return json_response(start_response, '500 Internal Server Error', {'error': '無法儲存分數'})
            return json_response(start_response, '200 OK', body)
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
            except Exception:
                return json_response(start_response, '502 Bad Gateway', {'error': f'載入 {source} API 失敗'})
        return json_response(start_response, '404 Not Found', {'error': 'not found'})

    if method != 'GET':
        return json_response(start_response, '405 Method Not Allowed', {'error': 'method not allowed'})
    requested = 'index.html' if path == '/' else path.lstrip('/')
    file_path = (PUBLIC / requested).resolve()
    if PUBLIC not in file_path.parents or not file_path.is_file():
        return json_response(start_response, '404 Not Found', {'error': 'not found'})
    content = file_path.read_bytes()
    content_type = mimetypes.guess_type(str(file_path))[0] or 'application/octet-stream'
    start_response('200 OK', [('Content-Type', content_type), ('Content-Length', str(len(content))),
                              ('Cache-Control', 'no-store'), ('X-Content-Type-Options', 'nosniff')])
    return [content]


if __name__ == '__main__':
    from wsgiref.simple_server import make_server
    port = int(os.getenv('PORT', '8000'))
    print(f'final-scoreboard listening on {port}')
    make_server('0.0.0.0', port, application).serve_forever()
