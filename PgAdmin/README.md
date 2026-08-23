# PgAdmin

全系統共用的資料庫管理介面。**只給系統管理員本人使用，帳密不釋出給活動工作人員（admin）。**

這是唯一被授權能連到各系統 Postgres db 的地方——每個系統的 `db` container 本身完全不對外開放，只有這個 pgAdmin container 同時加入共用的 `ncumis-camp` 網路（給 Cloudflare Tunnel 連）與各系統各自的私有 internal network（連各自的 db）。

## 啟動順序

**必須先啟動 `Time-Space Warfare/`**（它的 compose 會建立 `timewarfare-internal` 這個 network），再啟動這裡，否則 pgAdmin 會因為找不到 network 而啟動失敗。

```
cp .env.example .env   # 填入真實帳密
docker compose up -d
```

## 之後加入 RPG System / Stock Game 的 db

等那兩個系統各自建好 db 之後，回來這份 `compose.yml` 的 `networks` 區塊多加一條它們的 internal network（例如 `rpg-internal`），並在 `pgadmin` service 底下的 `networks` 清單加上去即可，不需要另外開一個 pgAdmin。
