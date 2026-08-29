# NCUMIS Camp — 多系統基礎設施架構規劃

## Context

這是校園大地對抗遊戲活動的基礎設施規劃。整個活動當天共有 4 個獨立子系統：
`Portal`（入口頁）、`RPG System`、`Stock Game`、`Time-Space Warfare`（時空修復者/破壞者，本次唯一有完整玩法規格的系統：9 個交摺點知識問答修復/破壞、雙陣營 PK、即時隊伍位置、最終積分公布）。

目前 repo 現況（已確認）：
- 根目錄原本的 `compose.yml` 已在工作目錄中被刪除（尚未 commit）。
- `Portal/compose.yml` 已建立但是空檔。
- `RPG System/`、`Stock Game/`、`Time-Space Warfare/` 皆為空資料夾。

系統需求：Docker 部署、Cloudflare Tunnel 對外、需支援 realtime（WebSocket）、單一系統同時上線約 80-120 人。經過多輪討論收斂出以下架構決策，本計畫是把這些決策落地成**基礎設施骨架**（scaffold），不含遊戲玩法/題庫等功能邏輯的完整實作（那部分規格只有 Time-Space Warfare 有，且工作量遠超本次基礎設施範圍，留待後續單獨規劃）。

**本次執行範圍已縮小**：
- Cloudflare Tunnel 由使用者自行在 CF dashboard 手動設定，本計畫不建立 `Tunnel/` 資料夾、不管 tunnel/ingress 設定。
- `RPG System/`、`Stock Game/` 維持空資料夾，本次不建立任何骨架內容。
- 本次只實際搭建 `Portal/`、`Time-Space Warfare/`、以及新增的 `PgAdmin/`（全系統共用、只給使用者本人用）。
- **UI 不做設計**：所有頁面（Portal 入口頁、Time-Space Warfare 的玩家端頁面/`/admin` 後台頁面）本輪只用最簡單、能看懂操作的 CSS（陽春表單/按鈕/清單即可），不做視覺設計、不用 UI 框架/元件庫，重點放在功能骨架與 API 是否串得起來。

## Time-Space Warfare 遊戲規格摘要

使用者提供的完整玩法規格（供本回合設計資料庫/API 時參考，**實際遊戲邏輯本身不在本回合實作範圍**）：

- **陣營與分隊（規格已更新，見下方「玩家登入模式變更」）**：目前規則改為一支隊伍只用一支手機登入 → 隨機平均分發至「時空修復者」/「時空破壞者」兩陣營，隊伍上限 20 支。身分驗證用 Token（存 LocalStorage，重整不登出）+ 代號/PIN 可在掉線後找回身份。
- **9 個交摺點**：各點有關主 + 實體 QR Code。玩家個別掃碼挑戰，隨機抽 3~5 題選擇題、每題限時 10 秒，得分＝基礎分＋剩餘時間加權，答錯 0 分。該次總分轉為「修復值」或「破壞值」（依玩家陣營）累加到該交摺點。系統需記錄每支小隊「最近一次得分的關卡與分值」（供 PK 懲罰扣除用）。
- **PK 對戰**：兩陣營玩家現場相遇，一人開房間（產生 6 碼房號 + QR），另一人加入，雙方進即時同步房間答題，答對題數＋作答速度定勝負。敗方所屬小隊「最近一次得分的交摺點」分數全數歸零（若尚未得過分則不扣分但留紀錄）。敗方獲得 3 分鐘 PK 保護期。
- **即時地圖**：顯示 9 個點的即時修復值 vs 破壞值與領先陣營，僅同隊隊友之間可見彼此 GPS 座標，看不到敵方。
- **前端頁面**：登入頁（抽卡動畫）、大地圖頁（Leaflet + OpenStreetMap，見下方「地圖 Tile 方案」）、QR 掃碼+知識王答題頁（html5-qrcode）、PK 對戰頁（房主開房/雙方對戰/結算警示動畫）、大會投影 Dashboard（全螢幕戰況、倒數、一鍵最終結算）。
- **後台管理**：`/admin/login` 專屬入口，一般玩家 Token 完全無法碰後台 API。功能包含：交摺點 CRUD（含地圖點選座標、自動產生 `qr_token`、匯出/列印 QR Code、手動歸零重置）；題庫管理 CRUD（題目歸屬「特定關卡／PK 專用／通用」三種、CSV/Excel 批次匯入）；遊戲進程控制（未開始/進行中/強制結束結算）；戰況覆寫（手動增減隊伍分數、取消某次 PK 扣分懲罰）。

**地圖 Tile 方案（下一輪實作地圖功能時採用，本輪骨架不受影響）**：不用 Mapbox（要 API key、超額計費），改用 Leaflet + OpenStreetMap。且**自行 host 校園範圍的 tile 圖磚**，不即時連公開的 OSM tile server：
- 活動前先依 9 個交摺點的 `map_lat`/`map_lng`（外加安全邊界）算出校園範圍的 bounding box，只下載這個範圍、遊戲會用到的 zoom 等級（例如 15~19 級）對應的 `{z}/{x}/{y}.png` 圖磚，存進 `Time-Space Warfare/public/tiles/`。
- Leaflet 的 `L.tileLayer` 指向自己的 `/tiles/{z}/{x}/{y}.png` 路徑，不對外連 OpenStreetMap 官方 tile server。
- 好處：玩家端不用下載超出校園範圍的地圖資料（省流量）、活動當天完全不依賴外部網路服務（不會因為 OSM tile server 限流/當機而影響遊戲）。
- 校園實際 bounding box 座標要等交摺點的真實 GPS 座標定案後才能算，下一輪實作時再產生 tile 集合。

## 資料庫 Schema 設計（`Time-Space Warfare/migrations/001_init.sql`）

本回合會把下列 schema 實際寫成 migration 執行起來（純資料結構，不含業務邏輯）：

- `teams`：id, faction(repair/disrupt), team_number, name, last_checkpoint_attempt_id(FK, 供 PK 懲罰查詢用), pk_protected_until(timestamp, PK 保護期), created_at
- `players`：id, team_id(FK), display_name, is_captain, created_at
- `checkpoints`：id, name, map_lat, map_lng, qr_token(unique), repair_value, disrupt_value, created_at, updated_at
- `questions`：id, scope_type(checkpoint/pk/general), checkpoint_id(FK, nullable), content, option_a~d, correct_option, time_limit_seconds, created_at
- `checkpoint_attempts`：id, checkpoint_id(FK), player_id(FK), team_id(FK), faction(snapshot), correct_count, total_score, created_at
- `pk_duels`：id(**UUID**，避免對外暴露連續整數猜得到其他場次)、room_code(6碼，玩家看到/輸入用)、qr_token, host_player_id(FK), guest_player_id(FK, nullable), status(waiting/active/completed), winner_player_id, loser_player_id, penalty_checkpoint_attempt_id(FK, nullable), penalty_amount, created_at, completed_at
- `pk_duel_answers`：id, pk_duel_id(FK), player_id(FK), correct_count, total_time_ms
- `admin_users`：id, email, password_hash, display_name, created_at
- `admin_actions`：id, admin_user_id(FK), action_type, target_type, target_id, before_value(jsonb), after_value(jsonb), created_at（稽核記錄，對應戰況覆寫需求）
- `game_state`：單列表，status(not_started/in_progress/ended), started_at, ended_at

**刻意不建的表**：即時 GPS 定位不落地到 DB（只在 Socket.IO 房間內即時廣播給同隊成員，不寫入資料庫），避免高頻寫入炸資料庫；PK 對戰過程中的題目/計時同步狀態也只存在記憶體/Socket.IO 房間，不逐題寫 DB，只在結算時把最終結果寫進 `pk_duel_answers`。

## API 設計

**狀態更新**：玩家登入（`/api/auth/join`、`/api/me`）與 **PK 對戰全流程已實際完成並通過端對端測試**（見下方「PK 對戰 — 實作完成」）。其餘玩家端路由（checkpoint 挑戰、地圖資料）與 admin 的 checkpoint/題庫/遊戲控制/戰況覆寫 API 仍是 stub（回傳 501），留待後續開發。

**玩家端 REST**：`POST /api/auth/join`（登入分隊，✅ 已實作）、`GET /api/me`（✅ 已實作）、`GET /api/map/checkpoints`（stub）、`POST /api/checkpoints/:qrToken/challenge`（stub）、`POST /api/checkpoints/challenge/:id/answer`（stub）。

**PK REST + WebSocket**（✅ 已實作）：`POST /api/pk/create`（回傳 `duelId`(UUID) + `roomCode`(6碼) + `qrToken`）、`POST /api/pk/join`（用 `roomCode` 或 `qrToken` 找到對應的 `duelId`）。伺服器記憶體中維護一份 `roomCode → duelId` 的對照表（`src/pk/roomRegistry.js`，5 分鐘未配對自動失效），配對成功會從表中移除。

**Socket.IO 頻道設計（單一 namespace + room）**（PK 部分 ✅ 已實作，team 部分待下一輪）：
- 玩家連線後 emit `pk:enter` { duelId, token }，伺服器驗證 JWT 後 `socket.join('duel:' + duelId)`。雙方都進場後，`src/pk/session.js` 開始逐題推送 `pk:question`，伺服器端計時、判定正確率與作答速度，全程不落地到 DB，只在對戰結束當下寫入最終結果。
- `checkpoint:update`、`game:state` 這類全場都要看到的資訊，伺服器直接 `io.emit(...)`（不指定 room），PK 扣分造成 checkpoint 分數變動時已經會觸發 `checkpoint:update` 廣播。
- `team:<teamId>` 同隊私密頻道（地圖定位）尚未實作，留待下一輪。

**Admin REST**（`/admin/api/*`，掛 JWT middleware）：`POST /admin/api/login`（✅ 已實作，簽發 `role: 'admin'` 的 JWT）；其餘 checkpoint/題庫/遊戲控制/戰況覆寫端點仍是 stub。

## PK 對戰 — 實作完成

完整實作了小隊配對、即時同步答題、勝負判定、扣分懲罰、保護期，並用 `socket.io-client` 寫測試腳本跑過端對端驗證（含刻意讓某一方輸掉、確認扣分金額與保護期都正確寫回 DB）。

- **玩家登入**（`src/routes/auth.js`）：`POST /api/auth/join` 依目前兩陣營人數做平均分發（人少的陣營優先，平手隨機），塞進一個未滿 4 人的小隊或開新隊，簽發 `role: 'player'` 的 JWT。代號/姓名限制 10 個字，不論中英——用 `Array.from(str)` 而不是直接 `slice()` 去算長度，避免萬一遇到 emoji 之類的字元被從中間切一半（中英文本身不會有這問題，這樣寫單純是比較保險）；`public/login.html` 的輸入框也同步加了 `maxlength="10"`。已測過中文超過 10 字、英文超過 10 字都正確截到剛好 10 個字。
- **開房/加入**（`src/routes/pk.js`）：驗證發起方/加入方所屬小隊沒有在 PK 保護期內、加入方跟房主不同陣營、不能自己加入自己開的房。配對成功後呼叫 `src/pk/session.js` 建立對戰 session（從 `questions` 表 `scope_type='pk'` 隨機抽 5 題）。
- **即時對戰**（`src/pk/session.js` + `src/sockets/index.js`）：伺服器端權威計時——送出題目時記錄時間戳，玩家答題時算出實際耗時；題目時限到了但有人沒答，強制計為答錯＋滿時限（優雅降級，不會卡住整場對戰）；雙方都答完當題就立刻進下一題。全部題目結束後，依「答對題數（多者勝）→ 答題總耗時（快者勝）」判定勝負。
- **選項隨機排序**（`shuffleOptions`）：資料庫的 A/B/C/D 只是儲存用的固定欄位，不是玩家畫面上看到的順序——每次抽到一題，當場洗牌決定這次要顯示的順序，並記住「洗牌後真正正確的按鈕是哪一個」（`correctDisplayLabel`），同一題目在同一場對戰裡不管送幾次（含斷線重連補送）都用同一份洗牌結果。已用測試腳本驗證：同一題在不同場次的顯示順序真的會變、正確答案有時落在 A 有時落在別的位置，而且不管落在哪個位置，答對/答錯的判定都正確跟著走。
- **結算與扣分**（`src/pk/session.js` 的 `finishDuel`）：在一個 DB transaction 裡寫入 `pk_duel_answers`、查敗方小隊 `last_checkpoint_attempt_id` 找到最近一次得分的交摺點，把該筆分數從對應的 `repair_value`/`disrupt_value` 扣除（沒有得過分則不扣，只記錄）、更新 `pk_duels` 最終狀態、把敗方小隊的 `pk_protected_until` 設為 3 分鐘後。全部成功才 commit，任何一步失敗就整個 rollback。
- **安全性補強**：實作過程中發現 `adminAuth` 原本只驗證 JWT 簽章、沒檢查 payload 的角色，代表任何簽出來的合法 JWT（包含玩家的）都能通過 admin 驗證；已修正為 admin token 帶 `role: 'admin'`、player token 帶 `role: 'player'`，兩個 middleware 各自檢查對應角色，互不通用。
- **已知限制**：PK 對戰的即時進度只存在記憶體（`src/pk/session.js` 的 `sessions` Map），process 重啟不會恢復到原本的題目進度。玩家分頁還開著時的斷線重連已經處理（見下）；但如果手機瀏覽器把分頁整個關掉重載（例如 iOS Safari 為了省記憶體砍背景分頁），`currentDuelId` 只存在網頁記憶體變數、沒寫進 localStorage，重載後無法自動歸隊——這種情況目前只能靠斷線判負機制兜底。
- **斷線重連自動歸隊**（`src/pk/session.js` 的 `playerEntered` / `src/sockets/index.js`）：Socket.IO client 端註冊常駐的 `connect` 監聽器，只要頁面還記得自己在哪場對戰，不管第一次連線還是自動重連都會重新 `pk:enter` 歸隊。伺服器發現對戰已經在進行中時，只針對這個重連的 socket 補送「目前這一題＋剩餘時間」（已作答過的話送 `pk:waiting`），不會打擾對手也不用整個房間重播。已用強制斷線＋重連的測試腳本驗證：重連後正確收到補送的題目，最終資料庫只有一筆對應紀錄，沒有因重連而重複或遺漏。
- **斷線 20 秒未歸隊，自動判負**（`src/pk/session.js` 的 `playerDisconnected` / `forfeitDuel`）：socket `disconnect` 事件觸發時排一個 20 秒倒數，`playerEntered`（不管是重連還是正常進場）都會取消這個倒數；20 秒內沒人回來就直接判對手獲勝、結束整場對戰，套用跟正常結算完全相同的扣分／保護期／廣播邏輯（`pk:result` 多帶一個 `reason: 'opponent_disconnected'` 讓前端顯示對應訊息），避免對戰因為某一方真的斷線消失而無限期卡著。已用測試腳本驗證：斷線後正好在 20 秒整觸發判負，DB 正確寫入勝負結果，且不會跟仍在跑的單題計時器互相干擾。
- **前端靜態檔案快取**（`src/app.js`）：地圖圖磚（活動前預先下載、內容不會變）設定 30 天 `Cache-Control: public, immutable`，其餘靜態檔案設 1 小時快取，避免 80 人反覆開關頁面時重複下載同樣的圖磚把有限的上傳頻寬（規劃中約 50 Mbps）吃滿。
- **測試資料**：`migrations/002_seed_pk_questions.sql` 塞了 7 題 `scope_type='pk'` 的測試題目，供功能測試用。

## 管理後台 — 題庫管理（實作完成）

`/admin/api/questions` 全套 CRUD + CSV 批次匯入都已實作並測試過，`/admin/questions.html` 是實際可用的管理畫面（表單新增/編輯、清單、刪除、CSV 上傳）。`/admin/api/checkpoints` 也順便開了一支唯讀清單端點（純粹是題目表單「這題屬於哪個交摺點」下拉選單要用，交摺點本身的新增/編輯/QR 產生等 CRUD 仍是 stub，不在這次範圍）。

- **CRUD**（`src/routes/admin.js`）：`GET/POST/PATCH/DELETE /admin/api/questions`。新增/編輯共用同一套欄位驗證（`validateQuestionBody`）：四個選項不可空、正確答案限 A-D、`scopeType` 限 checkpoint/pk/general、選 checkpoint 時該交摺點必須真的存在。PATCH 支援部分更新（沒帶的欄位沿用原值）。
- **CSV 批次匯入**（`POST /admin/api/questions/import`，用 `multer` 接 multipart 檔案、`csv-parse` 的 stream/async-iterator 介面逐筆解析）：欄位格式「關卡ID/PK, 題目, 選項A, 選項B, 選項C, 選項D, 正確選項, 秒數」，「關卡ID/PK」欄留空＝通用題庫、填 PK＝PK 專用、填數字＝該交摺點專屬。每 20 筆一批寫入、批次間 `await setImmediate` 明確讓出 event loop，呼應先前「CSV 匯入不能寫成同步阻塞、會卡住玩家即時連線」的守則。單筆資料格式錯誤只會讓那一列失敗（回傳清楚的「第 N 列：原因」），不影響其他列；整批 DB 層級失敗才會讓那一批全數 rollback。已用混合正確/錯誤資料的 CSV 測試過：3 筆成功、3 筆各自因為不同原因（選項不完整、正確答案代號不合法、交摺點不存在）正確失敗並回報。
- **前端**（`public/admin/questions.html`）：新增/編輯表單（選 scope 時動態顯示/隱藏交摺點下拉選單）、題目清單表格、CSV 上傳區塊會顯示「成功 N 筆、失敗 N 筆」加上每筆失敗原因。
- **範例 CSV 下載**（`public/admin/sample-questions.csv`，題庫管理頁上有「下載範例 CSV」連結）：靜態檔案，不用另外開 API。內容涵蓋三種 scope 各一筆範例（通用/PK/交摺點專屬），存成 UTF-8 with BOM（跟匯入用的 `csv-parse` 已經設定的 `bom: true`對上，也順便解決 Windows 版 Excel 直接開啟中文 CSV 容易變亂碼的老問題）。已經實際把這份範例檔案原封不動丟去匯入功能測過，3 筆全部成功匯入、內容（含中文）正確無誤，確認這份範例真的是能直接用的合法格式，不是只是「看起來對」。
- **測試時踩到的坑（跟程式碼無關，記錄一下避免之後重踩）**：本機用 mingw64 版 curl 測試 multipart 檔案上傳時，`-F file=@/c/Users/...`（Git Bash 的 POSIX 風格路徑）會讀檔失敗（`curl: (26) Failed to open/read local data`），要換成 Windows 原生路徑 `-F file=@C:\Users\...` 才行；純文字 JSON 也一樣，直接在 Git Bash 命令列用 `-d '...'` 夾帶中文，會因為終端機編碼被搞亂（送到伺服器變亂碼），這不是伺服器的問題——伺服器本身正確處理 UTF-8，改用檔案（`--data-binary @file.json`）帶payload 就正常，瀏覽器實際送出的 `fetch()`/`JSON.stringify()` 本來就是正確 UTF-8，不會有這個問題。

## 管理後台 — 遊戲進程控制（實作完成）

`game_state` 這張單列表現在是真的在動了：`GET/POST /admin/api/game/*`（開始/結束）、公開的唯讀 `GET /api/game/state`（不用登入，給玩家頁面/大會 Dashboard 用），並且會即時廣播給所有連線。

- **狀態轉換**（`src/routes/admin.js`）：`not_started → in_progress`（開始遊戲，寫入 `started_at`、清空 `ended_at`，方便重新開始時重算）、`in_progress → ended`（強制結束，寫入 `ended_at`）。不合法的轉換直接擋掉並回 409（例如遊戲已經在進行中還按「開始」、或還沒開始/已結束時按「結束」）。
- **廣播機制**（新增 `src/io.js`）：`admin.js` 原本沒有 `io` 可以用（`io` 是在 `app.js` 建立、傳給 `attachSockets`，路由模組拿不到）。加了一個小的 singleton 模組，`app.js` 建立 `io` 後呼叫一次 `setIO(io)`，其他模組要廣播時 `getIO().emit(...)` 就好，不用整條呼叫鏈都手動傳遞 `io`。開始/結束遊戲時會 `io.emit('game:state', {...})` 給所有連線（不分玩家/Dashboard），呼應先前 API 設計裡「全域廣播不指定 room」的原則。已用獨立的 socket.io-client 測試腳本驗證：管理員按下「結束遊戲」的當下，另一條連線立刻收到對應的 `game:state` 事件。
- **PK 對戰掛上遊戲狀態檢查**（`src/routes/pk.js` 的 `requireGameInProgress`）：呼應規格「未開始/已結束時不能發起或加入新的 PK 對戰」，`/api/pk/create`、`/api/pk/join` 現在都要求 `game_state.status === 'in_progress'`，否則回 403 並附上目前實際狀態。已測過三種狀態下的行為都對：未開始擋、進行中放行、結束後又擋。已經在進行中的對戰不會被強制中斷，只是不能再開新的。
- **前端**：`public/admin/index.html` 改成真的遊戲控制面板（狀態徽章、開始/結束按鈕，按鈕會依目前狀態自動 disable 不合法的操作，結束前有 confirm 對話框）；`public/dashboard.html` 接上 Socket.IO，即時反映 `game:state`（頁面載入先打一次 `GET /api/game/state` 拿目前狀態，之後靠 `game:state` 廣播即時更新，不用整頁重新整理）。
- **範圍內沒做的**：交摺點掃碼答題（`/api/checkpoints/*`）還是 stub，還沒真的接上這個狀態檢查——等那個功能開發時要記得比照 PK 也掛上 `requireGameInProgress` 同樣的邏輯（規格裡寫的「未開始：玩家掃描 QR Code 會顯示『尚未開啟』」）。已經在進行中的 PK 對戰在「強制結束」按下去之後不會被中途打斷，這是刻意的設計（避免半途腰斬正在進行的對戰），不是遺漏。

## 管理後台 — PK 對戰管理（實作完成）

獨立的一頁 `public/admin/pk-duels.html`，對應規格裡「戰況覆寫」中 PK 的部分：列出所有 PK 對戰、取消某場對戰的扣分懲罰。一般積分覆寫（`/admin/api/overrides/score`，跟 PK 無關的手動增減分數）還是 stub，不在這次範圍內。

- **新增欄位**（`migrations/003_pk_penalty_cancel.sql`）：`pk_duels.penalty_cancelled_at`。`penalty_amount` 保留「當初扣了多少」的歷史紀錄不清掉，用 `penalty_cancelled_at` 是否有值判斷這筆懲罰現在還算不算數，取消時分數用同一個金額加回去，帳目對得起來。
- **清單**（`GET /admin/api/pk-duels`）：JOIN 雙方玩家/隊伍/交摺點資料，一次回傳管理員看得懂的完整資訊（誰對誰、哪個陣營、扣了哪個交摺點多少分、有沒有被取消過），最多回最近 100 場。
- **取消扣分**（`POST /admin/api/overrides/pk/:duelId/cancel-penalty`）：整個操作包在一個 DB transaction 裡，用 `SELECT ... FOR UPDATE` 鎖住那筆 `pk_duels`，依序檢查「對戰是否已結束」「是否本來就沒有扣分」「是否已經取消過」，通過才把分數加回對應交摺點的 `repair_value`/`disrupt_value`、標記 `penalty_cancelled_at`、寫一筆 `admin_actions` 稽核紀錄（記錄是哪個管理員、原本扣了多少、扣哪個交摺點），最後廣播 `checkpoint:update` 讓正在看地圖/Dashboard 的人即時看到分數變化。已測過：正常取消（分數精確加回原本扣掉的數字）、重複取消（擋掉並回錯誤）、對沒有扣分的對戰取消（擋掉）、對不存在的對戰 ID 操作（404），稽核紀錄也確認正確寫入。
- **前端**：`public/admin/pk-duels.html`，表格列出房號、雙方（含陣營標籤）、狀態、勝負（顯示玩家名稱，不是原始 ID）、扣分資訊（已取消的用刪除線標示）、建立時間，符合條件的列才會出現「取消扣分」按鈕。`admin/index.html` 加了連結過去。

## 玩家登入模式變更：一組一支手機 + PIN 找回身份（實作完成）

規格更新：現場改成**一支隊伍只用一支手機登入**（不再是每人各自登入、系統自動把 3~4 人湊成一隊），所以「登入」現在等於「開一支新隊伍」；同時隊伍數上限訂為 **20 支**。另外加了 PIN 機制，讓同一支隊伍掉線、換手機、瀏覽器資料被清掉時，可以用同樣的代號＋PIN 拿回原本的身份，不會意外變成開了一支新隊伍。

- **新增欄位**（`migrations/004_player_pin.sql` + `005_player_pin_plaintext.sql`）：`players.pin`——**明碼儲存，刻意不雜湊**。原本用 bcrypt 雜湊過，但活動現場拿手機操作的是隊輔不是玩家本人，主辦需要能直接從資料庫（PgAdmin）查到某支隊伍的 PIN 幫忙找回，雜湊過就永遠查不回來了，所以改成明碼；`players.display_name` 仍加上 `UNIQUE` 限制（代號等於帳號，要唯一才能拿來找回身份）。PIN 錯誤次數鎖定機制不受影響、照樣有效——雖然是明碼，還是不能無限次亂猜。
- **登入/找回合併成同一支 API**（`src/routes/auth.js` 的 `POST /api/auth/join`，body 多一個 `pin`，限制剛好 4 碼數字）：
  - 代號**沒人用過**：視為新隊伍加入。先檢查目前隊伍總數有沒有到 20 上限（到了就回 403，訊息直接告訴使用者已滿），沒到才建立新隊伍＋新玩家，PIN 直接存進去，回傳 `returning: false`。
  - 代號**已經有人用過**：視為原本那支隊伍的手機回來了，驗證 PIN——對了就簽發新 token 讓他拿回**同一個** player/team（不是開新的），回傳 `returning: true`；PIN 錯誤一律回同一句「代號被占用或 PIN 錯誤」（不透露是哪一種），並比照 admin 登入的做法做失敗次數鎖定（5 次錯誤鎖 15 分鐘，記憶體內計數）。
  - 隊伍已滿（20 支）時，**原本就存在的玩家還是可以用代號＋PIN 正常拿回身份**——上限只擋「新」隊伍加入，不會把已經在場上的隊伍鎖在外面，這點有特別測過。
  - 陣營平均分發、隨機平手決勝負的邏輯不變，只是現在算的是「隊伍數」而不是「人數」（兩者現在剛好是同一件事，因為一隊只有一個玩家記錄）。
- **移除的邏輯**：原本「找一個還沒滿 4 人的隊伍塞進去，滿了才開新隊」的邏輯拿掉了——現在每次新加入都是一支新隊伍，不會有多人共用一個 `player` 記錄的情況（`is_captain` 固定是 `true`，因為一隊只有一個操作者）。
- **前端**（`public/login.html`）：登入表單多一個 4 碼 PIN 輸入框（`inputmode="numeric"` 方便手機叫出數字鍵盤），提示文字直接寫「掉線/換手機用同一組代號+PIN 找回身份」。PIN 欄位掛了 `input` 事件即時把非數字字元濾掉（`replace(/\D/g, '')`）並裁到 4 碼，打字或貼上非數字內容當下就被擋掉，不用等按下送出才發現格式錯誤——用 Playwright 實測過真的鍵盤輸入（混雜英文/符號/數字）跟貼上輸入兩種情境，最後欄位裡都只會剩下數字。
- **已測試**：新代號建隊成功、同代號同 PIN 正確拿回同一個 player/team（不是新的一筆）、同代號錯誤 PIN 回 401、PIN 格式不對（非 4 碼數字）回 400、連續 5 次錯誤 PIN 觸發鎖定（第 6 次連正確 PIN 都被擋 429）、隊伍數到 20 時新代號被拒但既有代號＋正確 PIN 仍正常放行、20 支隊伍的陣營分佈精確 10:10、直接查資料庫確認 `players.pin` 存的就是明碼（例如 `5678`），PgAdmin 連進去就查得到。測試用的舊資料（含改明碼之前的舊格式）已經清空，不影響後續使用。

## 玩家 GPS 圍籬（實作完成）

玩家離開校園範圍就導回 `index.html`（時空戰爭首頁）。校園範圍跟下載地圖圖磚用的是同一個 bounding box，寫成共用的 `public/geofence.js`，**只掛在 `map.html`**（後來改的：一開始也掛在 `pk.html`、`checkpoint.html` 上，使用者要求只有大地圖頁需要判斷是否在校園範圍內，其他頁面拿掉了）。

- **持續追蹤 + 防手震**（`public/geofence.js`）：用 `navigator.geolocation.watchPosition` 持續監控，不是只在頁面載入時檢查一次——玩家在場上移動時，一旦真的離開範圍要能即時發現。GPS 訊號在邊界附近容易跳動，所以不是單次超出範圍就導回，而是要**連續 3 次**都在範圍外才觸發，中間只要有一次讀值是範圍內就重新計數，避免單次飄移誤判把還在校園裡的人踢出去。
- **失敗處理**：抓不到定位（裝置不支援、使用者拒絕權限）不會被當成「已離開校園」強制導回——那只代表「不知道現在人在哪」，不代表「已知不在校園」，兩者處理方式不同。畫面上方會出現紅色提示條告知目前狀況（確認定位中／無法取得定位），而不是靜默失敗。
- **測試方式**：實際定位服務沒辦法在 CI/自動化環境模擬，所以用 Playwright 開真的瀏覽器測試，把 `navigator.geolocation` 換成假的實作直接控制回傳座標（過程中發現 `navigator.geolocation` 是唯讀 getter，直接賦值會靜默失敗，要用 `Object.defineProperty` 才蓋得掉——這是測試腳本本身的坑，跟正式程式碼無關）。測了四種情境都通過：範圍內不導回、單次超出範圍不導回（防手震生效中）、連續 3 次超出範圍才真的觸發 `alert()` + 導回 `index.html`、以及「壞、壞、好、壞、壞」這種中途被一次好讀值重置計數的情況不會誤觸發。
- **範圍內沒做的**：目前只有「離開範圍就導回」，還沒有把定位資料拿去做隊友即時位置分享（規格裡的「同小隊隊友之間可見彼此 GPS 座標」）——`geofence.js` 的 `onUpdate(lat, lng)` callback 已經預留好接口，之後要接 `team:<teamId>` Socket.IO room 廣播時直接掛上去就好，不用改追蹤邏輯本身。

## 效能風險評估（給下一輪寫商業邏輯時的守則，本輪骨架不受影響）

以 50-80 人同時上線的量級檢視過一輪，整體風險很低（單一 Node/Socket.IO process 輕鬆撐住這個連線數，DB 寫入頻率也低，只在挑戰完成/PK 結算當下寫入，不是逐題寫）。但有以下幾點在**下一輪實作實際商業邏輯時**要注意：

- **最大風險：`/admin` 後台跟玩家即時連線共用同一個 Node process**。題庫 CSV 批次匯入、批次匯出/列印 QR Code 這類操作，如果寫成同步阻塞迴圈，會卡住 event loop，導致當下**所有玩家的 WebSocket 連線一起卡頓**（答題計時、PK 同步、地圖定位都會延遲）。實作時這幾支端點要用非同步/分批處理（例如用 stream 解析 CSV、每處理一批就 `setImmediate` 讓出 event loop），且操作上建議引導主辦方在活動開始前先把題庫匯入完，不要在遊戲進行中做大量匯入。
- **DB connection pool 要用單一共用 instance**：`pg.Pool()` 只在 app 啟動時建立一次、全域共用，不要每個 request 各自 new 一個 pool，避免意外把 Postgres 的連線數吃滿。
- **分數異動要包在資料庫交易（transaction）裡**：`checkpoint_attempts` 寫入 + 更新 `checkpoints.repair_value/disrupt_value` + 更新 `teams.last_checkpoint_attempt_id`，這三步要在同一個 transaction 裡做，避免同隊兩人幾乎同時交卷時分數算錯或互相覆蓋（這是正確性風險，但在高併發下也會放大成效能/鎖等待問題）。
- **Socket.IO process crash 後怎麼恢復**：靠 `compose.yml` 已定的 `restart: unless-stopped` + healthcheck，process 掛掉或無回應時 Docker 會自動重啟 container，不需要額外機制。但要注意：**重啟後所有記憶體內的即時狀態會消失**——包括還在進行中的 PK 對戰房間（`roomCode → duelId` 對照表、對戰題目/計時進度）、team room 的連線狀態。已經寫進 Postgres 的資料（關卡分數、隊伍資料、admin 帳號）完全不受影響，安全。因此下一輪實作時：Socket.IO client 端要處理「重連後發現原本的 PK 房間/對戰已經不存在」的情況（顯示「連線中斷，請重新發起 PK」而不是卡死），玩家掃碼答題、地圖定位這類「無狀態、下一次動作會重新從 DB/GPS 取值」的功能則重連後自動恢復，不用特別處理。

## 已收斂的架構決策

1. **四個系統完全獨立**：各自一個 container（app）、各自一個 Postgres DB，彼此不共用 DB instance，不互相耦合。
2. **Portal 純粹是靜態入口頁**：列出各系統連結 + 公告文字，不含登入、不含資料庫、不含管理邏輯。公告用檔案內容管理（改檔案 + 重啟 container），不做成可線上編輯的後台，避免又長出一個管理系統。
3. **每個活動系統自帶管理後台**：同一個 app、同一個 port，額外掛一條不在導覽列上顯示的 `/admin` 路徑。後台需要登入。
3a. **帳號新增權限只歸系統管理員**：不開放任何自助註冊、也不開放「admin 邀請 admin」這種站內功能。帳號一律由系統管理員透過**不對外暴露的 CLI script**（例如 `node scripts/create-admin.js`，在伺服器上直接執行，建立帳號＋雜湊密碼寫入 DB）建立，沒有任何 HTTP 端點可以新增帳號，杜絕被外部發現/濫用的可能。20 位左右工作人員各自個人帳號，方便日後追查操作紀錄。
4. **`/admin` 的安全性建立在伺服器端驗證，而非路徑隱藏**：`/admin` 後台驗證機制採用 **JWT**（登入成功後簽發 JWT，前端存起來隨後續請求帶上），所有 `/admin/*` 請求（含 API 與頁面）後端一律驗證 JWT 有效性與角色；登入端點加失敗次數限制防暴力破解。日後如需更強防護，可在 Cloudflare 針對該 hostname/path 疊加 Cloudflare Access，不需改架構。
5. **每個系統的 db container 本身不對外**：app 與 db 之間用一個系統私有的 internal Docker network 溝通，`db` 本身不加入跨系統共用網路，也不會被 cloudflared 觸及到。
5a. **pgAdmin 是全系統共用一份，獨立資料夾，只給使用者本人用**：不是每個系統各自一個，而是一個獨立的 `PgAdmin/` stack，只用一組帳號（使用者本人），不釋出給 20 位 admin。這個 pgAdmin container 會**同時加入每個系統各自的私有 internal network**（目前只有 Time-Space Warfare 有 db，之後 RPG System / Stock Game 建立 db 時，讓 pgAdmin 多加入它們的 internal network 即可）+ 共用的 `ncumis-camp` 網路（給使用者手動設定的 cloudflared 連得到），在 pgAdmin 裡把每個系統的 db 各自註冊成一組連線。這是唯一被允許當作「DB 對外窗口」的服務，各系統的 db 本身仍然完全不直接暴露。因為只有使用者一人用、且能看到所有系統的完整 DB，帳密要設得夠強；之後如果想加保險，也可以單獨在這個 hostname 上疊加 Cloudflare Access。
5b. **所有密碼/帳密一律走 `.env`，不進 git**：pgAdmin 登入帳密、各系統的 Postgres 密碼等，一律定義在各自 stack 的 `.env`（`.gitignore` 排除），`compose.yml` 只用 `${VAR}` 引用環境變數，不寫死明碼。每個 stack 附一份 `.env.example`（只放變數名稱與空值/範例值，不含真實密碼）方便之後照著建立正式的 `.env`。
6. **跨系統共用一個 external Docker network**（例如 `ncumis-camp`），各系統的 app、以及共用的 pgAdmin（不含各系統的 db）加入這個網路，方便使用者之後手動設定的 cloudflared 連線進來（tunnel 本身的建立與 ingress 設定由使用者在 Cloudflare dashboard 手動處理，本計畫不涉及）。
7. **子網域分流、不用路徑前綴**：使用者手動設定 tunnel 時建議每個系統對應一個子網域（例如 `timewarfare.example.com`），可避免 WebSocket 在路徑改寫時的雷；此為使用者手動設定時的建議，非本計畫實作範圍。
8. **暫不做多副本/冗餘設計**（Redis、多 app 副本、負載平衡），單一 instance 足以支撐 80-120 人的 Socket.IO 連線量，留待未來有需要再加。
9. **Docker image 大小非顧慮**：各系統各自輕量 container（node:alpine 級別），資源佔用在可控範圍。

## Port 配置

對外（host）port 統一從 9000 開始編號，方便使用者手動設定 cloudflared 時對照：

| 服務 | Host Port |
|---|---|
| `Portal` | 9000 |
| `Time-Space Warfare` app | 9001 |
| `PgAdmin` | 9002 |
| `RPG System` app（未來） | 9003 |
| `Stock Game` app（未來） | 9004 |

各系統的 `db` 不對外開 host port（只在系統私有 internal network 內用 container 預設 port 溝通），不佔用這個編號序列。

## 實作步驟

### 1. Root
- 確認根目錄 `compose.yml` 刪除是預期行為（改為每個系統各自的 compose 檔）。
- 新增根目錄 `README.md`：說明整體架構、如何建立共用 network、如何啟動每個 stack。
- 新增根目錄 `.gitignore`（`node_modules/`、`.env`、`*.log` 等）。

### 2. 共用網路
- 於 README 記錄手動指令：`docker network create ncumis-camp`（一次性），供所有 compose 專案以 `external: true` 引用。

### 3. `Portal/`
- `compose.yml`：單一輕量服務（靜態頁，例如 Nginx 或極簡 Node 靜態伺服器），只加入共用 network，不含 DB，host port 對應 `9000`。
- 基本靜態頁骨架：連結卡片（3 個活動系統，之後加第 4 個系統只是加一張卡片/一行設定，不涉及本計畫其餘架構）+ 公告區塊（讀取一個 `announcements.json` 或 markdown 檔）。

### 4. `PgAdmin/`（新資料夾，全系統共用、只給使用者本人用）
- `compose.yml`：
  - `pgadmin` service：官方 `dpage/pgadmin4` image，加入共用 network `ncumis-camp`（給 cloudflared 連）+ `Time-Space Warfare` 的系統私有 internal network（連它的 db），host port 對應 `9002`。之後 RPG System / Stock Game 有 db 時，回來這個 compose 檔多接一條 network 即可。
  - 登入帳密走 `.env`（`PGADMIN_DEFAULT_EMAIL` / `PGADMIN_DEFAULT_PASSWORD`），只設一組（使用者本人）。
- 需要一份小 README 註記：這是唯一被授權連到各系統 db 的地方，帳密不外流給 20 位 admin。

### 5. `Time-Space Warfare/`（本次唯一有完整玩法規格的系統，本次實際搭建骨架）
- `compose.yml`：
  - `app` service：Node.js/TypeScript，加入共用 network `ncumis-camp`（給使用者之後手動設定的 cloudflared 連進來用）+ 系統私有 internal network（給 db 和 PgAdmin 用），host port 對應 `9001`。
  - `db` service：Postgres，只加入系統私有 internal network，掛 volume，密碼走 `.env`（`POSTGRES_PASSWORD`）。
- App 骨架（僅基礎架子，不含題庫/遊戲邏輯）：
  - Express.js + Socket.IO。
  - `/health` 健康檢查路由。
  - `/admin` 路由前綴，掛 session-auth middleware（stub，先擋未登入請求回 401，登入頁待補）。
  - Postgres 連線（透過環境變數，使用 `pg` 套件直接下 SQL，不用 ORM）；`migrations/001_init.sql`（見上方「資料庫 Schema 設計」，本回合實際建出全部資料表）+ 一個小 migration runner。
  - 路由檔案依照上方「API 設計」把所有端點都建出來（`routes/auth.js`、`routes/checkpoints.js`、`routes/pk.js`、`routes/admin.js` 等），但 handler 內容本回合只回傳 501/假資料佔位，不寫實際商業邏輯（抽題演算法、PK 即時配對、GPS 廣播、計分覆寫等留待下一輪功能開發）。Socket.IO 只建立 namespace/連線骨架，不掛實際事件邏輯。
  - `scripts/create-admin.js`：不對外暴露的 CLI script，系統管理員在伺服器上直接執行來建立 admin 帳號（帳號＋雜湊密碼寫入 DB），沒有任何 HTTP 端點可以新增帳號。
  - `.env.example`、多階段 `Dockerfile`（`node:20-alpine`）。
  - `restart: unless-stopped` + healthcheck。

### 6. `RPG System/`、`Stock Game/`
- 本次維持空資料夾，不建立任何內容。

## 驗證方式

- `docker network create ncumis-camp` 後，分別在 `Portal/`、`Time-Space Warfare/`、`PgAdmin/` 各自執行 `docker compose up`，確認服務正常啟動、無 crash loop。
- 對 `Time-Space Warfare` app container 內部 `curl localhost:<port>/health`，確認回 200。
- 確認 `/admin` 路由在未登入狀態下回 401（驗證伺服器端驗證有生效，不是只靠路徑隱藏）。
- migration 執行後，用 pgAdmin 或 `psql` 確認全部資料表（`teams`、`players`、`checkpoints`、`questions`、`checkpoint_attempts`、`pk_duels`、`pk_duel_answers`、`admin_users`、`admin_actions`、`game_state`）都正確建立，欄位符合設計。
- 對照「API 設計」清單，逐一打每支路由確認有回應（stub 階段回 501 或假資料即算通過，不驗證實際邏輯正確性）。
- 執行 `node scripts/create-admin.js` 確認可以成功建立一個 admin 帳號，並用該帳號登入 `/admin` 成功（這組帳號跟 pgAdmin 帳號是兩回事，互不相通）。
- 確認 `db` container 沒有加入 `ncumis-camp` 共用網路（用 `docker network inspect ncumis-camp` 確認裡面只有各系統的 app 和 pgadmin，沒有任何 db）。
- 用 `.env` 裡設定的帳密登入 pgAdmin，確認能連上 Time-Space Warfare 的 db。
- 檢查所有 `compose.yml` 內沒有任何明碼密碼（只有 `${VAR}` 引用），各自的 `.env` 確實被 `.gitignore` 排除、`git status` 不會看到它。
- Portal 頁面能正常顯示公告與連結。

## 技術選型（已確認）

- Web framework：Express.js。
- DB 存取：不用 ORM，直接用 `pg` 套件下 SQL，搭配手寫 migration script。
