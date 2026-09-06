# 測試機問題清單

測試對象：`192.168.0.92`（commit `d8b639d`）　測試時間：2026-09-06
測試方式：外部黑箱 HTTP 探測 ＋ 登入後端對端測試 ＋ 對照原始碼確認成因

只列還沒解決的問題。已修好的不再列在這裡：交摺點掃碼答題、登入失敗計數的 Map、
原本 B 節那五個 bug（錯誤狀態碼、API 404 回 HTML、slot_order 重複、
位置上傳沒有範圍檢查、代號無聲截斷），以及權限碼／線索碼分大小寫。

---

## A. 活動當天會出事的

### A1. Portal 的系統連結是佔位網址

`Portal/public/systems.json` 目前是：

```
時空戰爭  -> https://timewarfare.example.com
RPG      -> https://rpg.example.com
```

玩家從入口頁點進去會連到不存在的網域。當天要換成實際的 Cloudflare Tunnel 網址。

---

## B. 部署與維運

### B1. Mods 預覽站不在 deploy workflow 裡

9004 現在是活的，但 `.github/workflows/deploy.yml` 的迴圈只有
`"Time-Space Warfare" "RPG System" Portal PgAdmin`，沒有 Mods。
表示它是在機器上手動 `compose up` 起來的，**之後 push 不會更新它**。
要嘛把 Mods 加進迴圈，要嘛記得手動更新。

### B2. 地圖與掃碼元件是從外部 CDN 載的（活動當天的單點故障）

兩個系統的地圖頁都這樣載 Leaflet：

```html
<link rel="stylesheet" href="https://unpkg.com/leaflet@1.9.4/dist/leaflet.css">
<script src="https://unpkg.com/leaflet@1.9.4/dist/leaflet.js"></script>
```

掃碼頁還另外載 `unpkg.com/html5-qrcode`，QR 列印頁載 `cdnjs.cloudflare.com/qrcodejs`。

圖磚特地自己 host 就是為了當天不依賴外部服務，但畫圖磚的那支函式庫本身還是外部的——
unpkg 慢或被擋，**兩個系統的地圖頁會整頁開不起來**（比圖磚失敗嚴重得多）。
建議把這三個檔案抓下來放進各自的 `public/vendor/`，改成本機路徑。

### B3. 完全沒有安全性標頭

四個服務都沒有 `X-Content-Type-Options`、`X-Frame-Options`、`Content-Security-Policy`、
`Referrer-Policy`。兩個 Node 服務還帶著 `X-Powered-By: Express`。

對內網測試機沒差，但要透過 Cloudflare Tunnel 對外時，至少補上
`X-Frame-Options: DENY`（防止遊戲頁被嵌進別人的 iframe 騙點擊）和 `X-Content-Type-Options: nosniff`。
Express 端加 `helmet` 一行就有，nginx 端加幾個 `add_header`。

### B4. `compose.yml` 會被 9004 對外讀到

Mods 站是把整個資料夾掛給 nginx，所以 `http://…:9004/compose.yml` 讀得到。
裡面沒有任何密碼或金鑰，風險很低，但如果不想露出來，把模板移到 `Mods/public/` 再只掛那層就好。

---

## C. 測試殘留（我留在測試機上的，要清）

### C1. 測試資料

有些是 FK 保護（設計正確）導致刪不掉的，麻煩你要清的話直接進 DB 處理：

**RPG**
- `admin_users` id=4 `claude-test-gk@local.test` — 因為有操作紀錄刪不掉（409，這是對的行為）。
  **已經把密碼改成隨機值，登不進去了**，確認過舊密碼回 401。
- `access_codes` id=1 `CLAUDETEST` — 已被兌換過所以刪不掉（409，也是對的行為）。
- school1：關卡 1 被標記為解鎖＋完成、關卡 2 被標記解鎖、取得線索 1。
- school2：兌換取得線索 3、掃描取得線索 1。
- school1 的最後位置被我上傳成台北車站（測「位置上傳沒有伺服器端範圍檢查」用的，該問題已修）。

**TSW**
- `players` id=8 `claude-tes`（pin 9876）、id=9 `中央大學資訊管理學系`（pin 1111），
  以及各自對應的 `teams` 各一筆。

已成功刪除的：`admin_users` id=5（測試 role 提權用的帳號）。
