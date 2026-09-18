"""Portal：活動入口與伺服器端加密的工作人員密碼保管庫。"""
from __future__ import annotations

import json
import mimetypes
import os
import secrets
import threading
import time
from pathlib import Path

from cryptography.fernet import Fernet, InvalidToken

ROOT = Path(__file__).resolve().parent
STATIC = ROOT / 'static'
VAULT_MASTER_PASSWORD = os.getenv('VAULT_MASTER_PASSWORD', '')
VAULT_ENCRYPTION_KEY = os.getenv('VAULT_ENCRYPTION_KEY', '')
VAULT_DATA_PATH = Path(os.getenv('VAULT_DATA_PATH', str(ROOT / 'data' / 'vault.enc')))
MAX_BODY = 256 * 1024
MAX_RECORDS = 200
SESSION_SECONDS = 30 * 60
_sessions: dict[str, float] = {}
_session_lock = threading.Lock()
_data_lock = threading.Lock()


def respond(start_response, status, body, content_type='application/json; charset=utf-8'):
    start_response(status, [('Content-Type', content_type), ('Content-Length', str(len(body))),
                            ('Cache-Control', 'no-store'), ('X-Content-Type-Options', 'nosniff'),
                            ('Referrer-Policy', 'no-referrer')])
    return [body]


def json_response(start_response, status, body):
    return respond(start_response, status, json.dumps(body, ensure_ascii=False).encode('utf-8'))


def read_json(environ):
    try:
        length = int(environ.get('CONTENT_LENGTH') or 0)
    except ValueError:
        length = 0
    if length <= 0 or length > MAX_BODY:
        raise ValueError('invalid request body')
    value = json.loads(environ['wsgi.input'].read(length).decode('utf-8'))
    if not isinstance(value, dict):
        raise ValueError('invalid request body')
    return value


def cipher():
    if not VAULT_ENCRYPTION_KEY:
        raise RuntimeError('VAULT_ENCRYPTION_KEY has not been configured')
    try:
        return Fernet(VAULT_ENCRYPTION_KEY.encode('utf-8'))
    except (ValueError, TypeError) as error:
        raise RuntimeError('VAULT_ENCRYPTION_KEY is invalid') from error


def authenticate(environ):
    header = environ.get('HTTP_AUTHORIZATION', '')
    token = header[7:] if header.startswith('Bearer ') else ''
    now = time.monotonic()
    with _session_lock:
        _sessions.update({key: expiry for key, expiry in _sessions.items() if expiry > now})
        for key, expiry in tuple(_sessions.items()):
            if expiry <= now:
                _sessions.pop(key, None)
        return bool(token and token in _sessions)


def create_session():
    token = secrets.token_urlsafe(32)
    with _session_lock:
        _sessions[token] = time.monotonic() + SESSION_SECONDS
    return token


def text(value, limit):
    return str(value or '').strip()[:limit]


def normalize_records(value):
    if not isinstance(value, list) or len(value) > MAX_RECORDS:
        raise ValueError('invalid records')
    records, ids = [], set()
    for item in value:
        if not isinstance(item, dict):
            raise ValueError('invalid records')
        record_id = text(item.get('id'), 120)
        if not record_id or record_id in ids:
            record_id = secrets.token_urlsafe(16)
        ids.add(record_id)
        platform, password = text(item.get('platform'), 80), text(item.get('password'), 500)
        if not platform or not password:
            raise ValueError('platform and password are required')
        records.append({'id': record_id, 'platform': platform, 'url': text(item.get('url'), 500),
                        'username': text(item.get('username'), 240), 'password': password,
                        'notes': text(item.get('notes'), 1000)})
    return records


def load_records():
    if not VAULT_DATA_PATH.is_file():
        return []
    try:
        payload = cipher().decrypt(VAULT_DATA_PATH.read_bytes())
        return normalize_records(json.loads(payload.decode('utf-8')).get('records', []))
    except (InvalidToken, UnicodeDecodeError, json.JSONDecodeError, ValueError) as error:
        raise RuntimeError('vault data cannot be decrypted') from error


def save_records(records):
    VAULT_DATA_PATH.parent.mkdir(parents=True, exist_ok=True)
    encrypted = cipher().encrypt(json.dumps({'version': 1, 'records': records}, ensure_ascii=False).encode('utf-8'))
    temporary = VAULT_DATA_PATH.with_suffix('.tmp')
    temporary.write_bytes(encrypted)
    temporary.replace(VAULT_DATA_PATH)


def vault_api(environ, start_response, method, path):
    if path == '/api/vault/unlock':
        if method != 'POST':
            return json_response(start_response, '405 Method Not Allowed', {'error': 'method not allowed'})
        try:
            password = read_json(environ).get('password')
        except (ValueError, UnicodeDecodeError, json.JSONDecodeError):
            password = None
        if not VAULT_MASTER_PASSWORD:
            return json_response(start_response, '503 Service Unavailable', {'error': 'VAULT_MASTER_PASSWORD has not been configured'})
        try:
            cipher()
        except RuntimeError as error:
            return json_response(start_response, '503 Service Unavailable', {'error': str(error)})
        if not isinstance(password, str) or not secrets.compare_digest(password, VAULT_MASTER_PASSWORD):
            return json_response(start_response, '401 Unauthorized', {'error': 'invalid master password'})
        return json_response(start_response, '200 OK', {'token': create_session(), 'expiresIn': SESSION_SECONDS})
    if path != '/api/vault/records':
        return json_response(start_response, '404 Not Found', {'error': 'not found'})
    if not authenticate(environ):
        return json_response(start_response, '401 Unauthorized', {'error': 'vault session expired; unlock again'})
    try:
        with _data_lock:
            if method == 'GET':
                return json_response(start_response, '200 OK', {'records': load_records()})
            if method == 'PUT':
                records = normalize_records(read_json(environ).get('records'))
                save_records(records)
                return json_response(start_response, '200 OK', {'records': records})
            if method == 'DELETE':
                if VAULT_DATA_PATH.exists():
                    VAULT_DATA_PATH.unlink()
                return json_response(start_response, '200 OK', {'ok': True})
    except (ValueError, UnicodeDecodeError, json.JSONDecodeError) as error:
        return json_response(start_response, '400 Bad Request', {'error': str(error)})
    except RuntimeError as error:
        return json_response(start_response, '500 Internal Server Error', {'error': str(error)})
    return json_response(start_response, '405 Method Not Allowed', {'error': 'method not allowed'})


def application(environ, start_response):
    method, path = environ.get('REQUEST_METHOD', 'GET'), environ.get('PATH_INFO', '/')
    if method == 'GET' and path == '/health':
        return json_response(start_response, '200 OK', {'ok': True})
    if path.startswith('/api/vault/'):
        return vault_api(environ, start_response, method, path)
    if method != 'GET':
        return json_response(start_response, '405 Method Not Allowed', {'error': 'method not allowed'})
    requested = 'index.html' if path == '/' else path.lstrip('/')
    file_path = (STATIC / requested).resolve()
    if STATIC not in file_path.parents or not file_path.is_file():
        return json_response(start_response, '404 Not Found', {'error': 'not found'})
    return respond(start_response, '200 OK', file_path.read_bytes(), mimetypes.guess_type(str(file_path))[0] or 'application/octet-stream')


if __name__ == '__main__':
    from wsgiref.simple_server import make_server
    port = int(os.getenv('PORT', '8000'))
    print(f'portal listening on {port}')
    make_server('0.0.0.0', port, application).serve_forever()
