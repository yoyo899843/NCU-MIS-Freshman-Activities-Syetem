"""Match Competition：記錄五學派對抗賽（A／B 隊勝平負）結果，並提供 API 給總積分榜直接讀取。

這個服務只負責「結果」本身；結果要換算成多少分，是總積分榜（Final Scoreboard）的事。
兩邊分開，改計分規則不用動這裡，改對抗賽的輸入方式也不用動計分。

API
  GET  /api/results        回傳每個學派 A、B 兩隊的結果（win／draw／lose／空字串＝未結算）
  PUT  /api/results        整份覆寫成績
  GET  /health             健康檢查

不需要登入或金鑰：打得到這個服務的人都能看、也都能改。

只用 Python 標準函式庫（跟 Final Scoreboard 一樣），image 不用裝任何套件。
"""
from __future__ import annotations

import json
import mimetypes
import os
import tempfile
import threading
from datetime import datetime, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parent
STATIC = ROOT / 'static'
DATA_FILE = Path(os.getenv('DATA_FILE', str(ROOT / 'data' / 'results.json')))

# 跟總積分榜的預設學派名稱一致：總積分榜是用名稱把兩邊的資料對起來的
DEFAULT_SCHOOLS = ['數據鷹學派', '金流獾學派', '系統蛇學派', '邏輯獅學派', '管理狼學派']
RESULTS = {'', 'win', 'draw', 'lose'}
MAX_SCHOOLS = 20
MAX_NAME = 30
MAX_BODY = 64 * 1024

_lock = threading.Lock()


def _default_data():
    return {'schools': [{'name': name, 'a': '', 'b': ''} for name in DEFAULT_SCHOOLS], 'updatedAt': None}


def load_data():
    try:
        with DATA_FILE.open(encoding='utf-8') as f:
            data = json.load(f)
        if isinstance(data.get('schools'), list):
            return data
    except FileNotFoundError:
        pass
    except (OSError, ValueError) as err:
        # 檔案壞掉時不要讓整個服務掛掉，但要在 log 留下痕跡，才知道成績為什麼不見
        print(f'讀取 {DATA_FILE} 失敗，改用預設資料：{err}')
    return _default_data()


def save_data(data):
    # 先寫暫存檔再改名：寫到一半當機也不會留下一個只寫了一半、讀不回來的檔案
    DATA_FILE.parent.mkdir(parents=True, exist_ok=True)
    fd, tmp = tempfile.mkstemp(dir=DATA_FILE.parent, prefix='.results-', suffix='.json')
    with os.fdopen(fd, 'w', encoding='utf-8') as f:
        json.dump(data, f, ensure_ascii=False, indent=2)
    os.replace(tmp, DATA_FILE)


def validate(body):
    """回傳 (乾淨的 schools, None) 或 (None, 錯誤訊息)。"""
    schools = body.get('schools') if isinstance(body, dict) else None
    if not isinstance(schools, list) or not schools:
        return None, 'schools 必須是非空陣列'
    if len(schools) > MAX_SCHOOLS:
        return None, f'學派最多 {MAX_SCHOOLS} 個'
    clean, seen = [], set()
    for i, s in enumerate(schools, 1):
        if not isinstance(s, dict):
            return None, f'第 {i} 筆格式錯誤'
        name = str(s.get('name', '')).strip()
        if not name:
            return None, f'第 {i} 筆的學派名稱不可為空'
        if len(name) > MAX_NAME:
            return None, f'「{name}」超過 {MAX_NAME} 個字'
        if name in seen:
            return None, f'學派名稱「{name}」重複了'
        seen.add(name)
        a, b = s.get('a', ''), s.get('b', '')
        if a not in RESULTS or b not in RESULTS:
            return None, f'「{name}」的結果只能是 win／draw／lose 或空白'
        clean.append({'name': name, 'a': a, 'b': b})
    return clean, None


def respond(start_response, status, body=None, public=False):
    headers = [('Cache-Control', 'no-store')]
    if public:
        # 開放任何網域直接呼叫（總積分榜或其他頁面）
        headers += [('Access-Control-Allow-Origin', '*'),
                    ('Access-Control-Allow-Methods', 'GET, PUT, OPTIONS'),
                    ('Access-Control-Allow-Headers', 'Content-Type')]
    if body is None:
        start_response(status, headers)
        return [b'']
    payload = json.dumps(body, ensure_ascii=False).encode('utf-8')
    headers += [('Content-Type', 'application/json; charset=utf-8'), ('Content-Length', str(len(payload)))]
    start_response(status, headers)
    return [payload]


def application(environ, start_response):
    method = environ.get('REQUEST_METHOD', 'GET')
    path = environ.get('PATH_INFO', '/')

    if path == '/health' and method == 'GET':
        return respond(start_response, '200 OK', {'ok': True})

    if path == '/api/results':
        if method == 'GET':
            with _lock:
                return respond(start_response, '200 OK', load_data(), public=True)
        if method == 'OPTIONS':
            return respond(start_response, '204 No Content', public=True)
        if method != 'PUT':
            return respond(start_response, '405 Method Not Allowed', {'error': 'method not allowed'})
        try:
            length = int(environ.get('CONTENT_LENGTH') or 0)
        except ValueError:
            length = 0
        if length <= 0 or length > MAX_BODY:
            return respond(start_response, '400 Bad Request', {'error': '內容是空的或太大'})
        try:
            body = json.loads(environ['wsgi.input'].read(length).decode('utf-8'))
        except (ValueError, UnicodeDecodeError):
            return respond(start_response, '400 Bad Request', {'error': '內容不是合法的 JSON'})
        schools, error = validate(body)
        if error:
            return respond(start_response, '400 Bad Request', {'error': error})
        data = {'schools': schools, 'updatedAt': datetime.now(timezone.utc).isoformat()}
        with _lock:
            save_data(data)
        return respond(start_response, '200 OK', data, public=True)

    if method != 'GET':
        return respond(start_response, '405 Method Not Allowed', {'error': 'method not allowed'})
    requested = 'index.html' if path == '/' else path.lstrip('/')
    file_path = (STATIC / requested).resolve()
    if STATIC not in file_path.parents or not file_path.is_file():
        return respond(start_response, '404 Not Found', {'error': 'not found'})
    content = file_path.read_bytes()
    content_type = mimetypes.guess_type(str(file_path))[0] or 'application/octet-stream'
    start_response('200 OK', [('Content-Type', content_type), ('Content-Length', str(len(content))),
                              ('Cache-Control', 'no-store')])
    return [content]


if __name__ == '__main__':
    from wsgiref.simple_server import make_server
    port = int(os.getenv('PORT', '8000'))
    print(f'match-competition listening on {port}，成績檔：{DATA_FILE}')
    make_server('0.0.0.0', port, application).serve_forever()
