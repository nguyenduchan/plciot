/* GENERATED từ packages/security/client/login.js bằng "npm run sync-client". KHÔNG sửa ở đây. */
'use strict';

const LS = {
  get(k, d) { try { return JSON.parse(localStorage.getItem(k)) ?? d; } catch { return d; } },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch {} },
  del(k) { try { localStorage.removeItem(k); } catch {} },
};

const $ = (s) => document.querySelector(s);
const ERR = {
  invalid_credentials: 'Sai số điện thoại hoặc mật khẩu.',
  account_disabled: 'Tài khoản đã bị khoá. Liên hệ quản trị viên.',
  registration_closed: 'Đăng ký tự do đã đóng. Liên hệ quản trị viên để được thêm tài khoản.',
  missing_credentials: 'Nhập số điện thoại.',
  telegram_not_linked: 'SĐT chưa liên kết Telegram. Mở bot → /start → chia sẻ đúng số VN này.',
  user_exists: 'Số này đã là tài khoản. Hãy đăng nhập.',
  user_not_found: 'Chưa có tài khoản. Chọn Đăng ký.',
  weak_password: 'Mật khẩu tối thiểu 6 ký tự.',
  invalid_phone: 'Cần số di động Việt Nam (09… / 03… / 07… / 08…).',
  otp_invalid: 'Mã OTP sai.',
  otp_expired: 'Mã OTP hết hạn. Gửi lại.',
  otp_missing: 'Chưa có OTP. Bấm Gửi OTP trước.',
  otp_format: 'Nhập mã OTP gồm 6 chữ số.',
  otp_locked: 'Nhập sai quá nhiều. Thử lại sau.',
  telegram_send_failed: 'Không gửi được Telegram. Thử lại.',
  rate_limited: 'Bạn thử quá nhiều lần. Đợi vài phút rồi thử lại.',
  session_revoked: 'Phiên đăng nhập đã bị thu hồi. Hãy đăng nhập lại.',
  unauthorized: 'Phiên đăng nhập hết hạn. Hãy đăng nhập lại.',
  forbidden: 'Bạn không có quyền thực hiện thao tác này.',
  cors_denied: 'Địa chỉ truy cập không được phép. Hãy mở đúng địa chỉ của ứng dụng.',
  server_error: 'Máy chủ gặp lỗi. Thử lại sau ít phút.',
  offline: 'Không kết nối được máy chủ. Kiểm tra mạng rồi thử lại.',
  no_passkey: 'Tài khoản này chưa đăng ký vân tay / Face ID. Dùng OTP Telegram.',
  webauthn_failed: 'Vân tay / Face ID không thành công. Thử lại hoặc dùng OTP Telegram.',
  unknown_credential: 'Thiết bị này chưa có vân tay đăng ký. Dùng OTP Telegram.',
};

/** Client-side VN mobile check (canonical 84 + 9 digits). */
function isValidVnPhoneClient(digits84) {
  if (!/^84\d{9}$/.test(digits84)) return false;
  const p2 = digits84.slice(2, 4);
  const ok = /^(32|33|34|35|36|37|38|39|52|55|56|58|59|70|76|77|78|79|81|82|83|84|85|86|87|88|89|90|91|92|93|94|96|97|98|99)$/;
  return ok.test(p2);
}

let mode = 'login'; // login | register
let pendingPhone = '';
let otpPurpose = 'login'; // login | register
let otpResendAt = 0;
let loginBusy = false;

function cacheNameFor(userId, version) {
  return `plc-${userId}-${version}`;
}

function fullPhone() {
  $('#cc').value = '84';
  let ph = ($('#phone').value || '').replace(/\D/g, '');
  if (ph.startsWith('84') && ph.length === 11) return ph;
  if (ph.startsWith('0')) ph = ph.slice(1);
  return '84' + ph;
}

function requireVnPhone() {
  const p = fullPhone();
  if (!isValidVnPhoneClient(p)) {
    setError('invalid_phone');
    return null;
  }
  return p;
}

function setError(codeOrMsg) {
  // mã lỗi chưa có bản dịch vẫn báo bằng tiếng Việt kèm mã để tra cứu, không hiện chữ thô như "rate_limited"
  const raw = String(codeOrMsg || '');
  if (!raw) { $('#error').textContent = ''; return; }
  const coreMessage = window.Security?.errText?.(raw);
  $('#error').textContent = ERR[raw] || (coreMessage && coreMessage !== raw ? coreMessage : /^[a-z][a-z0-9_]+$/.test(raw) ? `Có lỗi (${raw}). Thử lại hoặc dùng phương thức khác.` : raw);
}

function setBusy(on) {
  loginBusy = on;
  ['btn-otp', 'btn-verify', 'btn-back', 'demo', 'btn-passkey', 'btn-resume', 'btn-resend'].forEach((id) => {
    const el = $('#' + id);
    if (el) el.disabled = on || (id === 'btn-resend' && Date.now() < otpResendAt);
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
  // Cache API / Service Worker chỉ có trên HTTPS hoặc localhost. Trên HTTP trong LAN: bỏ qua gói offline, vào thẳng app (cần mạng).
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
  await window.AuthApp?.onAuthenticated?.(data);
  await registerSw();
  if (data.controlToken) LS.set('ctl', { token: data.controlToken, method: data.method, expiresAt: data.expiresAt });
  if (LS.get('reviewDevices', null)?.userId === data.userId) {
    await window.Security.reviewRegisteredDevices();
    LS.del('reviewDevices');
  }
  try { sessionStorage.setItem('app-entry', data.token); } catch {}
  // báo thành công ~1 giây rồi vào trang chính
  await new Promise((r) => setTimeout(r, 900));
  location.replace('index.html');
}

async function api(path, body) {
  let device;
  if (path === '/api/register/verify' || path === '/api/login/verify-otp') {
    if (window.SecurityDevice) {
      device = await window.SecurityDevice.proof(body.phone, 'otp-verify');
      body = { ...body, publicKey: device.publicKey, deviceProof: device.deviceProof };
    }
  }
  const r = await fetch(location.origin + path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Device-Id': device?.deviceId || window.Security?.devId() || '' },
    body: JSON.stringify(body),
  });
  const data = await r.json().catch(() => ({}));
  return { ok: r.ok, status: r.status, data };
}

function showStep(otp) {
  $('#step-creds').hidden = otp;
  $('#step-otp').hidden = !otp;
}

function restoreLogin() {
  stopOtpTimer();
  showStep(false);
  $('#ok-msg').hidden = true;
  $('#progress').classList.remove('on');
}

function applyMode() {
  document.querySelectorAll('#modes button').forEach((b) => {
    b.classList.toggle('on', b.dataset.mode === mode);
  });
  stopOtpTimer();
  showStep(false);
  setError('');
}

let otpTimer = null;
function stopOtpTimer() { if (otpTimer) clearInterval(otpTimer); otpTimer = null; }
function startOtpTimer() {
  stopOtpTimer();
  const expiresAt = Date.now() + 300_000;
  otpResendAt = Date.now() + 60_000;
  const tick = () => {
    const left = Math.max(0, Math.ceil((expiresAt - Date.now()) / 1000));
    const m = String(Math.floor(left / 60)).padStart(2, '0');
    const s = String(left % 60).padStart(2, '0');
    $('#otp-timer').textContent = left > 0 ? `Mã hết hạn sau ${m}:${s}` : 'Mã đã hết hạn. Hãy gửi lại.';
    $('#btn-resend').disabled = loginBusy || Date.now() < otpResendAt;
    if (left <= 0) stopOtpTimer();
  };
  tick();
  otpTimer = setInterval(tick, 1000);
}

async function loadAuthConfig() {
  try {
    const r = await fetch(location.origin + '/api/auth/config');
    const j = await r.json();
    window.AuthApp?.onAuthConfig?.(j);
  } catch {}
}

async function tryResume() {
  const session = LS.get('session', null);
  if (!session || session.demo) return false;
  if (!session.online && !(await hasBundle(session))) return false;
  if (session.online && !session.token) return false;
  // ?update=1 = boot.js đã thử tự cập nhật mà lỗi (hết hạn phiên, mất mạng…): ở lại để đăng nhập tải lại bản mới.
  if (new URLSearchParams(location.search).get('update') === '1') {
    setError('Có bản mới. Đăng nhập lại để tải cập nhật.');
    return false;
  }
  if (!session.token || session.pending) return false;
  const resume = $('#btn-resume');
  resume.hidden = false;
  resume.onclick = async () => {
    if (loginBusy) return;
    setBusy(true);
    setError('');
    try {
      const data = await window.Security.resumeLogin();
      if (data) await finishLogin(data);
      else setError('Chưa xác nhận đăng nhập. Hãy thử lại hoặc dùng OTP.');
    } catch (ex) { restoreLogin(); setError(ex?.name === 'TypeError' ? 'offline' : ex.message || 'unauthorized'); }
    finally { setBusy(false); }
  };
  return false;
}

$('#btn-otp').onclick = async () => {
  if (loginBusy) return;
  setError('');
  const phone = requireVnPhone();
  if (!phone) return;
  setBusy(true);
  try {
    const { ok, data } = await api('/api/login/request-otp', { phone });
    if (!ok) { setError(data.error || data.detail); return; }
    pendingPhone = data.phone || phone;
    $('#otp').value = '';
    otpPurpose = data.purpose === 'register' ? 'register' : 'login';
    $('#otp-info').textContent = otpPurpose === 'register'
      ? 'Xác minh số điện thoại để tạo tài khoản.'
      : 'Xác minh số điện thoại để tiếp tục đăng nhập.';
    showStep(true);
    startOtpTimer();
    $('#otp').focus();
  } catch (ex) {
    setError(ex?.name === 'TypeError' ? 'offline' : ex.message || 'Không kết nối được máy chủ.');
  } finally {
    setBusy(false);
  }
};

$('#btn-verify').onclick = async () => {
  if (loginBusy) return;
  setError('');
  const otp = $('#otp').value.trim();
  if (!/^\d{6}$/.test(otp)) { setError('otp_format'); $('#otp').focus(); return; }
  let consumedOtp = false;
  setBusy(true);
  try {
    const path = otpPurpose === 'register' ? '/api/register/verify' : '/api/login/verify-otp';
    const { ok, data } = await api(path, { phone: pendingPhone, otp });
    if (!ok) { setError(data.error); return; }
    consumedOtp = true;
    stopOtpTimer();
    const verified = await window.Security.completeOtp(data);
    if (!verified) {
      setError('Chưa xác nhận đăng nhập. Hãy xác thực lại OTP để tiếp tục.');
      restoreLogin();
      return;
    }
    $('#step-otp').hidden = true;
    $('#ok-msg').textContent = otpPurpose === 'register' ? '✓ Tạo tài khoản thành công. Đang vào ứng dụng…' : '✓ Đăng nhập thành công. Đang vào ứng dụng…';
    $('#ok-msg').hidden = false;
    await finishLogin(verified);
  } catch (ex) {
    if (consumedOtp) restoreLogin();
    setError(ex?.name === 'TypeError' ? 'offline' : ex.message || 'Không kết nối được máy chủ.');
  } finally {
    setBusy(false);
  }
};

/* Đăng nhập bằng passkey: ưu tiên hàng đầu khi thiết bị hỗ trợ; OTP Telegram là lần đầu / dự phòng. */
async function passkeyLogin() {
  if (loginBusy) return;
  setError('');
  let authenticated = false;
  setBusy(true);
  try {
    window.PlcDebug?.log?.('ui.passkey_click', 'User bấm Đăng nhập Face ID / vân tay');
    const data = await window.Security.loginWithPasskey();
    if (data.error) {
      window.PlcDebug?.log?.('ui.passkey_error', data.error, data, 'error');
      setError(data.error);
      return;
    }
    authenticated = true;
    $('#step-creds').hidden = true;
    $('#ok-msg').textContent = '✓ Đăng nhập thành công. Đang vào ứng dụng…';
    $('#ok-msg').hidden = false;
    window.PlcDebug?.log?.('ui.passkey_ok', 'UI nhận session — đang tải bundle', { userId: data.userId }, 'ok');
    await finishLogin(data);
  } catch (ex) {
    restoreLogin();
    window.PlcDebug?.log?.('ui.passkey_exception', ex?.name || 'error', { name: ex?.name, message: ex?.message }, 'error');
    setError(ex?.name === 'NotAllowedError' ? 'Đã huỷ trên thiết bị.' : ex?.name === 'TypeError' ? 'offline' : authenticated ? ex.message : 'webauthn_failed');
  } finally {
    setBusy(false);
  }
}
// Nút vân tay chỉ hiện khi máy này ĐÃ đăng ký passkey cho tên miền này. Máy chưa đăng ký mà bấm thì trình duyệt
// chuyển sang "dùng thiết bị khác" và hiện mã QR (ngõ cụt), nên người mới/máy mới đi OTP Telegram rồi được mời bật vân tay.
(async () => {
  if (!window.Security?.passkeySupported()) return;
  if (!LS.get('hasPasskey', false)) return;
  $('#btn-passkey').hidden = false;
  $('#btn-passkey').onclick = () => passkeyLogin();
  $('#btn-otp').classList.remove('primary'); // máy đã có vân tay: vân tay là lối chính, OTP là dự phòng
})();

$('#btn-back').onclick = () => { stopOtpTimer(); showStep(false); setError(''); };
$('#btn-resend').onclick = () => $('#btn-otp').onclick();
$('#phone').onkeydown = (event) => { if (event.key === 'Enter') { event.preventDefault(); $('#btn-otp').onclick(); } };
$('#otp').onkeydown = (event) => { if (event.key === 'Enter') { event.preventDefault(); $('#btn-verify').onclick(); } };

if ($('#demo')) $('#demo').onclick = async () => {
  await window.AuthApp?.onDemo?.();
  LS.set('session', { demo: true, apiBase: location.origin });
  await registerSw();
  location.replace('index.html');
};

applyMode();
{
  const q = new URLSearchParams(location.search);
  if (q.get('changed')) setError('Đã đổi số điện thoại. Hãy đăng nhập bằng số mới.');
  else if (q.get('revoked')) setError('Phiên đã bị thu hồi (đổi số/khôi phục tài khoản). Vui lòng đăng nhập lại.');
}
loadAuthConfig();
tryResume();
