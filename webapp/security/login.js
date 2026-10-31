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
  password_required: 'Nhập mật khẩu.',
};

/** Client-side VN mobile check (canonical 84 + 9 digits). */
function isValidVnPhoneClient(digits84) {
  if (!/^84\d{9}$/.test(digits84)) return false;
  const p2 = digits84.slice(2, 4);
  const ok = /^(32|33|34|35|36|37|38|39|52|55|56|58|59|70|76|77|78|79|81|82|83|84|85|86|87|88|89|90|91|92|93|94|96|97|98|99)$/;
  return ok.test(p2);
}

const mode = 'login'; // Một luồng duy nhất: số chưa có tài khoản tự đi đường đăng ký (server quyết định)
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

// Chỉ báo "không kết nối được máy chủ" khi fetch thật sự lỗi mạng; lỗi khác (khoá thiết bị, bộ nhớ…) hiện đúng nguyên nhân.
const isNetworkError = (ex) => /failed to fetch|load failed|networkerror|network request failed|fetch/i.test(String(ex?.message || ''));
const errCode = (ex, fallback) => (ex?.name === 'TypeError' && isNetworkError(ex) ? 'offline' : ex?.name === 'TypeError' ? `Lỗi trình duyệt (${ex.message})` : ex?.message || fallback);

function setError(codeOrMsg) {
  // mã lỗi chưa có bản dịch vẫn báo bằng tiếng Việt kèm mã để tra cứu, không hiện chữ thô như "rate_limited"
  const raw = String(codeOrMsg || '');
  if (!raw) { $('#error').textContent = ''; return; }
  const coreMessage = window.Security?.errText?.(raw);
  $('#error').textContent = ERR[raw] || (coreMessage && coreMessage !== raw ? coreMessage : /^[a-z][a-z0-9_]+$/.test(raw) ? `Có lỗi (${raw}). Thử lại hoặc dùng phương thức khác.` : raw);
}

function setBusy(on) {
  loginBusy = on;
  ['btn-otp', 'btn-verify', 'btn-back', 'demo', 'btn-passkey', 'btn-resume', 'btn-resend', 'btn-login', 'btn-next', 'rc-tg', 'rc-mail', 'rc-bio', 'rc-go', 'rc-back'].forEach((id) => {
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
  if (data.recovered) await window.Security.recoverySetup();
  if (LS.get('wantPasskey', false) && !LS.get('hasPasskey', false) && window.Security?.passkeySupported()) {
    LS.del('wantPasskey');
    try { await window.Security.enrollPasskeyNow(); } catch (ex) {
      // Huỷ trên thiết bị (NotAllowedError) thì im lặng; lỗi khác nói rõ. Dù sao vẫn vào app (đã đăng nhập bằng mật khẩu/OTP), bật lại trong Cài đặt.
      if (ex?.name !== 'NotAllowedError' && ex?.message !== 'cancelled') await window.Security.notice('Chưa bật được vân tay / Face ID', `${ex?.name || 'Lỗi'}: ${ex?.message || 'không rõ'}. Bạn có thể thử lại trong Cài đặt.`);
    }
  }
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
  if (path === '/api/register/verify' || path === '/api/login/verify-otp' || path === '/api/login/password' || path === '/api/login/recover') {
    if (window.SecurityDevice) {
      try { device = await window.SecurityDevice.proof(body.phone, path === '/api/login/password' ? 'password-login' : path === '/api/login/recover' ? 'recover' : 'otp-verify'); } catch (ex) {
        throw new Error(['secure_context_required', 'device_storage_unavailable'].includes(ex?.message) ? ex.message : `Không tạo được chứng minh thiết bị (${ex?.name || 'Error'}: ${ex?.message || ''})`);
      }
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
  if ($('#step-recover')) $('#step-recover').hidden = true;
}

function restoreLogin() {
  stopOtpTimer();
  showStep(false);
  $('#ok-msg').hidden = true;
  $('#progress').classList.remove('on');
}

function applyMode() {
  $('#btn-next').textContent = 'Tiếp tục';
  resetFlowUi();
  syncPasskeyButton();
  stopOtpTimer();
  showStep(false);
  setError('');
}

let otpTimer = null;
function stopOtpTimer() { if (otpTimer) clearInterval(otpTimer); otpTimer = null; }
function startOtpTimer(ttlSec = 180) {
  stopOtpTimer();
  const expiresAt = Date.now() + Math.max(30, Number(ttlSec) || 180) * 1000;
  otpResendAt = expiresAt; // chỉ cho gửi lại sau khi mã cũ hết hạn (5 phút); trong lúc chờ ẩn nút để khỏi bấm nhầm
  const tick = () => {
    const left = Math.max(0, Math.ceil((expiresAt - Date.now()) / 1000));
    const m = String(Math.floor(left / 60)).padStart(2, '0');
    const s = String(left % 60).padStart(2, '0');
    $('#otp-timer').textContent = left > 0 ? `Mã hết hạn sau ${m}:${s}` : 'Mã đã hết hạn. Hãy gửi lại.';
    const waiting = Date.now() < otpResendAt;
    $('#btn-resend').hidden = waiting;
    $('#btn-resend').disabled = loginBusy || waiting;
    if (left <= 0) stopOtpTimer();
  };
  tick();
  otpTimer = setInterval(tick, 1000);
}

let trustDays = 30;
/** Máy chưa xác nhận OTP (hoặc đã quá hạn tin cậy) thì chỉ hiện nhập số điện thoại + OTP, không gợi ý bước sau. */
const localTrusted = () => { const t = LS.get('otpAt', 0); return Boolean(t) && Date.now() - t < trustDays * 86_400_000; };

async function loadAuthConfig() {
  try {
    const r = await fetch(location.origin + '/api/auth/config');
    const j = await r.json();
    if (Number(j.otpTrustDays) > 0) trustDays = Number(j.otpTrustDays);
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
    } catch (ex) { restoreLogin(); setError(errCode(ex, 'unauthorized')); }
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
    LS.set('lastPhone', pendingPhone);
    $('#otp').value = '';
    otpPurpose = data.purpose === 'register' ? 'register' : 'login';
    $('#otp-info').textContent = otpPurpose === 'register'
      ? 'Xác minh số điện thoại để tạo tài khoản.'
      : 'Xác minh số điện thoại để tiếp tục đăng nhập.';
    showStep(true);
    startOtpTimer(data.expiresIn);
    $('#otp').focus();
  } catch (ex) {
    setError(errCode(ex, 'Không kết nối được máy chủ.'));
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
    LS.set('otpAt', Date.now());
    $('#step-otp').hidden = true;
    $('#ok-msg').textContent = otpPurpose === 'register' ? '✓ Tạo tài khoản thành công. Đang vào ứng dụng…' : '✓ Đăng nhập thành công. Đang vào ứng dụng…';
    $('#ok-msg').hidden = false;
    await finishLogin(verified);
  } catch (ex) {
    if (consumedOtp) restoreLogin();
    setError(errCode(ex, 'Không kết nối được máy chủ.'));
  } finally {
    setBusy(false);
  }
};

/* Đăng nhập bằng passkey: ưu tiên hàng đầu khi thiết bị hỗ trợ; OTP Telegram là lần đầu / dự phòng. */
/**
 * Hỏi server TRƯỚC khi mở Face ID: máy chưa xác nhận OTP (hoặc quá hạn tin cậy) thì phải OTP trước, không được bắt quét Face ID rồi mới báo cần OTP.
 * Trả 'nophone' (chưa biết số), true (cần OTP trước) hoặc false (máy đã tin cậy, dùng sinh trắc được).
 */
async function needOtpFirst() {
  const typed = fullPhone();
  const phone = isValidVnPhoneClient(typed) ? typed : LS.get('lastPhone', '');
  if (!isValidVnPhoneClient(phone)) return 'nophone';
  try {
    const r = await api('/api/login/start', { phone });
    if (r.ok && r.data.otpRequired) {
      LS.del('otpAt');
      if (!isValidVnPhoneClient(typed)) $('#phone').value = String(phone).replace(/^84/, '');
      return true;
    }
  } catch { /* mất mạng: để bước đăng nhập báo lỗi như thường */ }
  return false;
}

async function passkeyLogin(opts) {
  if (loginBusy) return false;
  setError('');
  if (!opts?.checked) {
    const need = await needOtpFirst();
    if (need === 'nophone') { setError('invalid_phone'); $('#phone').focus(); return false; }
    if (need) { resetFlowUi(); return $('#btn-otp').onclick(); }
  }
  let authenticated = false;
  setBusy(true);
  try {
    window.PlcDebug?.log?.('ui.passkey_click', 'User bấm Đăng nhập Face ID / vân tay');
    const data = await window.Security.loginWithPasskey($('#password').value);
    if (data.error === 'second_factor_required') {
      setError('second_factor_required');
      $('#password').focus();
      return false;
    }
    if (data.error) {
      window.PlcDebug?.log?.('ui.passkey_error', data.error, data, 'error');
      setError(data.error);
      return false;
    }
    let session = data;
    if (data.pending && data.needPassword) {
      // Bước 3: tài khoản chưa có mật khẩu -> phải tạo (nhập + nhập lại) rồi mới vào trang chính
      session = await window.Security.completeNeedPassword(data);
      if (!session) { restoreLogin(); setError('Chưa tạo mật khẩu nên chưa vào được. Hãy thử lại.'); return false; }
    }
    authenticated = true;
    $('#step-creds').hidden = true;
    $('#ok-msg').textContent = '✓ Đăng nhập thành công. Đang vào ứng dụng…';
    $('#ok-msg').hidden = false;
    window.PlcDebug?.log?.('ui.passkey_ok', 'UI nhận session — đang tải bundle', { userId: session.userId }, 'ok');
    await finishLogin(session);
    return true;
  } catch (ex) {
    restoreLogin();
    window.PlcDebug?.log?.('ui.passkey_exception', ex?.name || 'error', { name: ex?.name, message: ex?.message }, 'error');
    setError(ex?.name === 'NotAllowedError' ? 'Đã huỷ trên thiết bị.' : ex?.name === 'TypeError' && isNetworkError(ex) ? 'offline' : authenticated ? errCode(ex, 'webauthn_failed') : 'webauthn_failed');
    return false;
  } finally {
    setBusy(false);
  }
}

/** Đăng nhập bằng mật khẩu: chỉ trên máy đã tin cậy; máy mới / đã xoá dữ liệu phải qua OTP Telegram một lần. */
async function passwordLogin() {
  if (loginBusy) return false;
  const phone = requireVnPhone();
  if (!phone) return false;
  const password = $('#password').value;
  if (!password) { setError('password_required'); $('#password').focus(); return false; }
  setBusy(true);
  try {
    let { ok, data } = await api('/api/login/password', { phone, password });
    if (!ok && data.error === 'password_new_device' && window.Security?.passkeySupported() && LS.get('hasPasskey', false)) {
      // Máy chưa xác nhận OTP: mật khẩu đúng nhưng cần thêm sinh trắc (mật khẩu + Face ID)
      setError('');
      try {
        const proof = await window.Security.passkeyProof();
        ({ ok, data } = await api('/api/login/password', { phone, password, cid: proof.cid, credential: proof.credential }));
      } catch (ex) { setError(ex?.name === 'NotAllowedError' ? 'Đã huỷ Face ID. Máy mới cần mật khẩu + Face ID, hoặc dùng OTP Telegram.' : 'webauthn_failed'); return false; }
    }
    if (!ok) { setError(data.error || 'password_invalid'); return false; }
    if (flowPlan?.mustEnroll) {
      // Bước 2 (đăng ký): máy hỗ trợ sinh trắc nhưng tài khoản chưa có khoá -> bắt buộc bật rồi mới vào trang chính
      LS.set('session', { token: data.token, userId: data.userId, apiBase: location.origin, online: true, gate: 'bio' });
      const r = await window.Security.enrollMandatory();
      if (r === 'cancel') { LS.del('session'); setError('Chưa bật ' + flowPlan.bio.label + ' nên chưa vào được. Hãy thử lại.'); return false; }
    }
    $('#step-creds').hidden = true;
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

/** Bấm Đăng nhập: máy có vân tay → nhận Face ID ngay (bỏ qua mật khẩu); không có / huỷ → dùng mật khẩu đã nhập. */
let flowPlan = null;

function resetFlowUi() {
  flowPlan = null;
  for (const id of ['pw-row', 'btn-login', 'btn-passkey', 'lnk-use-pw', 'btn-setup-passkey', 'btn-otp']) { const el = $('#' + id); if (el) el.hidden = true; }
  if ($('#try-passkey-row')) $('#try-passkey-row').hidden = true;
  if ($('#btn-next')) $('#btn-next').hidden = false;
}

function showPasswordStep() {
  $('#pw-row').hidden = false;
  $('#btn-login').hidden = false;
  $('#btn-next').hidden = true;
  $('#password').focus();
}

/** Máy đã xác nhận OTP: ẩn bước OTP. Bước 2: sinh trắc (nếu hỗ trợ). Bước 3: mật khẩu. */
async function trustedFlow(plan) {
  const bio = await window.Security.bioInfo();
  flowPlan = { ...plan, bio, mustEnroll: bio.supported && !plan.hasPasskey };
  $('#btn-next').hidden = true;
  // Tài khoản đã đăng ký: hiện TẤT CẢ cách đăng nhập để người dùng chọn (sinh trắc / mật khẩu / OTP Telegram).
  const canBio = bio.supported && plan.hasPasskey;
  $('#flow-hint').textContent = 'Chọn cách đăng nhập:';
  $('#btn-passkey').hidden = !canBio;
  if (canBio) {
    $('#btn-passkey').textContent = `Đăng nhập bằng ${bio.label}`;
    $('#btn-passkey').onclick = () => passkeyLogin();
  }
  $('#lnk-use-pw').hidden = !plan.hasPassword;
  $('#lnk-use-pw').textContent = bio.supported && !plan.hasPasskey ? `Đăng nhập bằng mật khẩu (sau đó bật ${bio.label})` : 'Đăng nhập bằng mật khẩu';
  $('#lnk-use-pw').onclick = () => {
    $('#btn-passkey').hidden = true; $('#lnk-use-pw').hidden = true; $('#btn-otp').hidden = true;
    $('#flow-hint').textContent = bio.supported && !plan.hasPasskey
      ? `Nhập mật khẩu. Sau đó bắt buộc bật ${bio.label} cho máy này.`
      : 'Nhập mật khẩu.';
    showPasswordStep();
  };
  $('#btn-otp').hidden = false;
  $('#btn-otp').textContent = 'Dùng OTP Telegram';
  if (!canBio && !plan.hasPassword) { resetFlowUi(); $('#btn-otp').onclick(); return; } // chưa có khoá lẫn mật khẩu: bắt buộc OTP
  if (canBio) await passkeyLogin({ checked: true }); // vừa bấm Tiếp tục nên mở luôn hộp sinh trắc; vẫn còn đủ lựa chọn nếu huỷ
}

/** Nhập số điện thoại → server cho biết có cần OTP không (không lộ số có tồn tại hay không). */
async function runFlow() {
  if (loginBusy) return;
  setError('');
  const phone = requireVnPhone();
  if (!phone) return;
  LS.set('lastPhone', phone);
  setBusy(true);
  let plan;
  try {
    const r = await api('/api/login/start', { phone });
    if (!r.ok) { setError(r.data.error || 'server_error'); return; }
    plan = r.data;
  } catch (ex) { setError(errCode(ex, 'Không kết nối được máy chủ.')); return; } finally { setBusy(false); }
  if (plan.otpRequired) { LS.del('otpAt'); $('#btn-otp').onclick(); return; }
  if (!LS.get('otpAt', 0)) LS.set('otpAt', Date.now());
  await trustedFlow(plan);
}

async function syncPasskeyButton() {
  // Lối tắt: máy đã bật sinh trắc thì hiện sẵn nút đăng nhập (không cần gõ số). Máy chưa có thì không hiện (iOS sẽ ra mã QR).
  if ($('#btn-setup-passkey')) $('#btn-setup-passkey').hidden = true;
  if ($('#try-passkey-row')) $('#try-passkey-row').hidden = true;
  if (!window.Security?.passkeySupported() || mode !== 'login' || !LS.get('hasPasskey', false) || !localTrusted() || !LS.get('lastPhone', '')) return;
  const bio = await window.Security.bioInfo();
  if (!bio.supported) return;
  $('#btn-passkey').textContent = `Đăng nhập bằng ${bio.label}`;
  $('#btn-passkey').hidden = false;
  $('#btn-passkey').onclick = () => passkeyLogin();
}
syncPasskeyButton();
// Máy đã bật vân tay: tự mở Face ID ngay khi vào trang (Android/Chrome); iOS có thể yêu cầu bấm nút. ?out=1 (đăng xuất) thì không tự mở.
(async () => {
  const q = new URLSearchParams(location.search);
  if (q.get('out') || q.get('revoked') || q.get('update') || !LS.get('hasPasskey', false) || !localTrusted() || !LS.get('lastPhone', '') || !window.Security?.passkeySupported()) return;
  await new Promise((r) => setTimeout(r, 400));
  if (!loginBusy && mode === 'login' && !LS.get('session', null)?.token) passkeyLogin();
})();
$('#btn-next').onclick = runFlow;
$('#btn-login').onclick = () => passwordLogin();
$('#password').onkeydown = (event) => { if (event.key === 'Enter') { event.preventDefault(); passwordLogin(); } };

$('#btn-back').onclick = () => { stopOtpTimer(); showStep(false); setError(''); };
$('#btn-resend').onclick = () => $('#btn-otp').onclick();
$('#phone').onkeydown = (event) => { if (event.key === 'Enter') { event.preventDefault(); runFlow(); } };
$('#otp').onkeydown = (event) => { if (event.key === 'Enter') { event.preventDefault(); $('#btn-verify').onclick(); } };

if ($('#demo')) $('#demo').onclick = async () => {
  await window.AuthApp?.onDemo?.();
  LS.set('session', { demo: true, apiBase: location.origin });
  await registerSw();
  location.replace('index.html');
};

/* ---------- Khôi phục bằng 2 yếu tố khác nhóm: kênh (OTP Telegram / email) · mật khẩu · vân tay-Face ID ---------- */
const recover = { channel: 'telegram', bio: null };
function recoverGroups() {
  return [$('#rc-otp').value.trim() && 'channel', $('#rc-pw').value && 'knowledge', recover.bio && 'device'].filter(Boolean);
}
function recoverState() {
  const g = recoverGroups();
  $('#rc-state').textContent = g.length >= 2 ? '✓ Đủ 2 yếu tố khác loại. Bấm Khôi phục.' : `Đã có ${g.length}/2 yếu tố khác loại.`;
  $('#rc-go').disabled = loginBusy || g.length < 2;
}
function recoverPhone() {
  let ph = ($('#rc-phone').value || '').replace(/\D/g, '');
  if (ph.startsWith('0')) ph = ph.slice(1);
  const full = ph.startsWith('84') && ph.length === 11 ? ph : '84' + ph;
  if (!isValidVnPhoneClient(full)) { setError('invalid_phone'); return null; }
  return full;
}
$('#rc-open').onclick = (event) => {
  event.preventDefault();
  setError('');
  $('#rc-phone').value = $('#phone').value;
  $('#step-creds').hidden = true;
  $('#step-recover').hidden = false;
  recover.bio = null;
  recoverState();
};
$('#rc-back').onclick = () => { $('#step-recover').hidden = true; $('#step-creds').hidden = false; setError(''); };
for (const id of ['rc-otp', 'rc-pw']) $('#' + id).oninput = recoverState;
async function recoverSendOtp(channel) {
  if (loginBusy) return;
  setError('');
  const phone = recoverPhone();
  if (!phone) return;
  setBusy(true);
  try {
    const { ok, data } = await api('/api/login/recover/otp', { phone, channel });
    if (!ok) { setError(data.error); return; }
    recover.channel = channel;
    $('#rc-otp').focus();
    $('#rc-state').textContent = channel === 'email' ? 'Đã gửi mã tới email đã xác minh.' : 'Đã gửi mã vào Telegram.';
  } catch (ex) { setError(errCode(ex, 'Không kết nối được máy chủ.')); } finally { setBusy(false); recoverState(); }
}
$('#rc-tg').onclick = () => recoverSendOtp('telegram');
$('#rc-mail').onclick = () => recoverSendOtp('email');
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
$('#rc-go').onclick = async () => {
  if (loginBusy) return;
  setError('');
  const phone = recoverPhone();
  if (!phone) return;
  if (recoverGroups().length < 2) { setError('recover_need_two'); return; }
  setBusy(true);
  try {
    const body = { phone, channel: recover.channel };
    if ($('#rc-otp').value.trim()) body.otp = $('#rc-otp').value.trim();
    if ($('#rc-pw').value) body.password = $('#rc-pw').value;
    if (recover.bio) { body.cid = recover.bio.cid; body.credential = recover.bio.credential; }
    const { ok, data } = await api('/api/login/recover', body);
    if (!ok) {
      setError(data.error || 'recover_invalid');
      // Bản xác nhận vân tay chỉ dùng được một lần: sau mỗi lần gửi (kể cả thất bại) phải xác nhận lại.
      recover.bio = null;
      $('#rc-bio').textContent = 'Xác nhận bằng vân tay / Face ID';
      return;
    }
    $('#step-recover').hidden = true;
    $('#ok-msg').textContent = '✓ Khôi phục thành công. Đang vào ứng dụng…';
    $('#ok-msg').hidden = false;
    await finishLogin(data);
  } catch (ex) { restoreLogin(); setError(errCode(ex, 'Không kết nối được máy chủ.')); } finally { setBusy(false); recoverState(); }
};

applyMode();
{
  const q = new URLSearchParams(location.search);
  if (q.get('changed')) setError('Đã đổi số điện thoại. Hãy đăng nhập bằng số mới.');
  else if (q.get('revoked')) setError('Phiên đã bị thu hồi (đổi số/khôi phục tài khoản). Vui lòng đăng nhập lại.');
}
loadAuthConfig();
tryResume();
