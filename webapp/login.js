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
  otp_locked: 'Nhập sai quá nhiều. Thử lại sau.',
  telegram_send_failed: 'Không gửi được Telegram. Thử lại.',
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
  $('#error').textContent = ERR[codeOrMsg] || codeOrMsg || '';
}

function setBusy(on) {
  ['btn-otp', 'btn-verify', 'btn-back', 'demo'].forEach((id) => {
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
    label.textContent = `Đang tải (${done + 1}/${files.length}): ${f.path}`;
    const url = `${base}/api/bundle/${f.path.split('/').map(encodeURIComponent).join('/')}`;
    const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
    if (!res.ok) throw new Error(`Tải thất bại: ${f.path} (${res.status})`);
    const buf = await res.arrayBuffer();
    const headers = new Headers(res.headers);
    headers.set('Cache-Control', 'public, max-age=31536000');
    const stored = new Response(buf, { status: 200, statusText: 'OK', headers });
    const abs = new URL(f.path, location.origin).href;
    await cache.put(abs, stored.clone());
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
  const cfg = LS.get('cfg', {});
  cfg.demo = false;
  if (data.mqtt) {
    cfg.user = data.mqtt.user;
    cfg.pass = data.mqtt.pass;
    cfg.site = data.mqtt.site;
    cfg.dev = data.mqtt.device;
  } else if (data.notifySite) {
    cfg.site = data.notifySite;
    cfg.dev = data.notifyDevice;
  }
  LS.set('cfg', cfg);
  await registerSw();
  // báo thành công ~1 giây rồi vào trang chính
  await new Promise((r) => setTimeout(r, 900));
  location.replace('index.html');
}

async function api(path, body) {
  const r = await fetch(location.origin + path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const data = await r.json().catch(() => ({}));
  return { ok: r.ok, status: r.status, data };
}

function showStep(otp) {
  $('#step-creds').hidden = otp;
  $('#step-otp').hidden = !otp;
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
  let left = 300;
  const tick = () => {
    const m = String(Math.floor(left / 60)).padStart(2, '0');
    const s = String(left % 60).padStart(2, '0');
    $('#otp-timer').textContent = left > 0 ? `Mã hết hạn sau ${m}:${s}` : 'Mã đã hết hạn. Hãy gửi lại.';
    $('#btn-resend').disabled = left > 240;   // cho gửi lại sau 60 giây
    if (left-- <= 0) stopOtpTimer();
  };
  tick();
  otpTimer = setInterval(tick, 1000);
}

async function loadAuthConfig() {
  try {
    const r = await fetch(location.origin + '/api/auth/config');
    const j = await r.json();
    const hint = $('#tg-hint');
    if (j.botLink) {
      hint.innerHTML = `Trước tiên mở <a href="${j.botLink}" target="_blank" rel="noopener">@${j.botUsername.replace(/^@/, '')}</a>, bấm <b>/start</b> và chia sẻ số điện thoại để nhận OTP.`;
    } else if (!j.telegram) {
      hint.textContent = 'Máy chủ chưa cấu hình Telegram — dùng chạy thử.';
    }
  } catch {}
}

async function tryResume() {
  const session = LS.get('session', null);
  if (!session || session.demo) return false;
  if (!session.online && !(await hasBundle(session))) return false;
  if (session.online && !session.token) return false;
  const wantUpdate = new URLSearchParams(location.search).get('update') === '1';
  if (!wantUpdate && navigator.onLine && session.token) {
    try {
      const r = await fetch(`${session.apiBase || location.origin}/api/me`, {
        headers: { Authorization: `Bearer ${session.token}` },
      });
      if (r.ok) {
        const me = await r.json();
        if (me.version !== session.version) {
          setError('Có bản mới. Đăng nhập lại để tải cập nhật.');
          return false;
        }
      }
    } catch {}
  }
  await registerSw();
  location.replace('index.html');
  return true;
}

$('#btn-otp').onclick = async () => {
  setError('');
  const phone = requireVnPhone();
  if (!phone) return;
  setBusy(true);
  try {
    const { ok, data } = await api('/api/login/request-otp', { phone });
    if (!ok) { setError(data.error || data.detail); return; }
    pendingPhone = data.phone || phone;
    otpPurpose = data.purpose === 'register' ? 'register' : 'login';
    $('#otp-info').textContent = otpPurpose === 'register'
      ? 'Số điện thoại chưa đăng ký. Nhập OTP để tạo tài khoản và vào ứng dụng.'
      : 'Người dùng đã đăng ký rồi. Nhập OTP để đăng nhập.';
    showStep(true);
    startOtpTimer();
    $('#otp').focus();
  } catch (ex) {
    setError(ex.message || 'Không kết nối được máy chủ.');
  } finally {
    setBusy(false);
  }
};

$('#btn-verify').onclick = async () => {
  setError('');
  setBusy(true);
  try {
    const path = otpPurpose === 'register' ? '/api/register/verify' : '/api/login/verify-otp';
    const { ok, data } = await api(path, { phone: pendingPhone, otp: $('#otp').value.trim() });
    if (!ok) { setError(data.error); return; }
    stopOtpTimer();
    $('#step-otp').hidden = true;
    $('#ok-msg').textContent = otpPurpose === 'register' ? '✓ Tạo tài khoản thành công. Đang vào ứng dụng…' : '✓ Đăng nhập thành công. Đang vào ứng dụng…';
    $('#ok-msg').hidden = false;
    await finishLogin(data);
  } catch (ex) {
    setError(ex.message || 'Không kết nối được máy chủ.');
  } finally {
    setBusy(false);
  }
};

$('#btn-back').onclick = () => { stopOtpTimer(); showStep(false); setError(''); };
$('#btn-resend').onclick = () => $('#btn-otp').onclick();

$('#demo').onclick = async () => {
  const cfg = Object.assign(LS.get('cfg', {}), { demo: true });
  LS.set('cfg', cfg);
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
