// 登入失敗次數限制（記憶體內，process 重啟會重置，這只是防暴力破解的基本防線，
// 不是完整的 rate limit；跨多個實例也不會共用）。
//
// 為什麼需要定期清理：這個 Map 只會因為「登入失敗」而長大——只有成功登入才會刪掉
// 自己那一筆——所以拿大量不同帳號名去打登入，就能讓它一直累積下去。定期把過期的
// 項目掃掉，記憶體用量才會有上限。
//
// 除了鎖定時間會過期之外，「失敗計數」本身也會過期：隔了很久才又失敗一次，就重新
// 從 1 開始算，不會把上星期偶然打錯的那一次累積進來、讓人莫名其妙被鎖。
const DEFAULTS = {
  maxAttempts: 5,
  lockoutMs: 15 * 60 * 1000,
  windowMs: 15 * 60 * 1000,      // 這段時間內沒有再失敗，計數就歸零
  sweepIntervalMs: 5 * 60 * 1000,
  sweepSizeThreshold: 5000       // 短時間被灌爆時，不等定期清理就先掃一次
};

function createLoginThrottle(options = {}) {
  const cfg = { ...DEFAULTS, ...options };
  const records = new Map(); // key -> { count, lockedUntil, expiresAt }

  function sweep(now = Date.now()) {
    let removed = 0;
    for (const [key, record] of records) {
      if (record.expiresAt <= now) {
        records.delete(key);
        removed += 1;
      }
    }
    return removed;
  }

  const timer = setInterval(() => sweep(), cfg.sweepIntervalMs);
  // 別讓清理計時器擋住 process 結束（收到 SIGTERM、或跑完測試要退出時）。
  if (typeof timer.unref === 'function') timer.unref();

  // 讀取時順便當作 lazy 清理：過期的直接刪掉並視為不存在。
  function current(key, now) {
    const record = records.get(key);
    if (!record) return null;
    if (record.expiresAt <= now) {
      records.delete(key);
      return null;
    }
    return record;
  }

  return {
    // 這個 key 目前是不是還在鎖定中
    isLocked(key, now = Date.now()) {
      const record = current(key, now);
      return Boolean(record && record.lockedUntil && record.lockedUntil > now);
    },

    // 記一次失敗，回傳更新後的狀態
    recordFailure(key, now = Date.now()) {
      if (records.size >= cfg.sweepSizeThreshold) sweep(now);

      const record = current(key, now);
      const count = (record?.count || 0) + 1;
      const lockedUntil = count >= cfg.maxAttempts ? now + cfg.lockoutMs : null;

      records.set(key, {
        count,
        lockedUntil,
        // 鎖定結束前絕對不能被掃掉，所以取兩者較晚的那個時間點
        expiresAt: Math.max(lockedUntil || 0, now + cfg.windowMs)
      });

      return { count, lockedUntil };
    },

    // 登入成功就把紀錄清掉
    clear(key) {
      records.delete(key);
    },

    // 給測試用
    _sweep: sweep,
    _size: () => records.size
  };
}

module.exports = { createLoginThrottle };
