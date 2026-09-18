/* Password vault: encrypted data stays in this browser; the master password is verified by Portal. */
(() => {
  const STORAGE_KEY = 'ncumis-portal-password-vault-v1';
  const ITERATIONS = 250000;
  // 只會在建立全新的保管庫時寫入，全部都是無效示範帳密，可直接編輯或刪除。
  const TEST_RECORDS = [
    { id:'sample-rpg', platform:'[測試] RPG 後台', url:'https://rpg.佑佑.台灣/admin', username:'demo-rpg-admin', password:'demo-rpg-password', notes:'測試資料，請改成實際帳密。' },
    { id:'sample-stock', platform:'[測試] 賭大股票後台', url:'https://賭大.佑佑.台灣/admin', username:'demo-stock-admin', password:'demo-stock-password', notes:'測試資料，請改成實際帳密。' },
    { id:'sample-match', platform:'[測試] 對抗賽操作台', url:'https://對抗賽.佑佑.台灣', username:'demo-match-admin', password:'demo-match-password', notes:'測試資料，請改成實際帳密。' }
  ];
  const $ = id => document.getElementById(id);
  const encoder = new TextEncoder(), decoder = new TextDecoder();
  let records = [], key = null, salt = null, editingId = null, revealed = new Set();
  const esc = value => String(value ?? '').replace(/[&<>"']/g, c => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;' }[c]));
  const b64 = value => btoa(String.fromCharCode(...new Uint8Array(value)));
  const bytes = value => Uint8Array.from(atob(value), c => c.charCodeAt(0));
  const available = Boolean(window.crypto?.subtle && window.crypto?.getRandomValues);
  const status = (id, text = '', kind = '') => { const el = $(id); el.textContent = text; el.className = `vault-status ${kind}`; };
  const safeUrl = value => { try { const url = new URL(String(value || '')); return ['https:', 'http:'].includes(url.protocol) ? url.href : ''; } catch { return ''; } };

  async function derive(password, nextSalt) {
    const material = await crypto.subtle.importKey('raw', encoder.encode(password), 'PBKDF2', false, ['deriveKey']);
    return crypto.subtle.deriveKey({ name:'PBKDF2', salt:nextSalt, iterations:ITERATIONS, hash:'SHA-256' }, material, { name:'AES-GCM', length:256 }, false, ['encrypt', 'decrypt']);
  }
  async function verifyMaster(password) {
    const response = await fetch('/api/vault/unlock', { method:'POST', headers:{ 'Content-Type':'application/json' }, cache:'no-store', body:JSON.stringify({ password }) });
    const body = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(body.error || '主密碼驗證失敗');
  }
  async function persist() {
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const ciphertext = await crypto.subtle.encrypt({ name:'AES-GCM', iv }, key, encoder.encode(JSON.stringify({ version:1, records })));
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ version:1, salt:b64(salt), iv:b64(iv), ciphertext:b64(ciphertext) }));
  }
  async function decrypt(password) {
    const stored = JSON.parse(localStorage.getItem(STORAGE_KEY));
    const nextSalt = bytes(stored.salt), nextKey = await derive(password, nextSalt);
    const plaintext = await crypto.subtle.decrypt({ name:'AES-GCM', iv:bytes(stored.iv) }, nextKey, bytes(stored.ciphertext));
    const data = JSON.parse(decoder.decode(plaintext));
    if (!Array.isArray(data.records)) throw new Error('保管庫資料格式不正確');
    records = data.records; key = nextKey; salt = nextSalt; editingId = null; revealed.clear(); showContents();
  }
  function showInitial() {
    $('vaultContents').classList.add('hidden');
    if (!available) { $('vaultUnsupported').classList.remove('hidden'); return; }
    $('vaultUnsupported').classList.add('hidden');
    const exists = Boolean(localStorage.getItem(STORAGE_KEY));
    $('vaultSetupPanel').classList.toggle('hidden', exists);
    $('vaultUnlockPanel').classList.toggle('hidden', !exists);
  }
  function showContents() { $('vaultSetupPanel').classList.add('hidden'); $('vaultUnlockPanel').classList.add('hidden'); $('vaultContents').classList.remove('hidden'); renderRecords(); }
  function resetForm() { editingId = null; $('vaultRecordForm').reset(); $('vaultRecordTitle').textContent = '新增平台密碼'; $('vaultSaveRecordBtn').textContent = '儲存紀錄'; $('vaultCancelEditBtn').classList.add('hidden'); status('vaultRecordStatus'); }
  function lock(close = false) {
    key = null; salt = null; records = []; editingId = null; revealed.clear();
    $('vaultUnlockPassword').value = ''; status('vaultUnlockStatus');
    if (close) $('passwordVault').classList.add('hidden'); else showInitial();
  }
  function renderRecords() {
    const host = $('vaultRecords');
    if (!records.length) { host.className = 'vault-body vault-empty'; host.textContent = '尚未新增任何平台密碼。'; return; }
    host.className = 'vault-body vault-records';
    host.innerHTML = records.map(record => {
      const url = safeUrl(record.url), show = revealed.has(record.id);
      return `<article class="vault-record"><button class="edit" data-edit="${esc(record.id)}" type="button">編輯</button><h4>${esc(record.platform)}</h4>${url ? `<p><a href="${esc(url)}" target="_blank" rel="noopener">${esc(url)}</a></p>` : ''}${record.username ? `<p>帳號：${esc(record.username)}</p>` : ''}<div class="vault-secret"><span>${show ? esc(record.password) : '••••••••••••'}</span><button type="button" data-reveal="${esc(record.id)}">${show ? '隱藏' : '顯示'}</button></div>${record.notes ? `<p class="vault-meta">${esc(record.notes)}</p>` : ''}<div class="vault-actions"><button type="button" class="danger" data-delete="${esc(record.id)}">刪除</button></div></article>`;
    }).join('');
  }

  $('passwordOpenBtn').addEventListener('click', () => { $('passwordVault').classList.remove('hidden'); showInitial(); $('passwordVault').scrollIntoView({ behavior:'smooth', block:'start' }); });
  $('passwordCloseBtn').addEventListener('click', () => lock(true));
  $('vaultLockBtn').addEventListener('click', () => lock());
  $('vaultCancelEditBtn').addEventListener('click', resetForm);
  $('vaultLoadTestBtn').addEventListener('click', async () => {
    if (records.some(record => TEST_RECORDS.some(sample => sample.id === record.id))) return status('vaultRecordStatus', '測試資料已經存在。', 'error');
    if (records.length && !confirm('目前已有紀錄，仍要加入三筆測試資料嗎？')) return;
    records = [...TEST_RECORDS.map(record => ({ ...record })), ...records];
    try { await persist(); renderRecords(); status('vaultRecordStatus', '已加入三筆測試資料，請改成實際帳密。', 'ok'); }
    catch (error) { status('vaultRecordStatus', `載入失敗：${error.message}`, 'error'); }
  });
  $('vaultSetupForm').addEventListener('submit', async event => {
    event.preventDefault(); const password = $('vaultSetupPassword').value, confirmation = $('vaultSetupConfirm').value;
    if (password !== confirmation) return status('vaultSetupStatus', '兩次輸入的主密碼不相同。', 'error');
    try { await verifyMaster(password); salt = crypto.getRandomValues(new Uint8Array(16)); key = await derive(password, salt); records = TEST_RECORDS.map(record => ({ ...record })); await persist(); $('vaultSetupPassword').value = ''; $('vaultSetupConfirm').value = ''; showContents(); status('vaultRecordStatus', '已建立三筆測試資料，請改成實際帳密。', 'ok'); }
    catch (error) { status('vaultSetupStatus', `建立失敗：${error.message}`, 'error'); }
  });
  $('vaultUnlockForm').addEventListener('submit', async event => {
    event.preventDefault(); const password = $('vaultUnlockPassword').value;
    try { await verifyMaster(password); await decrypt(password); }
    catch (error) { status('vaultUnlockStatus', error.message || '主密碼不正確，或保管庫資料已損壞。', 'error'); }
  });
  $('vaultRecordForm').addEventListener('submit', async event => {
    event.preventDefault();
    const form = { platform:$('vaultPlatform').value.trim(), url:$('vaultRecordUrl').value.trim(), username:$('vaultUsername').value.trim(), password:$('vaultRecordPassword').value, notes:$('vaultNotes').value.trim() };
    if (!form.platform || !form.password) return status('vaultRecordStatus', '請填寫平台名稱與密碼。', 'error');
    if (editingId) records = records.map(record => record.id === editingId ? { ...record, ...form } : record);
    else records.unshift({ id:crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}-${Math.random()}`, ...form });
    try { await persist(); resetForm(); renderRecords(); status('vaultRecordStatus', '已加密儲存在這台裝置的瀏覽器。', 'ok'); }
    catch (error) { status('vaultRecordStatus', `儲存失敗：${error.message}`, 'error'); }
  });
  $('vaultRecords').addEventListener('click', async event => {
    const button = event.target.closest('button'); if (!button) return;
    const id = button.dataset.reveal || button.dataset.edit || button.dataset.delete;
    const record = records.find(item => item.id === id); if (!record) return;
    if (button.dataset.reveal) { revealed.has(id) ? revealed.delete(id) : revealed.add(id); renderRecords(); return; }
    if (button.dataset.edit) { editingId = id; $('vaultPlatform').value = record.platform; $('vaultRecordUrl').value = record.url || ''; $('vaultUsername').value = record.username || ''; $('vaultRecordPassword').value = record.password; $('vaultNotes').value = record.notes || ''; $('vaultRecordTitle').textContent = `編輯：${record.platform}`; $('vaultSaveRecordBtn').textContent = '更新紀錄'; $('vaultCancelEditBtn').classList.remove('hidden'); $('vaultPlatform').focus(); return; }
    if (button.dataset.delete) { if (!confirm(`確定刪除「${record.platform}」嗎？`)) return; records = records.filter(item => item.id !== id); try { await persist(); if (editingId === id) resetForm(); renderRecords(); } catch (error) { status('vaultRecordStatus', `刪除失敗：${error.message}`, 'error'); } }
  });
  $('vaultClearBtn').addEventListener('click', () => { if (prompt('這會永久刪除這台裝置上的所有密碼紀錄。請輸入「清除」確認：') !== '清除') return; localStorage.removeItem(STORAGE_KEY); lock(); });
  document.querySelectorAll('[data-vault-toggle]').forEach(button => button.addEventListener('click', () => { const input = $(button.dataset.vaultToggle); input.type = input.type === 'password' ? 'text' : 'password'; button.textContent = input.type === 'password' ? '顯示' : '隱藏'; }));
})();
