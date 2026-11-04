'use strict';

const LS = {
  get(k, d) { try { return JSON.parse(localStorage.getItem(k)) ?? d; } catch { return d; } },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch {} },
  del(k) { try { localStorage.removeItem(k); } catch {} },
};

const $ = (s) => document.querySelector(s);
const ERR = {
  account_disabled: 'Tài khoản đã bị khoá. Liên hệ quản trị viên.',
  registration_closed: 'Đăng ký đã đóng. Liên hệ quản trị viên.',
  rate_limited: 'Bạn thử quá nhiều lần. Đợi vài phút rồi thử lại.',
  session_revoked: 'Phiên đăng nhập đã bị thu hồi. Hãy đăng nhập lại.',
  unauthorized: 'Phiên đăng nhập hết hạn. Hãy đăng nhập lại.',
  server_error: 'Máy chủ gặp lỗi. Thử lại sau ít phút.',
  offline: 'Không kết nối được máy chủ. Kiểm tra mạng rồi thử lại.',
  no_passkey: 'Tài khoản này chưa đăng ký vân tay / Face ID. Dùng mật khẩu hoặc mã khôi phục.',
  webauthn_failed: 'Vân tay / Face ID không thành công. Thử lại.',
  unknown_credential: 'Thiết bị này chưa có vân tay đăng ký.',
  password_required: 'Nhập mật khẩu.',
  password_invalid: 'Sai mật khẩu.',
  password_new_device: 'Máy mới chưa tin cậy. Dùng «Khôi phục» với mã khôi phục + mật khẩu (Face ID máy cũ không mang sang; không quét lại QR tem).',
  device_already_claimed: 'Thiết bị đã có chủ. Đăng nhập tài khoản hiện có hoặc dùng mã mời — không claim QR lại.',
  site_taken: 'Thiết bị đã có người dùng.',
  invalid_claim_payload: 'Mã QR không hợp lệ.',
  invalid_claim_signature: 'Mã QR không xác thực được (tem giả hoặc khoá sai).',
  unknown_device: 'Thiết bị chưa được đăng ký trên máy chủ.',
  invalid_invite: 'Mã mời không hợp lệ.',
  invite_expired: 'Mã mời đã hết hạn.',
  privacy_consent_required: 'Cần đồng ý Thông báo bảo vệ dữ liệu cá nhân trước khi nhận máy / mã mời.',
  privacy_version_mismatch: 'Thông báo bảo vệ dữ liệu đã cập nhật. Tải lại trang rồi đồng ý phiên bản mới.',
  recover_need_two: 'Cần ít nhất 2 yếu tố khác loại.',
  recover_invalid: 'Khôi phục thất bại. Kiểm tra lại thông tin.',
  username_invalid: 'Tên đăng nhập 4–32 ký tự: chữ thường, số, _ . - và phải bắt đầu bằng chữ.',
  username_taken: 'Tên đăng nhập đã có người dùng. Hãy chọn tên khác.',
  password_weak: 'Mật khẩu cần 8–72 ký tự và không chứa tên đăng nhập.',
  channel_disabled: 'Kênh này đã tắt. Dùng QR thiết bị hoặc passkey/mật khẩu.',
};

let privacyVersion = '2026-11-01';

function privacyPayload() {
  return { consent: true, privacyVersion };
}

function requireConsentChecked(boxId = 'privacy-consent', rowId = 'privacy-row') {
  if ($('#' + boxId)?.checked) return true;
  setError('privacy_consent_required');
  $('#' + rowId)?.scrollIntoView?.({ block: 'nearest' });
  return false;
}

let loginBusy = false;
let flowPlan = null;
let trustDays = 30;

function cacheNameFor(userId, version) {
  return `plc-${userId}-${version}`;
}

const isNetworkError = (ex) => /failed to fetch|load failed|networkerror|network request failed|fetch/i.test(String(ex?.message || ''));
const errCode = (ex, fallback) => (ex?.name === 'TypeError' && isNetworkError(ex) ? 'offline' : ex?.name === 'TypeError' ? `Lỗi trình duyệt (${ex.message})` : ex?.message || fallback);

function setError(codeOrMsg) {
  const raw = String(codeOrMsg || '');
  if (!raw) { $('#error').textContent = ''; return; }
  const coreMessage = window.Security?.errText?.(raw);
  $('#error').textContent = ERR[raw] || (coreMessage && coreMessage !== raw ? coreMessage : /^[a-z][a-z0-9_]+$/.test(raw) ? `Có lỗi (${raw}). Thử lại hoặc dùng phương thức khác.` : raw);
}

function setBusy(on) {
  loginBusy = on;
  ['btn-register', 'tab-login', 'tab-register', 'btn-claim', 'btn-invite', 'btn-passkey', 'btn-login', 'btn-next', 'lnk-use-pw', 'rc-go', 'rc-back', 'rc-bio', 'demo'].forEach((id) => {
    const el = $('#' + id);
    if (el) el.disabled = on;
  });
}

async function hasBundle(session) {
  if (!session?.cacheName || !('caches' in window)) return false;
  return caches.has(session.cacheName);
}

async function setActiveMeta(cacheName, userId, version) {
  const meta = await caches.open('plc-meta');
  await meta.put('/active', new Response(JSON.stringify({ cacheName, userId, version }), {
    headers: { 'Content-Type': 'application/json' },
  }));
}

async function putBundleFiles(token, files, cacheName, base) {
  const cache = await caches.open(cacheName);
  const total = files.length || 1;
  let done = 0;
  const bar = $('#prog-bar');
  const label = $('#prog-label');
  $('#progress').classList.add('on');

  for (const f of files) {
    const abs = new URL(f.path, location.origin).href;
    let stored = await cache.match(abs);
    if (!stored) {
      label.textContent = `Đang tải (${done + 1}/${files.length}): ${f.path}`;
      const url = `${base}/api/bundle/${f.path.split('/').map(encodeURIComponent).join('/')}`;
      const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
      if (!res.ok) throw new Error(`Tải thất bại: ${f.path} (${res.status})`);
      const buf = await res.arrayBuffer();
      const headers = new Headers(res.headers);
      headers.set('Cache-Control', 'public, max-age=31536000');
      stored = new Response(buf, { status: 200, statusText: 'OK', headers });
      await cache.put(abs, stored.clone());
    }
    if (f.path === 'index.html') {
      await cache.put(new URL('./', location.origin).href, stored.clone());
      await cache.put(new URL('/', location.origin).href, stored.clone());
    }
    done++;
    bar.style.width = `${Math.round((done / total) * 100)}%`;
  }
  label.textContent = 'Hoàn tất';
}

async function registerSw() {
  if (!('serviceWorker' in navigator) || !location.protocol.startsWith('http')) return;
  try {
    await navigator.serviceWorker.register('sw.js', { scope: './' });
    await navigator.serviceWorker.ready;
  } catch {}
}

async function finishLogin(data) {
  const base = location.origin;
  const offlineOk = 'caches' in window;
  const cacheName = offlineOk ? cacheNameFor(data.userId, data.version) : null;
  if (offlineOk) {
    await putBundleFiles(data.token, data.files || [], cacheName, base);
    await setActiveMeta(cacheName, data.userId, data.version);
    const keys = await caches.keys();
    await Promise.all(keys.filter((k) => k.startsWith('plc-') && k !== cacheName && k !== 'plc-meta')
      .map((k) => caches.delete(k)));
  }
  LS.set('session', {
    token: data.token,
    userId: data.userId,
    username: data.username,
    role: data.role,
    version: data.version,
    cacheName,
    apiBase: base,
    online: !offlineOk,
  });
  if (data.username) LS.set('lastUsername', data.username);
  LS.set('deviceAt', Date.now());
  await window.AuthApp?.onAuthenticated?.(data);
  await registerSw();
  if (data.recovered) await window.Security.recoverySetup();
  if (LS.get('wantPasskey', false) && !LS.get('hasPasskey', false) && window.Security?.passkeySupported()) {
    LS.del('wantPasskey');
    try { await window.Security.enrollPasskeyNow(); } catch (ex) {
      if (ex?.name !== 'NotAllowedError' && ex?.message !== 'cancelled') {
        await window.Security.notice('Chưa bật được vân tay / Face ID', `${ex?.name || 'Lỗi'}: ${ex?.message || 'không rõ'}. Bạn có thể thử lại trong Cài đặt.`);
      }
    }
  }
  if (data.controlToken) LS.set('ctl', { token: data.controlToken, method: data.method, expiresAt: data.expiresAt });
  if (LS.get('reviewDevices', null)?.userId === data.userId) {
    await window.Security.reviewRegisteredDevices();
    LS.del('reviewDevices');
  }
  try { sessionStorage.setItem('app-entry', data.token); } catch {}
  await new Promise((r) => setTimeout(r, 900));
  location.replace('index.html');
}

async function api(path, body) {
  try { await window.SecurityDevice?.ready?.(); } catch { /* không có IndexedDB: dùng mã trong localStorage */ }
  let device;
  const needProof = path === '/api/login/password' || path === '/api/login/recover';
  if (needProof && window.SecurityDevice) {
    const subject = body.username || body.phone || '';
    try {
      device = await window.SecurityDevice.proof(subject, path === '/api/login/password' ? 'password-login' : 'recover');
    } catch (ex) {
      throw new Error(['secure_context_required', 'device_storage_unavailable'].includes(ex?.message)
        ? ex.message
        : `Không tạo được chứng minh thiết bị (${ex?.name || 'Error'}: ${ex?.message || ''})`);
    }
    body = { ...body, publicKey: device.publicKey, deviceProof: device.deviceProof };
  }
  const r = await fetch(location.origin + path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Device-Id': device?.deviceId || window.Security?.devId() || '' },
    body: JSON.stringify(body),
  });
  const data = await r.json().catch(() => ({}));
  return { ok: r.ok, status: r.status, data };
}

function restoreLogin() {
  $('#ok-msg').hidden = true;
  $('#progress').classList.remove('on');
  $('#step-creds').hidden = false;
  if ($('#step-recover')) $('#step-recover').hidden = true;
  if ($('#auth-tabs')) $('#auth-tabs').hidden = false;
  if ($('#rc-open-row')) $('#rc-open-row').hidden = false;
}

const localTrusted = () => {
  const t = LS.get('deviceAt', 0) || LS.get('otpAt', 0);
  return Boolean(t) && Date.now() - t < trustDays * 86_400_000;
};

async function loadAuthConfig() {
  try {
    const r = await fetch(location.origin + '/api/auth/config');
    const j = await r.json();
    if (Number(j.deviceTrustDays || j.otpTrustDays) > 0) trustDays = Number(j.deviceTrustDays || j.otpTrustDays);
    if (j.privacyVersion) privacyVersion = String(j.privacyVersion);
    if (j.registrationOpen === false) {
      registrationOpen = false;
      $('#tab-register').hidden = true;
      if (!$('#pane-register').hidden) showTab('login');
    }
    const link = $('#privacy-link');
    if (link && j.privacyUrl) link.href = j.privacyUrl;
    window.AuthApp?.onAuthConfig?.(j);
  } catch {}
}

async function tryResume() {
  const session = LS.get('session', null);
  if (!session || session.demo) return false;
  if (!session.online && !(await hasBundle(session))) return false;
  if (session.online && !session.token) return false;
  if (new URLSearchParams(location.search).get('update') === '1') setError('Có bản mới. Đăng nhập lại để tải cập nhật.');
  return false;
}

/** Sau claim/invite: phiên chờ → bắt buộc setup passkey/password rồi vào app. */
async function afterPending(data, doneMsg = '✓ Thiết bị đã gắn. Đang vào ứng dụng…') {
  LS.set('session', { token: data.token, userId: data.userId, username: data.username, apiBase: location.origin, online: true, gate: 'setup' });
  if (data.username) LS.set('lastUsername', data.username);
  LS.set('deviceAt', Date.now());
  let verified;
  try { verified = await window.Security.completeOtp(data); } catch (ex) {
    window.PlcDebug?.log?.('register.exit', 'completeOtp lỗi', { name: ex?.name, message: ex?.message }, 'error');
    throw ex;
  }
  if (!verified) {
    window.PlcDebug?.log?.('register.exit', 'Thiết lập bị huỷ/không hoàn tất → quay lại form', {}, 'warn');
    LS.del('session');
    setError('Chưa hoàn tất thiết lập bảo mật.');
    restoreLogin();
    return false;
  }
  $('#ok-msg').textContent = doneMsg;
  $('#ok-msg').hidden = false;
  await finishLogin(verified);
  return true;
}

async function claimDevice() {
  if (loginBusy) return;
  setError('');
  const qr = ($('#claim-qr')?.value || '').trim();
  if (!qr) { setError('Dán hoặc quét mã QR trên tem thiết bị.'); return; }
  if (!requireConsentChecked()) return;
  setBusy(true);
  try {
    const { ok, data } = await api('/api/devices/claim', { qr, ...privacyPayload() });
    if (!ok) { setError(data.error || 'server_error'); return; }
    await afterPending(data);
  } catch (ex) {
    restoreLogin();
    setError(errCode(ex, 'Không kết nối được máy chủ.'));
  } finally {
    setBusy(false);
  }
}

async function redeemInvite() {
  if (loginBusy) return;
  setError('');
  $('#invite-row').hidden = false;
  if ($('#more-device')) $('#more-device').open = true;
  const code = ($('#invite-code')?.value || '').trim();
  if (!code) { setError('Nhập mã mời.'); $('#invite-code')?.focus(); return; }
  if (!requireConsentChecked()) return;
  setBusy(true);
  try {
    const { ok, data } = await api('/api/invites/redeem', { token: code, ...privacyPayload() });
    if (!ok) { setError(data.error || 'server_error'); return; }
    await afterPending(data);
  } catch (ex) {
    restoreLogin();
    setError(errCode(ex, 'Không kết nối được máy chủ.'));
  } finally {
    setBusy(false);
  }
}

async function passkeyLogin() {
  if (loginBusy) return;
  setError('');
  setBusy(true);
  try {
    const data = await window.Security.loginWithPasskey();
    if (!data) return;
    if (flowPlan?.mustEnroll) {
      LS.set('session', { token: data.token, userId: data.userId, apiBase: location.origin, online: true, gate: 'bio' });
      const r = await window.Security.enrollMandatory();
      if (r === 'cancel') { LS.del('session'); setError('Chưa bật sinh trắc nên chưa vào được.'); return; }
    }
    $('#ok-msg').textContent = '✓ Đăng nhập thành công. Đang vào ứng dụng…';
    $('#ok-msg').hidden = false;
    await finishLogin(data);
  } catch (ex) {
    if (ex?.name === 'NotAllowedError') setError('Đã huỷ trên thiết bị.');
    else setError(errCode(ex, 'webauthn_failed'));
  } finally {
    setBusy(false);
  }
}

async function passwordLogin() {
  if (loginBusy) return false;
  const username = ($('#username')?.value || LS.get('lastUsername', '')).trim();
  const password = $('#password')?.value;
  if (!username) { setError('Nhập tên tài khoản.'); $('#username-row').hidden = false; return false; }
  if (!password) { setError('password_required'); $('#password')?.focus(); return false; }
  setBusy(true);
  try {
    let { ok, data } = await api('/api/login/password', { username, password });
    // Máy mới: Face ID máy cũ không khớp — không thử passkey; hướng dẫn khôi phục.
    if (!ok && data.error === 'password_new_device' && localTrusted() && window.Security?.passkeySupported() && LS.get('hasPasskey', false)) {
      setError('');
      try {
        const proof = await window.Security.passkeyProof();
        ({ ok, data } = await api('/api/login/password', { username, password, cid: proof.cid, credential: proof.credential }));
      } catch (ex) {
        setError(ex?.name === 'NotAllowedError' ? 'Đã huỷ Face ID. Thử «Khôi phục» bằng mã khôi phục.' : 'webauthn_failed');
        return false;
      }
    }
    if (!ok) { setError(data.error || 'password_invalid'); return false; }
    if (flowPlan?.mustEnroll) {
      LS.set('session', { token: data.token, userId: data.userId, apiBase: location.origin, online: true, gate: 'bio' });
      const r = await window.Security.enrollMandatory();
      if (r === 'cancel') { LS.del('session'); setError('Chưa bật sinh trắc nên chưa vào được.'); return false; }
    }
    $('#ok-msg').textContent = '✓ Đăng nhập thành công. Đang vào ứng dụng…';
    $('#ok-msg').hidden = false;
    await finishLogin(data);
    return true;
  } catch (ex) {
    restoreLogin();
    setError(errCode(ex, 'Không kết nối được máy chủ.'));
    return false;
  } finally {
    setBusy(false);
  }
}

/** Luôn cho chọn một trong hai cách như app ngân hàng: nhập tên + mật khẩu, hoặc bấm Face ID / vân tay (không cần gõ tên: passkey tự nhận tài khoản). */
async function showFaceIdOption() {
  if (!window.Security?.passkeySupported()) return;
  let bio;
  try { bio = await window.Security.bioInfo(); } catch { return; }
  if (!bio.supported) return;
  $('#btn-passkey').textContent = `Đăng nhập bằng ${bio.label}`;
  $('#btn-passkey').className = 'fit';
  $('#btn-passkey').hidden = false;
  $('#btn-passkey').onclick = () => passkeyLogin();
  if ($('#or-sep')) $('#or-sep').hidden = $('#btn-login').hidden;
  if (!document.body.classList.contains('returning')) {
    $('#flow-hint').textContent = `Chọn 1 cách đăng nhập: nhập tên đăng nhập + mật khẩu, hoặc bấm «Đăng nhập bằng ${bio.label}». Chưa có tài khoản? Chọn tab «Đăng ký».`;
  }
}

/** Màn hình mặc định: mật khẩu là chính; QR claim phụ; Face ID chỉ khi máy tin cậy. */
function passwordFirstView() {
  document.body.classList.remove('returning');
  const username = LS.get('lastUsername', '') || '';
  if ($('#username') && username) $('#username').value = username;
  $('#username-row').hidden = false;
  $('#pw-row').hidden = false;
  $('#btn-login').hidden = false;
  $('#btn-login').className = 'primary';
  $('#btn-login').textContent = 'Đăng nhập bằng mật khẩu';
  $('#claim-row').hidden = false;
  $('#btn-claim').hidden = false;
  $('#btn-claim').className = 'fit';
  $('#btn-invite').hidden = false;
  $('#lnk-use-pw').hidden = true;
  $('#flow-hint').textContent = 'Đăng nhập bằng tên đăng nhập + mật khẩu đã lưu. Chưa có tài khoản? Chọn tab «Đăng ký».';
  $('#switch-row').hidden = true;
}

async function returningView() {
  const username = LS.get('lastUsername', '') || LS.get('lastPhone', '');
  if (!localTrusted() || !username) return false;
  let plan;
  try {
    const r = await api('/api/login/start', { username });
    if (!r.ok) return false;
    plan = r.data;
  } catch { return false; }
  const bio = await window.Security.bioInfo();
  const canBio = bio.supported && plan.hasPasskey;
  if (!canBio && !plan.hasPassword) return false;
  flowPlan = { ...plan, bio, mustEnroll: bio.supported && !plan.hasPasskey };
  if ($('#username')) $('#username').value = username;
  $('#username-row').hidden = false;
  document.body.classList.add('returning');
  // Máy tin cậy: Face ID tiện lợi; mật khẩu luôn sẵn làm dự phòng.
  $('#flow-hint').textContent = canBio
    ? `Chọn 1 cách đăng nhập ${username}: mật khẩu hoặc ${bio.label}.`
    : `Đăng nhập ${username} bằng mật khẩu.`;
  $('#claim-row').hidden = true;
  $('#btn-claim').hidden = true;
  $('#btn-invite').hidden = true;
  $('#btn-passkey').hidden = !canBio;
  if (canBio) {
    $('#btn-passkey').className = 'fit';
    $('#btn-passkey').textContent = `Đăng nhập bằng ${bio.label}`;
    $('#btn-passkey').onclick = () => passkeyLogin();
  }
  $('#pw-row').hidden = !plan.hasPassword;
  $('#btn-login').hidden = !plan.hasPassword;
  if (plan.hasPassword) {
    $('#btn-login').className = 'primary';
    $('#btn-login').textContent = 'Đăng nhập bằng mật khẩu';
  }
  $('#switch-row').hidden = false;
  $('#lnk-switch').onclick = (event) => {
    event.preventDefault();
    LS.del('deviceAt'); LS.del('otpAt'); LS.del('lastUsername');
    document.body.classList.remove('returning');
    passwordFirstView();
    location.reload();
  };
  return true;
}

/* ---------- Tab Đăng nhập / Đăng ký ---------- */
let registrationOpen = true;
function showTab(name) {
  const reg = name === 'register' && registrationOpen;
  $('#pane-login').hidden = reg;
  $('#pane-register').hidden = !reg;
  for (const [id, on] of [['tab-login', !reg], ['tab-register', reg]]) {
    const tab = $('#' + id);
    tab.classList.toggle('on', on);
    tab.setAttribute('aria-selected', String(on));
    tab.tabIndex = on ? 0 : -1;
  }
  setError('');
  $('#ok-msg').hidden = true;
  if (reg) {
    document.body.classList.remove('returning');
    syncRegisterBioHint();
    $('#reg-username')?.focus();
  }
}
$('#tab-login').onclick = () => showTab('login');
$('#tab-register').onclick = () => showTab('register');
$('#auth-tabs').onkeydown = (event) => {
  if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return;
  const next = event.key === 'ArrowRight' ? 'register' : 'login';
  showTab(next);
  $('#tab-' + next).focus();
};

async function syncRegisterBioHint() {
  if (!window.Security) return;
  try {
    const bio = await window.Security.bioInfo();
    const steps = bio.supported
      ? ['Chọn tên đăng nhập', `Thêm ${bio.label} (bắt buộc)`, 'Tạo mật khẩu']
      : ['Chọn tên đăng nhập', 'Tạo mật khẩu'];
    const list = $('#reg-steps');
    if (list) list.innerHTML = steps.map((t, i) => `<li${i === 0 ? ' class="on"' : ''}>${t.replace(/</g, '&lt;')}</li>`).join('');
    document.querySelector('#pane-register .flow-title').textContent = `Bước 1/${steps.length}: Tên đăng nhập`;
    $('#reg-bio-hint').textContent = bio.supported
      ? `Bước tiếp theo máy sẽ yêu cầu thêm ${bio.label} — không bỏ qua được.`
      : 'Máy này chưa hỗ trợ vân tay / Face ID nên tài khoản chỉ dùng mật khẩu.';
  } catch {}
}

const USERNAME_RE = /^[a-z][a-z0-9_.-]{3,31}$/;
/** Bước 1/3: chọn username → server tạo phiên chờ; bước 2 (sinh trắc) và 3 (mật khẩu) chạy trong completeOtp. */
async function registerAccount() {
  if (loginBusy) return;
  setError('');
  const username = ($('#reg-username')?.value || '').trim().toLowerCase();
  if (!USERNAME_RE.test(username)) { setError('username_invalid'); $('#reg-username')?.focus(); return; }
  if (!requireConsentChecked('reg-privacy-consent', 'reg-privacy-row')) return;
  window.PlcDebug?.setPhone?.(username);
  setBusy(true);
  try {
    const { ok, data } = await api('/api/register', { username, ...privacyPayload() });
    if (!ok) { setError(data.error || 'server_error'); return; }
    await afterPending({ ...data, username: data.username || username, registering: true },
      '✓ Đăng ký thành công. Đang vào ứng dụng…');
  } catch (ex) {
    restoreLogin();
    setError(errCode(ex, 'Không kết nối được máy chủ.'));
  } finally {
    setBusy(false);
  }
}
$('#btn-register').onclick = () => registerAccount();
$('#reg-username')?.addEventListener('keydown', (event) => {
  if (event.key === 'Enter') { event.preventDefault(); registerAccount(); }
});

$('#btn-claim').onclick = () => claimDevice();
$('#btn-invite').onclick = () => {
  if ($('#invite-row').hidden) {
    $('#invite-row').hidden = false;
    $('#invite-code')?.focus();
    return;
  }
  redeemInvite();
};
$('#btn-login').onclick = () => passwordLogin();
$('#lnk-use-pw').onclick = () => {
  $('#username-row').hidden = false;
  $('#pw-row').hidden = false;
  $('#btn-login').hidden = false;
};
$('#password') && ($('#password').onkeydown = (event) => {
  if (event.key === 'Enter') { event.preventDefault(); passwordLogin(); }
});

if ($('#demo')) {
  $('#demo').onclick = async () => {
    await window.AuthApp?.onDemo?.();
    LS.set('session', { demo: true, apiBase: location.origin });
    await registerSw();
    location.replace('index.html');
  };
}

/* Khôi phục: mã khôi phục + mật khẩu / passkey */
const recover = { bio: null };
function recoverGroups() {
  return [
    $('#rc-otp')?.value.trim() && 'recovery',
    $('#rc-pw')?.value && 'knowledge',
    recover.bio && 'device',
  ].filter(Boolean);
}
function recoverState() {
  const g = recoverGroups();
  if ($('#rc-state')) {
    $('#rc-state').textContent = g.length >= 2
      ? '✓ Đủ 2 yếu tố khác loại. Bấm Khôi phục.'
      : `Đã có ${g.length}/2 yếu tố khác loại.`;
  }
  if ($('#rc-go')) $('#rc-go').disabled = loginBusy || g.length < 2;
}
if ($('#rc-open')) {
  $('#rc-open').onclick = (event) => {
    event.preventDefault();
    setError('');
    if ($('#rc-phone')) $('#rc-phone').value = LS.get('lastUsername', '');
    $('#step-creds').hidden = true;
    $('#auth-tabs').hidden = true;
    $('#rc-open-row').hidden = true;
    $('#step-recover').hidden = false;
    recover.bio = null;
    recoverState();
  };
}
if ($('#rc-back')) {
  $('#rc-back').onclick = () => {
    $('#step-recover').hidden = true;
    $('#step-creds').hidden = false;
    $('#auth-tabs').hidden = false;
    $('#rc-open-row').hidden = false;
    setError('');
  };
}
for (const id of ['rc-otp', 'rc-pw']) {
  if ($('#' + id)) $('#' + id).oninput = recoverState;
}
if ($('#rc-bio')) {
  $('#rc-bio').onclick = async () => {
    if (loginBusy) return;
    setError('');
    setBusy(true);
    try {
      recover.bio = await window.Security.passkeyProof();
      $('#rc-bio').textContent = '✓ Đã xác nhận vân tay / Face ID';
    } catch (ex) {
      recover.bio = null;
      setError(ex?.name === 'NotAllowedError' ? 'Đã huỷ trên thiết bị.' : 'webauthn_failed');
    } finally { setBusy(false); recoverState(); }
  };
}
if ($('#rc-go')) {
  $('#rc-go').onclick = async () => {
    if (loginBusy) return;
    setError('');
    const username = ($('#rc-phone')?.value || '').trim();
    if (!username) { setError('Nhập tên tài khoản.'); return; }
    if (recoverGroups().length < 2) { setError('recover_need_two'); return; }
    setBusy(true);
    try {
      const body = { username };
      if ($('#rc-otp')?.value.trim()) body.recoveryCode = $('#rc-otp').value.trim();
      if ($('#rc-pw')?.value) body.password = $('#rc-pw').value;
      if (recover.bio) { body.cid = recover.bio.cid; body.credential = recover.bio.credential; }
      const { ok, data } = await api('/api/login/recover', body);
      if (!ok) {
        setError(data.error || 'recover_invalid');
        recover.bio = null;
        $('#rc-bio').textContent = 'Xác nhận bằng vân tay / Face ID';
        return;
      }
      $('#step-recover').hidden = true;
      $('#ok-msg').textContent = '✓ Khôi phục thành công. Đang vào ứng dụng…';
      $('#ok-msg').hidden = false;
      await finishLogin(data);
    } catch (ex) {
      restoreLogin();
      setError(errCode(ex, 'Không kết nối được máy chủ.'));
    } finally {
      setBusy(false);
      recoverState();
    }
  };
}

(async () => {
  await loadAuthConfig();
  await tryResume();
  const returned = await returningView();
  if (!returned) passwordFirstView();
  await showFaceIdOption(); // luôn hiện cạnh ô mật khẩu nếu máy hỗ trợ sinh trắc
  const q = new URLSearchParams(location.search);
  if (q.get('revoked')) setError('Phiên đã bị thu hồi. Vui lòng đăng nhập lại.');
  // Deeplink: ?claim=... hoặc ?invite=...
  const claim = q.get('claim');
  const invite = q.get('invite');
  if (q.get('tab') === 'register') showTab('register');
  if (claim && $('#claim-qr')) {
    if ($('#more-device')) $('#more-device').open = true;
    $('#claim-qr').value = claim;
    claimDevice();
  } else if (invite) {
    $('#invite-row').hidden = false;
    if ($('#more-device')) $('#more-device').open = true;
    if ($('#invite-code')) $('#invite-code').value = invite;
    redeemInvite();
  } else if (returned && LS.get('hasPasskey', false) && localTrusted() && !q.get('out')) {
    // Chỉ tự Face ID trên máy đã tin cậy (returning) — không tự thử trên máy mới.
    await new Promise((r) => setTimeout(r, 400));
    if (!loginBusy && !LS.get('session', null)?.token) passkeyLogin();
  }
})();
