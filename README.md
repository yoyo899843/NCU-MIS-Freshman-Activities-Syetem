# NCUMIS Camp

校園大地對抗遊戲活動系統。共有 4 個獨立子系統，各自一個資料夾、各自的 `compose.yml`、各自的 Postgres DB，彼此不共用、不耦合：

- `Portal/` — 玩家入口頁（連結 + 公告），純靜態，無登入無資料庫。
- `Time-Space Warfare/` — 時空修復者 / 時空破壞者對抗遊戲（唯一目前有完整玩法規格並實際搭建的系統）。
- `RPG System/`、`Stock Game/` — 尚未開發，目前是空資料夾。
- `PgAdmin/` — 全系統共用的資料庫管理介面，只給系統管理員本人使用，不釋出給活動工作人員（admin）帳號。

## 啟動前置作業

所有系統的 app 與 PgAdmin 都掛在同一個共用的 external Docker network 上，方便之後手動設定的 Cloudflare Tunnel 連進來。**只需要建立一次**：

```
docker network create ncumis-camp
```

各系統的 `db` container 不會加入這個共用網路,只在各自系統私有的 internal network 內跟 app / PgAdmin 溝通,不會被外部連到。

## 啟動各系統

每個資料夾各自獨立 `docker compose up`,例如:

```
cd "Time-Space Warfare"
cp .env.example .env   # 填入實際密碼後再啟動
docker compose up -d
```

`Portal/`、`PgAdmin/` 也是一樣的流程。

## Port 配置

對外 host port 從 9000 開始編號:

| 服務 | Host Port |
|---|---|
| Portal | 9000 |
| Time-Space Warfare app | 9001 |
| PgAdmin | 9002 |
| RPG System app(未來) | 9003 |
| Stock Game app(未來) | 9004 |

## Cloudflare Tunnel

Tunnel 本身由使用者在 Cloudflare dashboard 手動建立與設定 ingress rule,本 repo 不包含 tunnel 設定。建議每個服務對應一個子網域(而非路徑前綴),可避免 WebSocket 在路徑改寫時的問題。

## Admin 帳號

每個活動系統(Time-Space Warfare 等)的 `/admin` 後台帳號,一律由系統管理員在伺服器上執行該系統資料夾內的 `node scripts/create-admin.js` 建立,沒有任何 HTTP 端點可以新增帳號。PgAdmin 的帳密則只有系統管理員本人持有,不對外流通。
