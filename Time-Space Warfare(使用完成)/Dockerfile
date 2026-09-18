FROM node:20-alpine AS deps
WORKDIR /app
COPY package.json package-lock.json* ./
RUN npm install --omit=dev

FROM node:20-alpine
WORKDIR /app
ENV NODE_ENV=production
COPY --from=deps /app/node_modules ./node_modules
COPY . .
EXPOSE 3000
# 啟動時先跑 migration，成功了才起 app。
#
# 原本是分開的：deploy 先 compose up、再 docker compose exec 跑 migrate。那樣
# 新版程式會先開始服務、幾秒後 schema 才更新，中間這段時間新程式讀新欄位會
# 直接噴 500（實際發生過：「column voting_unlocked_at does not exist」）。
# 而且只要有人忘記跑那行，系統就一直是壞的。
#
# migration runner 每個檔案包在自己的交易裡、已套用的會跳過，重複執行安全。
# 失敗就讓容器起不來——帶著錯誤的 schema 對外服務比直接掛掉更難查。
#
# 最後用 exec 換掉 shell：不然 PID 1 是 sh，node 收不到 docker stop 的 SIGTERM，
# 每次收容器都要等 10 秒逾時被強制砍掉。
CMD ["sh", "-c", "node migrations/migrate.js && exec node src/app.js"]
