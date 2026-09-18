"""Portal：活動入口頁。網址內容由 static/config.js 管理，不需要資料庫。"""
from __future__ import annotations

import hmac
import json
import mimetypes
import os
import threading
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parent
STATIC = ROOT / 'static'
VAULT_MASTER_PASSWORD = os.getenv('VAULT_MASTER_PASSWORD', '')
MAX_VAULT_LOGIN_BODY = 2048
MAX_VAULT_FAILURES = 5
VAULT_FAILURE_WINDOW_SECONDS = 10 * 60
VAULT_LOCK_SECONDS = 5 * 60
_vault_failures = {}
_vault_lock = threading.Lock()


def respond(start_response, status, body, content_type='application/json; charset=utf-8'):
    start_response(status, [('Content-Type', content_type), ('Content-Length', str(len(body))),
                            ('Cache-Control', 'no-store'), ('X-Content-Type-Options', 'nosniff'),
                            ('Referrer-Policy', 'no-referrer')])
    return [body]


def vault_locked(client_ip):
    """在記憶體中限制連續猜測；服務重啟後自然清空。"""
    now = time.monotonic()
    with _vault_lock:
        failures = [stamp for stamp in _vault_failures.get(client_ip, [])
                    if now - stamp < VAULT_FAILURE_WINDOW_SECONDS]
        _vault_failures[client_ip] = failures
        return len(failures) >= MAX_VAULT_FAILURES and now - failures[-1] < VAULT_LOCK_SECONDS


def record_vault_failure(client_ip):
    now = time.monotonic()
    with _vault_lock:
        failures = [stamp for stamp in _vault_failures.get(client_ip, [])
                    if now - stamp < VAULT_FAILURE_WINDOW_SECONDS]
        failures.append(now)
        _vault_failures[client_ip] = failures


def clear_vault_failures(client_ip):
    with _vault_lock:
        _vault_failures.pop(client_ip, None)


def application(environ, start_response):
    method = environ.get('REQUEST_METHOD', 'GET')
    path = environ.get('PATH_INFO', '/')
    if method == 'GET' and path == '/health':
        return respond(start_response, '200 OK', b'{"ok":true}')
    if path == '/api/vault/unlock':
        if method != 'POST':
            return respond(start_response, '405 Method Not Allowed', b'{"error":"method not allowed"}')
        if not VAULT_MASTER_PASSWORD:
            return respond(start_response, '503 Service Unavailable',
                           b'{"error":"VAULT_MASTER_PASSWORD has not been configured"}')
        client_ip = environ.get('REMOTE_ADDR', 'unknown')
        if vault_locked(client_ip):
            return respond(start_response, '429 Too Many Requests',
                           b'{"error":"too many failed attempts; try again later"}')
        try:
            content_length = int(environ.get('CONTENT_LENGTH') or 0)
        except ValueError:
            content_length = 0
        if content_length <= 0 or content_length > MAX_VAULT_LOGIN_BODY:
            return respond(start_response, '400 Bad Request', b'{"error":"invalid request body"}')
        try:
            body = json.loads(environ['wsgi.input'].read(content_length).decode('utf-8'))
            password = body.get('password') if isinstance(body, dict) else None
        except (UnicodeDecodeError, ValueError):
            password = None
        if not isinstance(password, str) or not hmac.compare_digest(password, VAULT_MASTER_PASSWORD):
            record_vault_failure(client_ip)
            return respond(start_response, '401 Unauthorized', b'{"error":"invalid master password"}')
        clear_vault_failures(client_ip)
        return respond(start_response, '200 OK', b'{"ok":true}')
    if method != 'GET':
        return respond(start_response, '405 Method Not Allowed', b'{"error":"method not allowed"}')

    requested = 'index.html' if path == '/' else path.lstrip('/')
    file_path = (STATIC / requested).resolve()
    if STATIC not in file_path.parents or not file_path.is_file():
        return respond(start_response, '404 Not Found', b'{"error":"not found"}')
    content = file_path.read_bytes()
    content_type = mimetypes.guess_type(str(file_path))[0] or 'application/octet-stream'
    return respond(start_response, '200 OK', content, content_type)


if __name__ == '__main__':
    from wsgiref.simple_server import make_server
    port = int(os.getenv('PORT', '8000'))
    print(f'portal listening on {port}')
    make_server('0.0.0.0', port, application).serve_forever()
