'use strict';
/* Đăng nhập trang quản trị: mật khẩu + Authenticator. Lưu phiên vào localStorage 'session' (admin.js / console.js dùng chung). */
(function () {
  const $ = (s) => document.querySelector(s);
  const ERR = {
    invalid_credentials: 'Sai tên đăng nhập hoặc mật khẩu.',
    totp_invalid: 'Mã Authenticator sai hoặc đã dùng.',
    locked: 'Sai quá nhiều lần, thử lại sau 15 phút.',
    rate_limited: 'Thao tác quá nhanh, chờ một chút.',
    ticket_invalid: 'Phiên đăng ký đã hết hạn, đăng nhập lại.',
    totp_not_pending: 'Chưa tạo khoá Authenticator.',
    faceid_failed: 'Không xác nhận được Face ID. Thử lại.',
    unknown_credential: 'Face ID này chưa đăng ký cho trang admin.',
    no_faceid: 'Chưa đăng ký Face ID.',
    faceid_exists: 'Đã có Face ID.',
  };
  let ticket = null;

  /* ---- Face ID / vân tay (WebAuthn) ---- */
  const b64uToBuf = (s) => { const t = String(s).replace(/-/g, '+').replace(/_/g, '/'); const b = atob(t + '='.repeat((4 - (t.length % 4)) % 4)); return Uint8Array.from(b, (c) => c.charCodeAt(0)).buffer; };
  const bufToB64u = (b) => btoa(String.fromCharCode(...new Uint8Array(b))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  async function faceCreate(opts, name) {
    const cred = await navigator.credentials.create({ publicKey: {
      ...opts, challenge: b64uToBuf(opts.challenge), user: { ...opts.user, id: b64uToBuf(opts.user.id) }, hints: ['client-device'],
      excludeCredentials: (opts.excludeCredentials || []).map((c) => ({ ...c, id: b64uToBuf(c.id) })),
    } });
    return { id: cred.id, type: cred.type, response: { clientDataJSON: bufToB64u(cred.response.clientDataJSON), attestationObject: bufToB64u(cred.response.attestationObject) }, name };
  }
  async function faceGet(opts) {
    const cred = await navigator.credentials.get({ publicKey: {
      ...opts, challenge: b64uToBuf(opts.challenge), allowCredentials: (opts.allowCredentials || []).map((c) => ({ ...c, id: b64uToBuf(c.id) })), hints: ['client-device'],
    } });
    const r = cred.response;
    return { id: cred.id, type: cred.type, response: { clientDataJSON: bufToB64u(r.clientDataJSON), authenticatorData: bufToB64u(r.authenticatorData), signature: bufToB64u(r.signature), userHandle: r.userHandle ? bufToB64u(r.userHandle) : null } };
  }

  const msg = (t) => { const e = $('#error'); e.textContent = t || ''; e.style.display = t ? 'block' : 'none'; };
  async function post(path, body) {
    const r = await fetch(path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    const j = await r.json().catch(() => ({}));
    return { ok: r.ok, status: r.status, j };
  }
  function done(j) {
    try { localStorage.removeItem('ctl'); localStorage.setItem('session', JSON.stringify({ token: j.token, apiBase: location.origin, admin: true, username: j.username })); } catch {}
    location.replace('admin.html');
  }
  const text = (j, status) => ERR[j.error] || (status === 404 ? 'Không có quyền truy cập từ vị trí này.' : `Lỗi ${status}`);

  $('#step-login').addEventListener('submit', async (ev) => {
    ev.preventDefault(); msg('');
    const btn = $('#btn-login'); btn.disabled = true;
    try {
      const { ok, status, j } = await post('/api/admin-site/login', {
        username: $('#username').value.trim(), password: $('#password').value, code: $('#code').value.trim(),
      });
      if (ok && j.token) return done(j);
      if (ok && j.setupRequired) { ticket = j.ticket; return startSetup(); }
      if (ok && (j.faceIdRequired || j.faceIdSetup)) { ticket = j.ticket; return startFace(Boolean(j.faceIdSetup)); }
      if (j.error === 'totp_required') { $('#code-row').classList.remove('hidden'); $('#code').focus(); return msg('Nhập mã 6 số từ ứng dụng Authenticator.'); }
      msg(text(j, status));
    } catch { msg('Không kết nối được máy chủ.'); } finally { btn.disabled = false; }
  });

  function startFace(setup) {
    $('#step-login').classList.add('hidden'); $('#step-face').classList.remove('hidden');
    $('#face-title').textContent = setup ? 'Bật Face ID cho trang admin' : 'Xác nhận Face ID';
    $('#face-hint').textContent = setup
      ? 'Trang admin bắt buộc Face ID / vân tay. Bấm Tiếp tục rồi xác nhận khi máy hỏi; khoá này chỉ dùng cho tên miền admin.'
      : 'Bấm Tiếp tục rồi xác nhận Face ID / vân tay của máy đã đăng ký.';
    $('#btn-face').textContent = setup ? 'Bật Face ID' : 'Tiếp tục';
    $('#btn-face').onclick = () => runFace(setup);
  }
  async function runFace(setup) {
    msg(''); const btn = $('#btn-face'); btn.disabled = true;
    try {
      if (!window.PublicKeyCredential) return msg('Trình duyệt này không hỗ trợ Face ID / vân tay. Dùng Safari/Chrome mới trên máy có sinh trắc.');
      const base = setup ? '/api/admin-site/faceid/register' : '/api/admin-site/faceid/auth';
      const o = await post(`${base}/options`, { ticket });
      if (!o.ok) return msg(text(o.j, o.status));
      let cred;
      try { cred = setup ? await faceCreate(o.j, `Thiết bị ${new Date().toLocaleDateString('vi-VN')}`) : await faceGet(o.j); }
      catch (e) { return msg(e?.name === 'NotAllowedError' ? 'Chưa xác nhận được Face ID / vân tay. Thử lại.' : `Không dùng được Face ID (${e?.name || 'lỗi'}).`); }
      const v = await post(`${base}/verify`, { ticket, credential: cred, name: cred.name });
      if (v.ok && v.j.token) return done(v.j);
      msg(text(v.j, v.status));
    } catch { msg('Không kết nối được máy chủ.'); } finally { btn.disabled = false; }
  }

  async function startSetup() {
    const { ok, status, j } = await post('/api/admin-site/totp/setup', { ticket });
    if (!ok) return msg(text(j, status));
    $('#step-login').classList.add('hidden'); $('#step-setup').classList.remove('hidden');
    $('#secret').textContent = j.secret;
    try {
      const c = document.createElement('canvas'); $('#qr').appendChild(c);
      window.QRCode.toCanvas(c, j.uri, { width: 220, margin: 2 });
    } catch { /* vẫn nhập tay bằng khoá */ }
    $('#setup-code').focus();
  }

  $('#btn-enable').addEventListener('click', async () => {
    msg('');
    const { ok, status, j } = await post('/api/admin-site/totp/enable', { ticket, code: $('#setup-code').value.trim() });
    if (ok && j.token) return done(j);
    msg(text(j, status));
  });

  msg('');
})();
