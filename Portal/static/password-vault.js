/* Password vault: records are encrypted and persisted by the Portal server. */
(() => {
  const LEGACY_STORAGE_KEY = 'ncumis-portal-password-vault-v1';
  const LEGACY_ITERATIONS = 250000;
  const TEST_RECORDS = [
    { id:'sample-rpg', platform:'[測試] RPG 後台', url:'https://rpg.佑佑.台灣/admin', username:'demo-rpg-admin', password:'demo-rpg-password', notes:'測試資料，請改成實際帳密。' },
    { id:'sample-stock', platform:'[測試] 賭大股票後台', url:'https://賭大.佑佑.台灣/admin', username:'demo-stock-admin', password:'demo-stock-password', notes:'測試資料，請改成實際帳密。' },
    { id:'sample-match', platform:'[測試] 對抗賽操作台', url:'https://對抗賽.佑佑.台灣', username:'demo-match-admin', password:'demo-match-password', notes:'測試資料，請改成實際帳密。' }
  ];
  const $ = id => document.getElementById(id);
  const esc = value => String(value ?? '').replace(/[&<>"']/g, c => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;' }[c]));
  const safeUrl = value => { try { const url = new URL(String(value || '')); return ['https:', 'http:'].includes(url.protocol) ? url.href : ''; } catch { return ''; } };
  const searchable = value => String(value ?? '').toLocaleLowerCase('zh-TW');
  const status = (id, text = '', kind = '') => { const el = $(id); el.textContent = text; el.className = `vault-status ${kind}`; };
  let records = [], token = '', editingId = null;

  async function legacyRecords(password) {
    const stored = JSON.parse(localStorage.getItem(LEGACY_STORAGE_KEY) || 'null');
    if (!stored?.salt || !stored?.iv || !stored?.ciphertext || !window.crypto?.subtle) return [];
    const bytes = value => Uint8Array.from(atob(value), char => char.charCodeAt(0));
    const material = await crypto.subtle.importKey('raw', new TextEncoder().encode(password), 'PBKDF2', false, ['deriveKey']);
    const key = await crypto.subtle.deriveKey({ name:'PBKDF2', salt:bytes(stored.salt), iterations:LEGACY_ITERATIONS, hash:'SHA-256' }, material, { name:'AES-GCM', length:256 }, false, ['decrypt']);
    const plaintext = await crypto.subtle.decrypt({ name:'AES-GCM', iv:bytes(stored.iv) }, key, bytes(stored.ciphertext));
    const data = JSON.parse(new TextDecoder().decode(plaintext));
    return Array.isArray(data.records) ? data.records : [];
  }

  async function request(path, options = {}) {
    const headers = { ...(options.body ? { 'Content-Type':'application/json' } : {}), ...(token ? { 'Authorization':`Bearer ${token}` } : {}), ...(options.headers || {}) };
    const response = await fetch(path, { ...options, headers, cache:'no-store' });
    const body = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(body.error || '保管庫操作失敗');
    return body;
  }
  async function persist() {
    const body = await request('/api/vault/records', { method:'PUT', body:JSON.stringify({ records }) });
    records = body.records || records;
  }
  async function load() {
    const body = await request('/api/vault/records');
    records = Array.isArray(body.records) ? body.records : [];
  }
  function showInitial() { $('vaultContents').classList.add('hidden'); $('vaultUnlockPanel').classList.remove('hidden'); }
  function showContents() { $('vaultUnlockPanel').classList.add('hidden'); $('vaultContents').classList.remove('hidden'); renderRecords(); }
  function resetForm() { editingId = null; $('vaultRecordForm').reset(); $('vaultRecordTitle').textContent = '新增平台密碼'; $('vaultSaveRecordBtn').textContent = '儲存紀錄'; $('vaultCancelEditBtn').classList.add('hidden'); status('vaultRecordStatus'); }
  function lock(close = false) { token = ''; records = []; editingId = null; $('vaultUnlockPassword').value = ''; status('vaultUnlockStatus'); if (close) $('passwordVault').classList.add('hidden'); else showInitial(); }
  function renderRecords() {
    const host = $('vaultRecords'), query = $('vaultFilter').value.trim(), term = searchable(query);
    const visible = records.filter(record => !term || [record.platform, record.url, record.username, record.notes].some(value => searchable(value).includes(term)));
    $('vaultFilterResult').textContent = records.length ? `顯示 ${visible.length}／${records.length} 筆` : '';
    if (!records.length) { host.innerHTML = '<tr><td class="vault-empty" colspan="6">尚未新增任何平台密碼。</td></tr>'; return; }
    if (!visible.length) { host.innerHTML = `<tr><td class="vault-empty" colspan="6">找不到「${esc(query)}」相關的紀錄。</td></tr>`; return; }
    host.innerHTML = visible.map(record => { const url = safeUrl(record.url); return `<tr><td>${esc(record.platform)}</td><td>${url ? `<a href="${esc(url)}" target="_blank" rel="noopener">${esc(url)}</a>` : '—'}</td><td>${record.username ? esc(record.username) : '—'}</td><td><div class="vault-secret"><span>${esc(record.password)}</span></div></td><td>${record.notes ? esc(record.notes) : '—'}</td><td><div class="vault-row-actions"><button type="button" data-edit="${esc(record.id)}">編輯</button><button type="button" class="danger" data-delete="${esc(record.id)}">刪除</button></div></td></tr>`; }).join('');
  }
  function sessionError(error, target) {
    const message = error.message || '保管庫操作失敗';
    if (/session expired/i.test(message)) lock();
    status(target, message, 'error');
  }

  $('passwordOpenBtn').addEventListener('click', () => { $('passwordVault').classList.remove('hidden'); showInitial(); $('passwordVault').scrollIntoView({ behavior:'smooth', block:'start' }); });
  $('passwordCloseBtn').addEventListener('click', () => lock(true));
  $('vaultLockBtn').addEventListener('click', () => lock());
  $('vaultCancelEditBtn').addEventListener('click', resetForm);
  $('vaultFilter').addEventListener('input', renderRecords);
  $('vaultUnlockForm').addEventListener('submit', async event => {
    event.preventDefault(); status('vaultUnlockStatus'); const password = $('vaultUnlockPassword').value;
    try { const body = await request('/api/vault/unlock', { method:'POST', body:JSON.stringify({ password }) }); token = body.token; await load(); const legacy = !records.length ? await legacyRecords(password).catch(() => []) : []; if (legacy.length && confirm('偵測到這台裝置的舊保管庫。要加密搬移到 Portal 伺服器嗎？')) { records = legacy; await persist(); localStorage.removeItem(LEGACY_STORAGE_KEY); status('vaultUnlockStatus', '已將舊保管庫加密搬移到 Portal 伺服器。', 'ok'); } $('vaultUnlockPassword').value = ''; showContents(); }
    catch (error) { token = ''; sessionError(error, 'vaultUnlockStatus'); }
  });
  $('vaultLoadTestBtn').addEventListener('click', async () => {
    if (records.some(record => TEST_RECORDS.some(sample => sample.id === record.id))) return status('vaultRecordStatus', '測試資料已經存在。', 'error');
    if (records.length && !confirm('目前已有紀錄，仍要加入三筆測試資料嗎？')) return;
    records = [...TEST_RECORDS.map(record => ({ ...record })), ...records];
    try { await persist(); renderRecords(); status('vaultRecordStatus', '已加密儲存在 Portal 伺服器。', 'ok'); } catch (error) { sessionError(error, 'vaultRecordStatus'); }
  });
  $('vaultRecordForm').addEventListener('submit', async event => {
    event.preventDefault(); const form = { platform:$('vaultPlatform').value.trim(), url:$('vaultRecordUrl').value.trim(), username:$('vaultUsername').value.trim(), password:$('vaultRecordPassword').value, notes:$('vaultNotes').value.trim() };
    if (!form.platform || !form.password) return status('vaultRecordStatus', '請填寫平台名稱與密碼。', 'error');
    if (editingId) records = records.map(record => record.id === editingId ? { ...record, ...form } : record); else records.unshift({ id:crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}-${Math.random()}`, ...form });
    try { await persist(); resetForm(); renderRecords(); status('vaultRecordStatus', '已加密儲存在 Portal 伺服器。', 'ok'); } catch (error) { sessionError(error, 'vaultRecordStatus'); }
  });
  $('vaultRecords').addEventListener('click', async event => {
    const button = event.target.closest('button'); if (!button) return; const id = button.dataset.edit || button.dataset.delete; const record = records.find(item => item.id === id); if (!record) return;
    if (button.dataset.edit) { editingId = id; $('vaultPlatform').value = record.platform; $('vaultRecordUrl').value = record.url || ''; $('vaultUsername').value = record.username || ''; $('vaultRecordPassword').value = record.password; $('vaultNotes').value = record.notes || ''; $('vaultRecordTitle').textContent = `編輯：${record.platform}`; $('vaultSaveRecordBtn').textContent = '更新紀錄'; $('vaultCancelEditBtn').classList.remove('hidden'); $('vaultPlatform').focus(); return; }
    if (button.dataset.delete) { if (!confirm(`確定刪除「${record.platform}」嗎？`)) return; records = records.filter(item => item.id !== id); try { await persist(); if (editingId === id) resetForm(); renderRecords(); } catch (error) { sessionError(error, 'vaultRecordStatus'); } }
  });
  $('vaultClearBtn').addEventListener('click', async () => { if (prompt('這會永久刪除伺服器上的所有密碼紀錄。請輸入「清除」確認：') !== '清除') return; try { await request('/api/vault/records', { method:'DELETE' }); records = []; resetForm(); renderRecords(); status('vaultRecordStatus', '已清除伺服器保管庫。', 'ok'); } catch (error) { sessionError(error, 'vaultRecordStatus'); } });
  document.querySelectorAll('[data-vault-toggle]').forEach(button => button.addEventListener('click', () => { const input = $(button.dataset.vaultToggle); input.type = input.type === 'password' ? 'text' : 'password'; button.textContent = input.type === 'password' ? '顯示' : '隱藏'; }));
})();
