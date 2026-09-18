"""Portal：活動入口頁。網址內容由 static/config.js 管理，不需要資料庫。"""
from __future__ import annotations

import mimetypes
import os
from pathlib import Path

ROOT = Path(__file__).resolve().parent
STATIC = ROOT / 'static'


def respond(start_response, status, body, content_type='application/json; charset=utf-8'):
    start_response(status, [('Content-Type', content_type), ('Content-Length', str(len(body))),
                            ('Cache-Control', 'no-store')])
    return [body]


def application(environ, start_response):
    method = environ.get('REQUEST_METHOD', 'GET')
    path = environ.get('PATH_INFO', '/')
    if method == 'GET' and path == '/health':
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
