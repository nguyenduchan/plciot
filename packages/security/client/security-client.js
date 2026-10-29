'use strict';
/*
 * @plciot/security — CLIENT dùng chung (trình duyệt). KHÔNG sửa bản trong webapp/security/ (do sync-client sinh ra);
 * sửa ở packages/security/client/ rồi chạy `npm run sync-client` trong packages/security.
 *
 * Cung cấp window.Security: đăng nhập passkey, hộp thoại mở khoá (Passkey / TOTP), thiết lập yếu tố, mã khôi phục,
 * thêm thiết bị mới, duyệt thiết bị từ máy cũ, banner "bắt buộc bật yếu tố", bảng điều khiển trong Cài đặt.
 * Không biết app điều khiển cái gì: app cộng thêm lỗi riêng bằng Security.addErrors() và gửi lệnh bằng Security.api().
 *
 * Hợp đồng DOM (tuỳ chọn, thiếu phần tử nào thì phần đó bị bỏ qua):
 *   #ctl-banner                                   banner trạng thái bắt buộc bật yếu tố
 *   #ctl-sec, #ctl-state, #ctl-list, #ctl-pk-add, #ctl-totp-add, #ctl-totp-off, #ctl-lock, #ctl-review, #ctl-logout-all, #ctl-msg
 * Hợp đồng lưu trữ (localStorage): session {token, apiBase, demo}, ctl {token}, enroll {ticket, exp}, devReq, devId.
 * Hợp đồng server: các route của mountSecurityRoutes (/api/control/*, /api/webauthn/*, /api/devices/*, /api/login/passkey/*).
 */
(function () {
  const LS = {
    get(k, d) { try { return JSON.parse(localStorage.getItem(k)) ?? d; } catch { return d; } },
    set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch {} },
    del(k) { try { localStorage.removeItem(k); } catch {} },
  };
  const $ = (s) => document.querySelector(s);
  let pendingSession = null;
  const session = () => pendingSession || LS.get('session', null);
  const base = () => session()?.apiBase || location.origin;

  const ERR = {
    totp_invalid: 'Mã không đúng hoặc đã dùng. Chờ mã mới (30 giây) rồi thử lại.',
    totp_locked: 'Nhập sai quá nhiều lần. Thử lại sau 15 phút.',
    reauth_required: 'Cần đăng nhập lại (OTP Telegram) trước khi thiết lập bảo mật.',
    step_up_required: 'Cần xác thực để điều khiển.',
    webauthn_failed: 'Xác thực vân tay / Face ID không thành công.',
    credential_exists: 'Thiết bị này đã được đăng ký.',
    rate_limited: 'Thao tác quá nhanh, chờ một chút.',
    first_device_required: 'Đây không phải thiết bị đầu tiên của tài khoản nên chưa bật được ngay. Hãy xác nhận bằng email hoặc chờ 24 giờ.',
    otp_invalid: 'Mã không đúng.',
    otp_expired: 'Mã hết hạn, gửi lại.',
    otp_missing: 'Chưa có mã, bấm Gửi mã trước.',
    otp_locked: 'Nhập sai quá nhiều, thử lại sau.',
    totp_already_enabled: 'Authenticator đã được bật.',
    device_proof_required: 'Không xác minh được khoá của thiết bị này. Hãy dùng đúng trình duyệt đã tạo yêu cầu.',
    recovery_device_required: 'Hãy hoàn tất thiết lập trên trình duyệt đã tạo yêu cầu khôi phục.',
    independent_proof_required: 'Cần máy cũ, mã khôi phục hoặc email đã xác minh; không thể chỉ chờ để được cấp quyền.',
    notification_required: 'Chưa gửi được cảnh báo bảo mật. Yêu cầu chưa được tự động áp dụng.',
    approval_code_invalid: 'Mã ghép không đúng. Đối chiếu mã đang hiện trên máy mới.',
    secure_context_required: 'Cần HTTPS và trình duyệt hỗ trợ lưu khoá thiết bị.',
    device_storage_unavailable: 'Không lưu được khoá thiết bị. Kiểm tra quyền lưu dữ liệu của trình duyệt.',
    device_revoked: 'Khoá thiết bị đã bị thu hồi. Hãy dùng quy trình khôi phục được xác minh.',
    credential_rotation_failed: 'Chưa hoàn tất thu hồi credential cũ. Hãy thử lại sau.',
    contact_changed: 'Kênh nhận OTP đã thay đổi. Hãy yêu cầu mã mới.',
    account_disabled: 'Tài khoản đã bị khoá. Liên hệ quản trị viên.',
    session_revoked: 'Phiên đăng nhập đã bị thu hồi. Hãy đăng nhập lại.',
    password_invalid: 'Sai mật khẩu hoặc tài khoản chưa đặt mật khẩu.',
    password_locked: 'Nhập sai mật khẩu quá nhiều lần. Thử lại sau 15 phút hoặc dùng OTP Telegram.',
    password_new_device: 'Máy này chưa được tin cậy. Hãy đăng nhập bằng OTP Telegram một lần.',
    password_weak: 'Mật khẩu tối thiểu 8 ký tự và không được chứa số điện thoại.',
    recover_need_two: 'Cần ít nhất 2 yếu tố khác loại: mã OTP (Telegram hoặc email), mật khẩu, vân tay / Face ID.',
    recover_invalid: 'Thông tin khôi phục không đúng.',
    recover_locked: 'Thử sai quá nhiều lần. Chờ 15 phút rồi thử lại.',
    email_unavailable: 'Tài khoản chưa có email đã xác minh (hoặc chưa qua thời gian chờ 72 giờ), hoặc máy chủ chưa bật gửi email.',
    unauthorized: 'Phiên đăng nhập hết hạn. Hãy đăng nhập lại.',
    forbidden: 'Bạn không có quyền thực hiện thao tác này.',
    server_error: 'Máy chủ gặp lỗi. Thử lại sau ít phút.',
    offline: 'Không kết nối được máy chủ. Kiểm tra mạng rồi thử lại.',
    enroll_required: 'Điều khiển đã bị khoá: hãy bật vân tay / Face ID hoặc Authenticator.',
    totp_not_enabled: 'Chưa bật Authenticator trên tài khoản này.',
    no_passkey: 'Tài khoản này chưa đăng ký vân tay / Face ID.',
    unknown_credential: 'Passkey này chưa được đăng ký cho tài khoản.',
    old_channel_unavailable: 'Chưa có email đã xác minh. Dùng máy cũ duyệt hoặc mã khôi phục.',
    email_send_failed: 'Không gửi được email. Thử lại sau hoặc dùng cách khác.',
    email_disabled: 'Máy chủ chưa bật gửi email nên chưa thêm được email. Bạn vẫn có thể dùng mật khẩu hoặc vân tay.',
    invalid_email: 'Email không hợp lệ.',
    email_quarantine: 'Email mới thêm đang trong thời gian chờ.',
    recovery_code_invalid: 'Mã khôi phục không đúng hoặc đã dùng.',
    recovery_locked: 'Nhập sai mã khôi phục quá nhiều lần. Thử lại sau.',
    no_recovery_codes: 'Tài khoản chưa có mã khôi phục.',
    request_not_pending: 'Yêu cầu này đã được xử lý hoặc đã bị huỷ.',
    request_not_active: 'Yêu cầu này không còn hiệu lực. Hãy tạo yêu cầu mới.',
    request_not_found: 'Không tìm thấy yêu cầu. Hãy tạo yêu cầu mới.',
    use_existing_device: 'Máy này đã đăng ký. Hãy dùng passkey / Authenticator đã có.',
    not_found: 'Không tìm thấy.',
    login_step_up_required: 'Cần xác thực passkey hoặc Authenticator để hoàn tất đăng nhập.',
    app_locked: 'Ứng dụng đã khoá. Hãy xác thực lại.',
  };
  const errText = (e) => ERR[e] || e || 'Lỗi';
  /** App thêm thông báo lỗi riêng (vd. lệnh PLC) mà không sửa lõi. */
  const addErrors = (m) => Object.assign(ERR, m);
  const dbg = (action, message, detail, level) => {
    try { window.PlcDebug?.log?.(action, message, detail, level); } catch {}
  };

  /* ---------- helpers ---------- */
  const b64uToBuf = (s) => {
    const p = s.replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((s.length + 3) % 4);
    const bin = atob(p); const u = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) u[i] = bin.charCodeAt(i);
    return u.buffer;
  };
  const bufToB64u = (b) => {
    let s = ''; new Uint8Array(b).forEach((x) => { s += String.fromCharCode(x); });
    return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  };

  async function api(method, path, body, extra) {
    const s = session();
    const tok = LS.get('ctl', null);
    const en = LS.get('enroll', null);
    let proving = false;
    try {
      let device;
      if (method === 'POST' && (/^\/api\/devices\/(request|requests\/)/.test(path)
        || /^\/api\/(webauthn\/register|control\/totp\/(setup|enable))/.test(path))) {
        if (!window.SecurityDevice) throw new Error('device_proof_required');
        proving = true;
        device = await window.SecurityDevice.proof(s?.userId, path);
        proving = false;
        body = { ...body, publicKey: device.publicKey, deviceProof: device.deviceProof };
      }
      const r = await fetch(base() + path, {
        method,
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${s?.token || ''}`,
          'X-Device-Id': device?.deviceId || devId(),
          ...(tok?.token ? { 'X-Control-Token': tok.token } : {}),
          ...(en?.ticket && en.exp > Date.now() ? { 'X-Enroll-Ticket': en.ticket } : {}),
          ...(extra || {}),
        },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      return { status: r.status, ok: r.ok, body: await r.json().catch(() => ({})) };
    } catch (error) {
      if (['device_proof_required', 'secure_context_required', 'device_storage_unavailable'].includes(error?.message)) return { status: 0, ok: false, body: { error: error.message } };
      // Lỗi tạo khoá/ký trên máy (không phải mất mạng): nói rõ nguyên nhân thay vì "không kết nối được máy chủ".
      if (proving) return { status: 0, ok: false, body: { error: `Không tạo được chứng minh thiết bị (${error?.name || 'Error'}: ${error?.message || ''})` } };
      return { status: 0, ok: false, body: { error: 'offline' } };
    }
  }

  const saveToken = (b) => { if (b?.controlToken) LS.set('ctl', { token: b.controlToken, method: b.method, expiresAt: b.expiresAt }); };

  /* ---------- WebAuthn ---------- */
  const passkeySupported = () => Boolean(window.PublicKeyCredential && navigator.credentials && window.isSecureContext);
  async function platformAuthenticator() {
    try { return passkeySupported() && await PublicKeyCredential.isUserVerifyingPlatformAuthenticatorAvailable(); } catch { return false; }
  }

  async function passkeyRegister(name) {
    dbg('register.start', 'Bắt đầu đăng ký Passkey/Face ID', { name });
    const o = await api('POST', '/api/webauthn/register/options', {});
    if (!o.ok) {
      dbg('register.options_fail', o.body?.error || 'options failed', o.body, 'error');
      return o.body;
    }
    dbg('register.options_ok', 'Đã nhận challenge — chờ Face ID / vân tay', { rpId: o.body?.rp?.id || o.body?.rpId });
    let cred;
    try {
      const opts = o.body;
      cred = await navigator.credentials.create({
        publicKey: {
          ...opts,
          challenge: b64uToBuf(opts.challenge),
          user: { ...opts.user, id: b64uToBuf(opts.user.id) },
          hints: ['client-device'],
          excludeCredentials: (opts.excludeCredentials || []).map((c) => ({ ...c, id: b64uToBuf(c.id) })),
        },
      });
    } catch (e) {
      dbg('register.gesture_fail', e?.name || 'create failed', { name: e?.name, message: e?.message }, 'error');
      throw e;
    }
    dbg('register.gesture_ok', 'Thiết bị đã tạo credential', { credId: String(cred?.id || '').slice(0, 16) }, 'ok');
    const r = await api('POST', '/api/webauthn/register/verify', {
      name,
      credential: {
        id: cred.id,
        response: {
          clientDataJSON: bufToB64u(cred.response.clientDataJSON),
          attestationObject: bufToB64u(cred.response.attestationObject),
        },
      },
    });
    if (r.ok) {
      saveToken(r.body);
      LS.set('hasPasskey', true);
      dbg('register.verify_ok', 'Server đã lưu Passkey', { method: r.body?.method }, 'ok');
      if (r.body.recoveryCodes?.length) await showRecoveryCodes(r.body.recoveryCodes);
    } else {
      dbg('register.verify_fail', r.body?.error || 'verify failed', r.body, 'error');
    }
    return r.body;
  }

  async function passkeyUnlock(extra) {
    dbg('unlock.start', 'Mở khoá bằng Passkey/Face ID');
    const o = await api('POST', '/api/webauthn/auth/options', {}, extra);
    if (!o.ok) {
      dbg('unlock.options_fail', o.body?.error || 'options failed', o.body, 'error');
      return o.body;
    }
    dbg('unlock.options_ok', 'Đã nhận challenge — chờ Face ID / vân tay', {
      allow: (o.body?.allowCredentials || []).length,
    });
    let cred;
    try {
      const opts = o.body;
      cred = await navigator.credentials.get({
        publicKey: {
          ...opts,
          challenge: b64uToBuf(opts.challenge),
          allowCredentials: (opts.allowCredentials || []).map((c) => ({ ...c, id: b64uToBuf(c.id) })),
        },
      });
    } catch (e) {
      dbg('unlock.gesture_fail', e?.name || 'get failed', { name: e?.name, message: e?.message }, 'error');
      throw e;
    }
    dbg('unlock.gesture_ok', 'Đã xác thực sinh trắc', { credId: String(cred?.id || '').slice(0, 16) }, 'ok');
    const r = await api('POST', '/api/webauthn/auth/verify', {
      credential: {
        id: cred.id,
        response: {
          clientDataJSON: bufToB64u(cred.response.clientDataJSON),
          authenticatorData: bufToB64u(cred.response.authenticatorData),
          signature: bufToB64u(cred.response.signature),
        },
      },
    }, extra);
    if (r.ok) {
      saveToken(r.body);
      dbg('unlock.verify_ok', 'Server chấp nhận Passkey', { method: r.body?.method }, 'ok');
    } else {
      dbg('unlock.verify_fail', r.body?.error || 'verify failed', r.body, 'error');
    }
    return r.body;
  }

  async function totpUnlock(code, extra) {
    const r = await api('POST', '/api/control/unlock', { code }, extra);
    if (r.ok) saveToken(r.body);
    return r.body;
  }

  async function totpEnable(code) {
    const r = await api('POST', '/api/control/totp/enable', { code });
    if (r.ok) { saveToken(r.body); if (r.body.recoveryCodes?.length) await showRecoveryCodes(r.body.recoveryCodes); }
    return r.body;
  }

  /* ---------- hộp thoại ---------- */
  let modalSequence = 0;
  function modal(html) {
    const previousFocus = document.activeElement;
    const wrap = document.createElement('div');
    wrap.className = 'ctl-modal';
    wrap.innerHTML = `<div class="ctl-box" role="dialog" aria-modal="true" aria-label="Xác thực bảo mật" tabindex="-1">${html}</div>`;
    const dialog = wrap.querySelector('.ctl-box');
    const titleId = `security-dialog-${++modalSequence}`;
    const updateTitle = () => {
      const heading = wrap.querySelector('h3');
      if (heading) { heading.id ||= titleId; dialog.setAttribute('aria-labelledby', heading.id); }
      wrap.querySelectorAll('.ctl-err').forEach((error) => error.setAttribute('role', 'alert'));
    };
    updateTitle();
    const titleObserver = new MutationObserver(updateTitle);
    titleObserver.observe(dialog, { childList: true, subtree: true });
    document.body.appendChild(wrap);
    dialog.focus();
    const keydown = (event) => {
      const dialogs = document.querySelectorAll('.ctl-modal');
      if (dialogs[dialogs.length - 1] !== wrap) return;
      if (event.key === 'Escape') {
        const cancel = wrap.querySelector('.ctl-cancel, .ctl-close, [data-a="x"]');
        if (cancel && !cancel.disabled) { event.preventDefault(); cancel.click(); }
      }
      if (event.key !== 'Tab') return;
      const controls = [...wrap.querySelectorAll('button:not(:disabled), input:not(:disabled), a[href], [tabindex="0"]')]
        .filter((control) => control.getClientRects().length);
      const first = controls[0]; const last = controls[controls.length - 1];
      if (!first) { event.preventDefault(); dialog.focus(); return; }
      if (event.shiftKey && (document.activeElement === first || document.activeElement === dialog)) {
        event.preventDefault(); last.focus();
      } else if (!event.shiftKey && (document.activeElement === last || !wrap.contains(document.activeElement))) {
        event.preventDefault(); first.focus();
      }
    };
    document.addEventListener('keydown', keydown);
    return { el: wrap, q: (s) => wrap.querySelector(s), close: () => {
      titleObserver.disconnect();
      document.removeEventListener('keydown', keydown);
      wrap.remove();
      if (previousFocus?.isConnected && !previousFocus.disabled) previousFocus.focus();
    } };
  }
  const escHtml = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

  /** Thiết lập yếu tố đầu tiên hoặc thêm TOTP: trả secret để người dùng nhập vào app Authenticator. */
  async function totpSetupFlow(m) {
    const s = await api('POST', '/api/control/totp/setup', {});
    if (!s.ok) { m.lastErr = s.body.error; m.q('.ctl-err').textContent = errText(s.body.error); return null; }
    m.q('.ctl-body').innerHTML = `
      <h3>Thêm vào Google / Microsoft Authenticator</h3>
      <p class="muted">Mở ứng dụng → thêm tài khoản → <b>nhập khoá thiết lập</b>:</p>
      <pre class="codes">${escHtml(s.body.secret)}</pre>
      <p class="muted"><a href="${escHtml(s.body.uri)}">Mở trực tiếp trong ứng dụng</a> (nếu máy hỗ trợ). Rồi nhập mã 6 số:</p>
      <label>Mã Authenticator<input class="ctl-code" inputmode="numeric" maxlength="6" autocomplete="one-time-code" placeholder="000000"></label>
      <p class="ctl-err" style="color:var(--bad)"></p>
      <div class="row"><button class="primary ctl-go">Xác nhận</button><button class="fit ctl-cancel">Huỷ</button></div>`;
    return new Promise((resolve) => {
      m.q('.ctl-cancel').onclick = () => resolve(false);
      const go = m.q('.ctl-go');
      go.onclick = async () => {
        if (go.disabled) return;
        const code = m.q('.ctl-code').value.trim();
        if (!/^\d{6}$/.test(code)) { m.q('.ctl-err').textContent = 'Nhập mã Authenticator gồm 6 chữ số.'; return; }
        go.disabled = true;
        m.q('.ctl-err').textContent = '';
        try {
          const r = await totpEnable(code);
          if (r.ok) resolve(true); else if (m.q('.ctl-err')) m.q('.ctl-err').textContent = errText(r.error);
        } finally { go.disabled = false; }
      };
      m.q('.ctl-code').onkeydown = (event) => { if (event.key === 'Enter') { event.preventDefault(); go.click(); } };
    });
  }

  async function passkeyEnrollFlow(m) {
    try {
      const r = await passkeyRegister(`${/iPhone|iPad/.test(navigator.userAgent) ? 'iPhone' : /Android/.test(navigator.userAgent) ? 'Android' : 'Máy tính'} ${new Date().toLocaleDateString('vi-VN')}`);
      if (r.ok) return true;
      m.lastErr = r.error;
      m.q('.ctl-err').textContent = errText(r.error);
    } catch (e) {
      m.q('.ctl-err').textContent = {
        NotAllowedError: 'Chưa xác nhận được. Bấm lại và xác nhận trên thiết bị.',
        NotSupportedError: 'Trình duyệt không hỗ trợ passkey. Hãy mở bằng Safari hoặc Chrome.',
        SecurityError: 'Hãy mở đúng địa chỉ HTTPS của ứng dụng.',
        InvalidStateError: 'Thiết bị đã đăng ký passkey cho tài khoản này.',
      }[e?.name] || errText('webauthn_failed');
    }
    return false;
  }

  /** Hiện mã khôi phục một lần; chỉ cho đóng khi người dùng xác nhận đã lưu. */
  function showRecoveryCodes(codes) {
    return new Promise((resolve) => {
      const text = codes.join('\n');
      const m = modal(`
        <h3>Lưu mã khôi phục</h3>
        <p class="muted">10 mã dùng một lần. Nếu mất điện thoại, các mã này giúp <b>tự thêm máy mới</b> (chờ 24 giờ) mà không cần nhờ ai. Mã chỉ hiện <b>một lần</b>: chụp màn hình, in ra hoặc lưu vào trình quản lý mật khẩu.</p>
        <pre class="codes">${escHtml(text)}</pre>
        <div class="row"><button class="fit ctl-copy">Sao chép</button><button class="fit ctl-dl">Tải .txt</button></div>
        <label style="display:flex;gap:8px;align-items:center;margin-top:12px"><input type="checkbox" class="ctl-saved"> Tôi đã lưu các mã này</label>
        <div class="row"><button class="primary ctl-done" disabled>Xong</button></div>`);
      m.q('.ctl-saved').onchange = (e) => { m.q('.ctl-done').disabled = !e.target.checked; };
      m.q('.ctl-copy').onclick = async () => { try { await navigator.clipboard.writeText(text); m.q('.ctl-copy').textContent = 'Đã chép'; } catch {} };
      m.q('.ctl-dl').onclick = () => {
        const a = document.createElement('a');
        a.href = URL.createObjectURL(new Blob([`Mã khôi phục Giám sát PLC\n${text}\n`], { type: 'text/plain' }));
        a.download = 'ma-khoi-phuc.txt'; a.click();
      };
      m.q('.ctl-done').onclick = () => { m.close(); resolve(true); };
    });
  }


  /**
   * Máy chưa có vân tay/Authenticator (đăng ký mới hoặc OTP lần đầu): chọn ÍT NHẤT MỘT cách để lần sau khỏi OTP.
   * Vân tay / Face ID, mật khẩu, email đều tuỳ chọn riêng lẻ; email chỉ để khôi phục nên không tính là cách đăng nhập.
   * Trả về true (đã có vân tay → hoàn tất bằng phiên điều khiển) hoặc { basic: true } (chỉ mật khẩu → /api/login/complete-basic).
   */
  function loginSetup(m, canPk, done, opts = {}) {
    const body = m.q('.ctl-body');
    if (opts.recovery) canPk = false;
    let hasPw = Boolean(pendingSession?.methods?.password);
    let hasPk = false;
    body.innerHTML = `
      <h3>${opts.recovery ? 'Đặt lại thông tin đăng nhập' : 'Thiết lập đăng nhập'}</h3>
      <p class="muted">${opts.recovery ? 'Khôi phục thành công. Đặt mật khẩu mới và/hoặc email nếu muốn. Muốn bật lại vân tay / Face ID và điều khiển thiết bị, hãy làm trong Cài đặt (cần xác nhận thêm vì lý do an toàn).' : 'Chọn <b>ít nhất một</b> cách để lần sau không cần OTP. Mỗi mục đều tuỳ chọn, bạn có thể bổ sung sau trong Cài đặt.'}</p>
      <div class="ctl-err" style="color:var(--bad)"></div><div class="ctl-ok" style="color:var(--ok,#16a34a)"></div>
      ${opts.recovery ? '' : canPk ? '<div class="row"><button class="primary" data-a="pk">Bật vân tay / Face ID</button></div>' : '<p class="muted">Máy này không có vân tay / Face ID.</p>'}
      <label>Mật khẩu (từ 8 ký tự)<input type="password" class="su-pw" autocomplete="new-password" placeholder="Mật khẩu"></label>
      <label>Nhập lại mật khẩu<input type="password" class="su-pw2" autocomplete="new-password" placeholder="Nhập lại"></label>
      <div class="row"><button class="fit" data-a="pw">Đặt mật khẩu</button></div>
      <label>Email khôi phục (không bắt buộc)<input type="email" class="su-mail" autocomplete="email" placeholder="ban@example.com"></label>
      <div class="row"><button class="fit" data-a="mail">Gửi mã xác minh email</button></div>
      <div class="su-mailcode" hidden><label>Mã email<input class="su-code" inputmode="numeric" maxlength="6" placeholder="000000"></label>
        <div class="row"><button class="fit" data-a="mailok">Xác nhận email</button></div></div>
      <div class="row"><button class="primary" data-a="go" disabled>${opts.recovery ? 'Vào ứng dụng' : 'Hoàn tất'}</button>${opts.recovery ? '' : '<button class="fit" data-a="x">Huỷ đăng nhập</button>'}</div>`;
    const err = (t) => { m.q('.ctl-err').textContent = t || ''; if (t) m.q('.ctl-ok').textContent = ''; };
    const ok = (t) => { m.q('.ctl-ok').textContent = t || ''; if (t) m.q('.ctl-err').textContent = ''; };
    const refresh = () => {
      m.q('[data-a="go"]').disabled = !(opts.recovery || hasPw || hasPk);
      m.q('[data-a="go"]').title = hasPw || hasPk ? '' : 'Chọn ít nhất một cách: vân tay / Face ID hoặc mật khẩu';
    };
    refresh();
    const click = async (a, b) => {
      err('');
      if (a === 'x') return done(false);
      if (a === 'go') return done(opts.recovery ? true : hasPk ? true : { basic: true });
      b.disabled = true;
      try {
        if (a === 'pk') {
          if (await passkeyEnrollFlow(m)) { hasPk = true; b.textContent = '✓ Đã bật vân tay / Face ID'; ok('Đã bật vân tay / Face ID.'); } else if (m.lastErr) err(errText(m.lastErr));
        } else if (a === 'pw') {
          const p1 = m.q('.su-pw').value; const p2 = m.q('.su-pw2').value;
          if (p1.length < 8) return err(errText('password_weak'));
          if (p1 !== p2) return err('Hai mật khẩu không khớp.');
          const r = await api('POST', '/api/account/password', { password: p1 });
          if (r.ok) { hasPw = true; if (pendingSession) pendingSession.methods = { ...(pendingSession.methods || {}), password: true }; b.textContent = '✓ Đã đặt mật khẩu'; ok('Đã đặt mật khẩu.'); } else err(errText(r.body.error));
        } else if (a === 'mail') {
          const r = await api('POST', '/api/account/email/request', { email: m.q('.su-mail').value.trim() });
          if (r.ok) { m.q('.su-mailcode').hidden = false; ok('Đã gửi mã tới email. Nhập mã để xác minh.'); } else err(errText(r.body.error));
        } else if (a === 'mailok') {
          const r = await api('POST', '/api/account/email/verify', { otp: m.q('.su-code').value.trim() });
          if (r.ok) { m.q('.su-mailcode').hidden = true; ok('Đã xác minh email (dùng để khôi phục sau 72 giờ).'); } else err(errText(r.body.error));
        }
      } finally { b.disabled = false; refresh(); }
    };
    body.querySelectorAll('button[data-a]').forEach((b) => { b.onclick = () => click(b.dataset.a, b); });
  }

  /** Mở khoá lại ứng dụng (đã khoá do nền/nhàn rỗi) cho tài khoản chỉ có mật khẩu. */
  function passwordPrompt(m, done) {
    const body = m.q('.ctl-body');
    body.innerHTML = `
      <h3>Mở khoá ứng dụng</h3>
      <div class="ctl-err" style="color:var(--bad)"></div>
      <label>Mật khẩu<input type="password" class="pp-pw" autocomplete="current-password" placeholder="Mật khẩu"></label>
      <div class="row"><button class="primary pp-go">Mở khoá</button><button class="fit pp-x">Huỷ</button></div>`;
    const go = () => { const v = m.q('.pp-pw').value; if (!v) { m.q('.ctl-err').textContent = errText('password_invalid'); return; } done({ basic: true, password: v }); };
    m.q('.pp-go').onclick = go;
    m.q('.pp-pw').onkeydown = (e) => { if (e.key === 'Enter') go(); };
    m.q('.pp-x').onclick = () => done(false);
    setTimeout(() => m.q('.pp-pw')?.focus(), 50);
  }

  /** Chọn cách đăng ký yếu tố điều khiển trên máy này (lần đầu, hoặc máy mới đã có vé). */
  function enrollChoice(m, canPkPlatform, done, title = 'Bảo mật điều khiển') {
    const body = m.q('.ctl-body');
    {
      body.innerHTML = `
        <h3>${escHtml(title)}</h3>
        <p class="muted">Chọn cách xác nhận mỗi khi điều khiển thiết bị từ xa. Chỉ cần làm một lần trên máy này.</p>
        <div class="ctl-err" style="color:var(--bad)"></div>
        <div class="row" style="flex-direction:column;gap:8px">
          ${canPkPlatform ? '<button class="primary" data-a="pk">Dùng vân tay / Face ID</button>' : ''}
          <button class="${canPkPlatform ? 'fit' : 'primary'}" data-a="totp">Thiết lập / thay Authenticator (mã 6 số)</button>
          <button class="fit" data-a="x">${pendingSession ? 'Huỷ đăng nhập' : 'Để sau'}</button>
        </div><p class="muted">Thiết lập Authenticator mới thay khoá Authenticator cũ của tài khoản; không thêm hai khoá Authenticator song song.</p>`;
      body.querySelectorAll('button').forEach((b) => {
        b.onclick = async () => {
          const a = b.dataset.a;
          m.lastErr = '';
          if (a === 'x') return done(false);
          if (a === 'pk' && await passkeyEnrollFlow(m)) done(true);
          if (a === 'totp') { const r = await totpSetupFlow(m); if (r === true) done(true); else if (r === false) done(false); }
          // Không phải thiết bị đầu tiên của tài khoản: đường vào là email / chờ 24 giờ
          if (m.lastErr === 'first_device_required' && !m.q('.ctl-nd')) {
            const nd = document.createElement('button');
            nd.className = 'primary ctl-nd';
            nd.textContent = 'Thêm máy này vào tài khoản';
            nd.onclick = () => newDeviceFlow(m, done, canPkPlatform);
            m.q('.ctl-body .row').prepend(nd);
          }
        };
      });
    }
  }

  /**
   * Máy mới (mất máy cũ hoặc đổi máy): xin quyền bằng
   *   • duyệt từ máy cũ (ngay)  • mã khôi phục / OTP email (chờ 24 giờ, chủ được báo và có thể huỷ).
   * Yêu cầu được nhớ trong localStorage nên đóng ứng dụng đi chờ rồi quay lại vẫn tiếp tục được.
   */
  async function newDeviceFlow(m, done, canPkPlatform) {
    const body = m.q('.ctl-body');
    const gone = () => !document.body.contains(m.el);
    const fmtT = (ms) => new Date(ms).toLocaleString('vi-VN');
    const ua = /iPhone|iPad/.test(navigator.userAgent) ? 'iPhone' : /Android/.test(navigator.userAgent) ? 'Android' : 'Máy tính';
    const label = `${ua} ${new Date().toLocaleDateString('vi-VN')}`;
    const closeBtn = '<div class="row"><button class="fit ctl-close">Đóng</button></div>';
    const wireClose = () => { const b = m.q('.ctl-close'); if (b) b.onclick = () => done(false); };
    const poll = (req) => api('POST', `/api/devices/requests/${req.id}/poll`, { pollToken: req.pollToken });

    let req = LS.get('devReq', null);
    if (req && req.userId !== session()?.userId) { LS.del('devReq'); req = null; }
    let st = null;
    if (req) {
      const r = await poll(req);
      if (r.ok && ['pending', 'cooling', 'approved'].includes(r.body.status)) st = r.body; else { LS.del('devReq'); req = null; }
    }
    if (!req) {
      const replaceLost = await new Promise((resolve) => {
        body.innerHTML = `<h3>Thêm thiết bị</h3><label><input type="checkbox" class="ctl-lost"> Máy cũ bị mất: thu hồi yếu tố và phiên cũ khi máy mới thiết lập xong</label>
          <div class="row"><button class="primary ctl-request">Tiếp tục</button><button class="fit ctl-close">Huỷ</button></div>`;
        m.q('.ctl-close').onclick = () => resolve(null);
        m.q('.ctl-request').onclick = () => resolve(m.q('.ctl-lost').checked);
      });
      if (replaceLost === null) return done(false);
      const r = await api('POST', '/api/devices/request', { label, replaceLost });
      if (!r.ok) {
        body.innerHTML = `<h3>Thêm thiết bị mới</h3><p style="color:var(--bad)">${escHtml(errText(r.body.error))}</p>${closeBtn}`;
        return wireClose();
      }
      req = { id: r.body.id, pollToken: r.body.pollToken, options: r.body.options, coolingHours: r.body.coolingHours, emailHint: r.body.emailHint, userId: session()?.userId, approvalCode: r.body.approvalCode, kind: r.body.kind };
      LS.set('devReq', req);
      st = { status: 'pending' };
    }

    let shown = null; let enrolling = false;
    const err = (t) => { const e = m.q('.ctl-err'); if (e) e.textContent = t || ''; };

    function renderPending() {
      const o = req.options || {};
      body.innerHTML = `
        <h3>Thêm thiết bị mới</h3>
        <p>Mã ghép: <b>${escHtml(req.approvalCode || '')}</b></p>
        ${o.device === false ? '' : '<p><b>Cách nhanh nhất:</b> mở ứng dụng trên <b>máy cũ</b> → sẽ có thông báo "Thiết bị mới xin vào" → bấm <b>Cho phép</b>. Màn hình này tự tiếp tục.</p>'}
        <div class="ctl-err" style="color:var(--bad)"></div>
        ${o.recoveryCode ? `<hr><p class="muted">Không còn máy cũ? Dùng <b>mã khôi phục</b> (chờ ${req.coolingHours || 24} giờ):</p>
          <input class="ctl-rc" placeholder="XXXX-XXXX-XXXX" autocapitalize="characters" autocomplete="off">
          <div class="row"><button class="fit ctl-rc-go">Dùng mã khôi phục</button></div>` : ''}
        ${o.email ? `<hr><p class="muted">Nhận mã qua <b>email đã xác minh</b>${req.emailHint ? ` (${escHtml(req.emailHint)})` : ''}:</p>
          <div class="row ctl-em-1"><button class="fit ctl-em-send">Gửi mã tới email</button></div>
          <div class="ctl-em-2" hidden><input class="ctl-em-otp" inputmode="numeric" maxlength="6" placeholder="Mã 6 số trong email">
            <div class="row"><button class="fit ctl-em-go">Xác nhận</button></div></div>` : ''}
        ${o.wait ? `<hr><p class="muted">Không có máy cũ để duyệt. Có thể <b>chờ ${req.coolingHours || 24} giờ</b>: chủ tài khoản được báo và huỷ được nếu đây không phải bạn.</p><div class="row"><button class="fit ctl-wait">Chờ ${req.coolingHours || 24} giờ</button></div>` : ''}
        ${!o.recoveryCode && !o.email && !o.wait ? '<p class="muted">Chưa có mã khôi phục hay email đã xác minh nên chỉ duyệt được từ máy cũ. Nếu mất máy cũ, hãy dùng <a href="recover.html">Khôi phục tài khoản</a>.</p>' : ''}
        ${closeBtn}`;
      wireClose();
      const wt = m.q('.ctl-wait');
      if (wt) wt.onclick = async () => {
        const r = await api('POST', `/api/devices/requests/${req.id}/wait`, {});
        if (!r.ok) return err(errText(r.body.error));
        handle({ status: r.body.status, executeAt: r.body.executeAt });
      };
      const rc = m.q('.ctl-rc-go');
      if (rc) rc.onclick = async () => {
        const r = await api('POST', `/api/devices/requests/${req.id}/recovery`, { code: m.q('.ctl-rc').value.trim() });
        if (!r.ok) return err(errText(r.body.error));
        handle({ status: r.body.status, executeAt: r.body.executeAt });
      };
      const es = m.q('.ctl-em-send');
      if (es) {
        es.onclick = async () => {
          const r = await api('POST', `/api/devices/requests/${req.id}/email/start`, {});
          if (!r.ok) return err(errText(r.body.error));
          m.q('.ctl-em-1').hidden = true; m.q('.ctl-em-2').hidden = false;
        };
        m.q('.ctl-em-go').onclick = async () => {
          const r = await api('POST', `/api/devices/requests/${req.id}/email/confirm`, { otp: m.q('.ctl-em-otp').value.trim() });
          if (!r.ok) return err(errText(r.body.error));
          handle({ status: r.body.status, executeAt: r.body.executeAt });
        };
      }
    }

    function handle(b) {
      if (enrolling || gone()) return;
      if (b.status === 'approved' && b.ticket) {
        enrolling = true;
        LS.set('enroll', { ticket: b.ticket, exp: Date.now() + (b.ticketExpiresIn || 900) * 1000 });
        LS.del('devReq');
        return enrollChoice(m, canPkPlatform, (v) => {
          LS.del('enroll');
          if (v && req.kind !== 'replace_lost') LS.set('reviewDevices', { userId: session()?.userId });
          done(v);
        }, 'Thiết bị đã được cho phép');
      }
      if (b.status === shown) return;
      shown = b.status;
      if (b.status === 'cooling') {
        body.innerHTML = `
          <h3>Đang chờ cấp quyền</h3>
          <p>Vì dùng ${'mã khôi phục / email'}, quyền sẽ được cấp lúc <b>${fmtT(b.executeAt)}</b>. Chủ tài khoản đã được báo và có thể huỷ nếu đây không phải bạn.</p>
          <p class="muted">Có thể đóng ứng dụng; quay lại sau thời điểm trên và mở lại hộp thoại này để hoàn tất.</p>${closeBtn}`;
        wireClose();
      } else if (['denied', 'cancelled', 'expired'].includes(b.status)) {
        LS.del('devReq');
        const why = { denied: 'Máy cũ đã từ chối yêu cầu.', cancelled: 'Yêu cầu đã bị huỷ.', expired: 'Yêu cầu đã hết hạn.' }[b.status];
        body.innerHTML = `<h3>Thêm thiết bị mới</h3><p>${why}</p>${closeBtn}`;
        wireClose();
      } else renderPending();
    }

    handle(st);
    while (!gone() && !enrolling) {
      await new Promise((r) => setTimeout(r, 3000));
      if (gone() || enrolling) break;
      const r = await poll(req);
      if (r.status === 401) {
        body.innerHTML = `<h3>Phiên xác thực hết hạn</h3><p>Đăng nhập OTP lại để tiếp tục yêu cầu đã lưu.</p>${closeBtn}`;
        wireClose();
        break;
      }
      if (r.ok) handle(r.body);
    }
    return null;
  }

  /** Máy cũ: xem các thiết bị đang xin vào, Cho phép / Từ chối. */
  async function reviewDevices() {
    let r = await api('GET', '/api/devices/requests');
    if (r.status === 401 && r.body.error === 'step_up_required') {
      LS.del('ctl');
      if (!(await unlock(r.body))) return;
      r = await api('GET', '/api/devices/requests');
    }
    if (!r.ok) return;
    let list = r.body.requests || [];
    if (!list.length) { const m0 = modal('<h3>Thiết bị mới</h3><p class="muted">Không có yêu cầu nào đang chờ.</p><div class="row"><button class="fit ctl-close">Đóng</button></div>'); m0.q('.ctl-close').onclick = m0.close; return; }
    const m = modal('<div class="ctl-body"></div>');
    const draw = () => {
      if (!list.length) return m.close();
      m.q('.ctl-body').innerHTML = `
        <h3>Thiết bị mới xin vào</h3>
        <p class="muted">Chỉ <b>Cho phép</b> nếu chính bạn vừa đăng nhập trên máy mới. Nếu không phải bạn, bấm <b>Từ chối</b>.</p>
        <div class="ctl-err" style="color:var(--bad)"></div>
        ${list.map((q) => `<div class="pend"><b>${escHtml(q.label || 'Thiết bị')}</b><br>
          <span class="muted">${new Date(q.createdAt).toLocaleString('vi-VN')}${q.ip ? ` · IP ${escHtml(q.ip)}` : ''}${q.status === 'cooling' ? ` · sẽ tự được cấp lúc ${new Date(q.executeAt).toLocaleString('vi-VN')}` : ''}</span>
          ${q.kind === 'replace_lost' ? '<p>Máy cũ được khai báo bị mất. Hoàn tất sẽ thu hồi yếu tố và phiên cũ.</p>' : ''}
          <label>Mã ghép trên máy mới<input data-code="${q.id}" inputmode="numeric" maxlength="6" autocomplete="off"></label>
          <div class="row"><button class="primary" data-a="approve" data-id="${q.id}">Cho phép</button><button class="danger" data-a="deny" data-id="${q.id}">Từ chối</button></div></div>`).join('')}
        <div class="row"><button class="fit ctl-close">Đóng</button></div>`;
      m.q('.ctl-close').onclick = m.close;
      m.el.querySelectorAll('[data-a]').forEach((b) => {
        b.onclick = async () => {
          const x = await api('POST', `/api/devices/requests/${b.dataset.id}/${b.dataset.a}`, { approvalCode: m.q(`[data-code="${b.dataset.id}"]`)?.value || '' });
          if (!x.ok) { m.q('.ctl-err').textContent = errText(x.body.error); return; }
          list = list.filter((q) => q.id !== b.dataset.id); draw();
        };
      });
    };
    draw();
  }

  async function reviewRegisteredDevices() {
    let result = await api('GET', '/api/devices');
    if (result.body.error === 'step_up_required' && await unlock(result.body)) result = await api('GET', '/api/devices');
    if (!result.ok) return;
    const devices = result.body.devices || [];
    if (devices.length < 2) return;
    await new Promise((resolve) => {
      const m = modal(`<h3>Thiết bị đã đăng ký</h3><div class="ctl-err"></div><div class="ctl-devices"></div>
        <div class="row"><button class="primary ctl-close">Tiếp tục</button></div>`);
      m.q('.ctl-devices').innerHTML = devices.map((device) => `<div class="pend"><b>${escHtml(device.label || 'Thiết bị')}</b>
        <p style="overflow-wrap:anywhere">${escHtml(device.device_id)}<br>${new Date(device.created_at).toLocaleString('vi-VN')}</p>
        ${device.device_id === result.body.currentDevice ? '<p>Máy này</p>' : `<button class="danger" data-revoke="${escHtml(device.device_id)}">Thu hồi máy cũ</button>`}</div>`).join('');
      m.q('.ctl-close').onclick = () => { m.close(); resolve(); };
      m.el.querySelectorAll('[data-revoke]').forEach((button) => {
        button.onclick = async () => {
          button.disabled = true;
          const revoked = await api('POST', `/api/devices/${encodeURIComponent(button.dataset.revoke)}/revoke`, {});
          if (revoked.ok) button.closest('.pend').remove();
          else { m.q('.ctl-err').textContent = errText(revoked.body.error); button.disabled = false; }
        };
      });
    });
  }

  /** Hỏi người dùng xác thực để mở khoá điều khiển. Resolve true khi đã có phiên điều khiển. */
  function unlock(info = {}) {
    const methods = info.methods || { passkey: false, totp: false, enrolled: false };
    const extra = info.commandChallenge ? { 'X-Command-Challenge': info.commandChallenge } : undefined;
    return new Promise(async (resolve) => {
      const canPk = passkeySupported();
      const canPlatform = await platformAuthenticator();
      const m = modal(`<div class="ctl-body"></div>`);
      let finished = false;
      const done = (v) => { if (!finished) { finished = true; m.close(); resolve(v); } };
      const body = m.q('.ctl-body');

      const render = () => {
        const reason = { network_changed: 'Bạn vừa đổi mạng — cần xác nhận lại.', expired: 'Phiên điều khiển đã hết hạn.' }[info.reason] || '';
        if (!methods.enrolled && pendingSession) {
          if (pendingSession.src === 'resume' && methods.password) passwordPrompt(m, done); else loginSetup(m, canPk && canPlatform, done);
          return;
        }
        if (!methods.enrolled) { enrollChoice(m, canPk, done, info.title || 'Thiết lập bảo mật'); return; }
        body.innerHTML = `
          <h3>${escHtml(info.title || 'Xác nhận để điều khiển')}</h3>
          ${reason ? `<p class="muted">${reason}</p>` : ''}
          <div class="ctl-err" style="color:var(--bad)"></div>
          ${methods.passkey && canPk ? '<div class="row"><button class="primary ctl-pk">Dùng vân tay / Face ID</button></div>' : ''}
          ${methods.totp ? `<label>Mã Authenticator<input class="ctl-code" inputmode="numeric" maxlength="6" autocomplete="one-time-code" placeholder="000000"></label>
            <div class="row"><button class="${methods.passkey && canPk ? 'fit' : 'primary'} ctl-go">Xác nhận</button></div>` : ''}
          <div class="row"><button class="fit ctl-newdev">Máy mới / mất máy cũ?</button><button class="fit ctl-cancel">Huỷ</button></div>`;
        const err = (t) => { if (!finished && m.q('.ctl-err')) m.q('.ctl-err').textContent = t || ''; };
        m.q('.ctl-cancel').onclick = () => done(false);
        m.q('.ctl-newdev').onclick = () => newDeviceFlow(m, done, canPk && canPlatform);
        const pk = m.q('.ctl-pk');
        if (pk) {
          const run = async () => {
            try {
              const r = await passkeyUnlock(extra);
              if (r.ok) return done(true);
              err(errText(r.error));
            } catch (e) { err(e?.name === 'NotAllowedError' ? 'Đã huỷ trên thiết bị.' : errText('webauthn_failed')); }
          };
          pk.onclick = run;
          if (!methods.totp) run(); // chỉ có passkey: bật luôn hộp xác thực sinh trắc
        }
        const go = m.q('.ctl-go');
        if (go) {
          const input = m.q('.ctl-code');
          go.onclick = async () => {
            if (go.disabled || finished) return;
            const code = input.value.trim();
            if (!/^\d{6}$/.test(code)) { err('Nhập mã Authenticator gồm 6 chữ số.'); input.focus(); return; }
            go.disabled = true;
            err('');
            try {
              const r = await totpUnlock(code, extra);
              if (r.ok) done(true); else err(errText(r.error));
            } finally { go.disabled = false; }
          };
          input.onkeydown = (e) => { if (e.key === 'Enter') go.click(); };
          setTimeout(() => input.focus(), 50);
        }
      };
      if (methods.enrolled && LS.get('devReq', null)) newDeviceFlow(m, done, canPk && canPlatform); else render();
    });
  }

  /* ---------- đăng nhập bằng passkey (không cần SĐT, không OTP) ---------- */
  async function loginWithPasskey() {
    dbg('login.start', 'Đăng nhập Passkey/Face ID (không OTP)');
    const post = async (path, body) => {
      const r = await fetch(location.origin + path, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Device-Id': devId() }, body: JSON.stringify(body) });
      return { ok: r.ok, body: await r.json().catch(() => ({})) };
    };
    const o = await post('/api/login/passkey/options', {});
    if (!o.ok) {
      dbg('login.options_fail', o.body?.error || 'options failed', o.body, 'error');
      return o.body;
    }
    dbg('login.options_ok', 'Challenge login — chờ Face ID', { cid: o.body?.cid });
    let cred;
    try {
      cred = await navigator.credentials.get({
        publicKey: { ...o.body, challenge: b64uToBuf(o.body.challenge), allowCredentials: [], hints: ['client-device'] },
      });
    } catch (e) {
      dbg('login.gesture_fail', e?.name || 'get failed', { name: e?.name, message: e?.message }, 'error');
      throw e;
    }
    dbg('login.gesture_ok', 'Face ID / vân tay OK', { credId: String(cred?.id || '').slice(0, 16) }, 'ok');
    const r = await post('/api/login/passkey/verify', {
      cid: o.body.cid,
      credential: {
        id: cred.id,
        response: {
          clientDataJSON: bufToB64u(cred.response.clientDataJSON),
          authenticatorData: bufToB64u(cred.response.authenticatorData),
          signature: bufToB64u(cred.response.signature),
          userHandle: cred.response.userHandle ? bufToB64u(cred.response.userHandle) : undefined,
        },
      },
    });
    if (r.ok) {
      saveToken(r.body);
      LS.set('hasPasskey', true);
      dbg('login.verify_ok', 'Đăng nhập Passkey thành công', { userId: r.body?.userId }, 'ok');
    } else {
      dbg('login.verify_fail', r.body?.error || 'verify failed', r.body, 'error');
    }
    return r.body;
  }

  /** Sau khôi phục 2 yếu tố: hộp đặt lại mật khẩu / email. Phiên khôi phục (token có rec) được phép đặt lại ngay. */
  function recoverySetup() {
    return new Promise((resolve) => {
      const m = modal('<div class="ctl-body"></div>');
      loginSetup(m, false, (v) => { m.close(); resolve(v); }, { recovery: true });
    });
  }

  /** Chứng minh bằng vân tay / Face ID cho khôi phục (không đăng nhập): trả { cid, credential } để gửi kèm yếu tố khác. */
  async function passkeyProof() {
    const o = await fetch(location.origin + '/api/login/passkey/options', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Device-Id': devId() }, body: '{}' }).then((r) => r.json());
    const cred = await navigator.credentials.get({ publicKey: { ...o, challenge: b64uToBuf(o.challenge), allowCredentials: [], hints: ['client-device'] } });
    return {
      cid: o.cid,
      credential: {
        id: cred.id,
        response: {
          clientDataJSON: bufToB64u(cred.response.clientDataJSON),
          authenticatorData: bufToB64u(cred.response.authenticatorData),
          signature: bufToB64u(cred.response.signature),
          userHandle: cred.response.userHandle ? bufToB64u(cred.response.userHandle) : undefined,
        },
      },
    };
  }

  async function completeOtp(data) {
    if (!data.pending || !data.token) throw new Error(errText('login_step_up_required'));
    pendingSession = { token: data.token, userId: data.userId, apiBase: location.origin, src: data.src, methods: data.methods };
    if (data.methods?.passkey) LS.set('hasPasskey', true); // khôi phục cờ sau khi người dùng xoá dữ liệu trình duyệt
    LS.del('ctl');
    try {
      // OTP vừa xác minh + tài khoản chưa có vân tay nhưng đã có mật khẩu: vào luôn, không bắt thiết lập lại
      const direct = !data.methods?.enrolled && data.methods?.password && data.src !== 'resume';
      const proof = direct ? { basic: true } : await unlock({ methods: data.methods, title: data.methods?.enrolled ? 'Xác nhận đăng nhập' : 'Thiết lập bảo mật đăng nhập' });
      if (!proof) return null;
      const result = proof.basic ? await api('POST', '/api/login/complete-basic', proof.password ? { password: proof.password } : {}) : await api('POST', '/api/login/complete', {});
      if (!result.ok) throw new Error(errText(result.body.error));
      return result.body;
    } finally {
      pendingSession = null;
      LS.del('ctl');
    }
  }

  async function resumeLogin() {
    const result = await api('POST', '/api/login/resume', {});
    if (!result.ok) throw new Error(errText(result.body.error));
    return completeOtp(result.body);
  }

  /** Sau lần đăng nhập OTP đầu tiên: mời bật vân tay / Authenticator để lần sau khỏi cần OTP. Nhắc lại sau 7 ngày nếu bỏ qua. */
  async function offerEnroll() {
    const skipped = LS.get('ctlSkip', 0);
    if (skipped && Date.now() - skipped < 7 * 86_400_000) return;
    const st = await api('GET', '/api/control/status');
    if (!st.ok || !st.body.stepUp) return;
    if (st.body.methods.enrolled) return;
    if (!(await unlock({ methods: st.body.methods }))) LS.set('ctlSkip', Date.now());
  }

  /* ---------- thông báo trong tab Điều khiển: bắt buộc bật vân tay / Authenticator ---------- */
  async function renderBanner() {
    const el = $('#ctl-banner');
    const s = session();
    if (!el || !s?.token || s.demo) return;
    const st = await api('GET', '/api/control/status');
    if (!st.ok || !st.body.stepUp || !st.body.enroll?.needed) { el.hidden = true; return; }
    const e = st.body.enroll;
    const days = e.deadline ? Math.max(0, Math.ceil((e.deadline - Date.now()) / 86_400_000)) : null;
    el.hidden = false;
    el.className = `ctl-banner ${e.locked ? 'bad' : 'warn'}`;
    el.innerHTML = (e.locked
      ? '<b>🔒 Điều khiển đã bị khoá.</b> Bạn <b>phải bật vân tay / Face ID hoặc Authenticator</b> mới điều khiển lại được. Vẫn xem được số liệu bình thường. Nếu máy của bạn không hỗ trợ cả hai, tài khoản này chỉ dùng để xem (nhờ quản trị đặt vai trò chỉ xem).'
      : `<b>⚠️ Cần bật vân tay / Face ID hoặc Authenticator</b>${days != null ? ` trong <b>${days} ngày</b> nữa` : ''}. Quá hạn, điều khiển sẽ bị khoá.`)
      + '<div class="row"><button class="primary ctl-bn-go">Bật ngay</button>'
      + (e.locked ? '<button class="fit ctl-bn-relogin">Đăng nhập lại rồi bật</button>' : '') + '</div>';
    el.querySelector('.ctl-bn-go').onclick = async () => { await unlock({ methods: st.body.methods }); renderBanner(); document.dispatchEvent(new Event('ctl-changed')); };
    const rl = el.querySelector('.ctl-bn-relogin');
    if (rl) rl.onclick = () => { LS.del('session'); LS.del('ctl'); location.replace('login.html'); };
  }

  const devId = () => {
    let d = LS.get('devId', null);
    if (!d) {
      d = (window.crypto?.randomUUID?.() || Array.from(crypto.getRandomValues(new Uint8Array(16)), (x) => x.toString(16).padStart(2, '0')).join(''));
      LS.set('devId', d);
    }
    return d;
  };

  window.Security = {
    recoverySetup, passkeyProof, api, unlock, errText, addErrors, modal, escHtml, LS, loginWithPasskey, offerEnroll, completeOtp, resumeLogin, passkeySupported, platformAvailable: platformAuthenticator,
    reviewDevices, reviewRegisteredDevices, renderBanner, devId,
  };

  /* ---------- Cài đặt → "Điều khiển & xác thực" ---------- */
  async function settingsPanel() {
    const root = $('#ctl-sec');
    const s = session();
    if (!root || !s?.token || s.demo) return;
    root.hidden = false;
    const msg = (t, bad) => { const e = $('#ctl-msg'); e.textContent = t || ''; e.classList.toggle('err', Boolean(bad)); };

    const hasBiometric = await platformAuthenticator();
    $('#ctl-pk-add').hidden = !hasBiometric; // máy không có vân tay/Face ID/Windows Hello: chỉ còn Authenticator
    async function refresh() {
      const st = await api('GET', '/api/control/status');
      if (!st.ok) { $('#ctl-state').textContent = errText(st.body.error); return; }
      const m = st.body.methods;
      $('#ctl-state').textContent = !st.body.stepUp ? 'Xác thực bổ sung đang tắt trên máy chủ.'
        : `${m.passkey ? 'Vân tay / Face ID: đã bật. ' : ''}${m.totp ? 'Authenticator: đã bật. ' : ''}${!m.enrolled ? 'Chưa thiết lập — bạn sẽ không điều khiển được cho tới khi thiết lập.' : ''}`
        + (hasBiometric || m.passkey ? '' : ' Máy này không có vân tay / Face ID / Windows Hello nên dùng Authenticator.')
        + (st.body.unlocked ? ' Đang mở khoá điều khiển.' : '')
        + (m.enrolled ? ' Mã khôi phục còn ' + st.body.recoveryCodesLeft + '.' + (st.body.recoveryCodesLeft ? '' : ' ⚠️ Hãy tạo mã mới ở mục Mã khôi phục.') : '');
      if (st.body.pendingDevices > 0 && !refresh.prompted) { refresh.prompted = true; reviewDevices(); }
      $('#ctl-totp-add').textContent = m.totp ? 'Đặt lại Authenticator (máy mới)' : 'Bật Authenticator';
      $('#ctl-totp-off').hidden = !m.totp;
      $('#ctl-lock').hidden = !st.body.unlocked;
      const l = await api('GET', '/api/webauthn/credentials');
      $('#ctl-list').innerHTML = (l.body.credentials || []).map((c) =>
        `<div class="row" style="align-items:center"><span style="flex:1">${escHtml(c.name || 'Thiết bị')} · ${new Date(c.created_at).toLocaleDateString('vi-VN')}</span><button class="fit" data-del="${c.id}">Xoá</button></div>`).join('');
      $('#ctl-list').querySelectorAll('[data-del]').forEach((b) => {
        b.onclick = async () => {
          let r = await api('DELETE', `/api/webauthn/credentials/${b.dataset.del}`);
          if (r.status === 401 && r.body.error === 'step_up_required' && await unlock(r.body)) r = await api('DELETE', `/api/webauthn/credentials/${b.dataset.del}`);
          if (r.ok) LS.del('ctl'); // xoá vân tay thu hồi mọi phiên điều khiển trên server → bỏ token cục bộ
          msg(r.ok ? 'Đã xoá.' : errText(r.body.error), !r.ok); refresh();
        };
      });
    }

    $('#ctl-pk-add').onclick = async () => {
      msg('');
      if (!passkeySupported()) return msg('Trình duyệt này không hỗ trợ vân tay / Face ID (cần HTTPS). Hãy dùng Authenticator.', true);
      try {
        let r = await passkeyRegister('Thiết bị');
        if (r.error === 'step_up_required' && await unlock({ ...r, methods: (await api('GET', '/api/control/status')).body.methods })) r = await passkeyRegister('Thiết bị');
        msg(r.ok ? 'Đã thêm vân tay / Face ID.' : errText(r.error), !r.ok);
      } catch (e) { msg(e?.name === 'NotAllowedError' ? 'Đã huỷ trên thiết bị.' : errText('webauthn_failed'), true); }
      refresh();
    };
    $('#ctl-totp-add').onclick = async () => {
      msg('');
      const m = modal('<div class="ctl-body"><p class="ctl-err" style="color:var(--bad)"></p></div>');
      const ok = await totpSetupFlow(m);
      m.close(); msg(ok ? 'Đã bật Authenticator.' : '', false); refresh();
    };
    $('#ctl-totp-off').onclick = async () => {
      let r = await api('POST', '/api/control/totp/disable', {});
      if (r.status === 401 && await unlock({ ...r.body, methods: (await api('GET', '/api/control/status')).body.methods })) r = await api('POST', '/api/control/totp/disable', {});
      if (r.ok) LS.del('ctl');
      msg(r.ok ? 'Đã tắt Authenticator.' : errText(r.body.error), !r.ok); refresh();
    };
    $('#ctl-lock').onclick = async () => { await api('POST', '/api/control/lock', {}); LS.del('ctl'); msg('Đã khoá điều khiển trên thiết bị này.'); refresh(); };
    document.addEventListener('ctl-changed', () => { refresh.prompted = true; refresh(); });
    $('#ctl-review').onclick = () => reviewDevices();
    $('#ctl-logout-all').onclick = async () => {
      if (!confirm('Đăng xuất mọi máy (kể cả máy này) và thu hồi mọi phiên điều khiển?')) return;
      let r = await api('POST', '/api/account/logout-all', {});
      if (r.status === 401 && r.body.error === 'step_up_required' && await unlock(r.body)) r = await api('POST', '/api/account/logout-all', {});
      if (r.ok) { LS.del('session'); LS.del('ctl'); location.replace('login.html?revoked=1'); } else msg(errText(r.body.error), true);
    };
    refresh();
    // máy đang mở khoá: cứ 30 giây hỏi xem có thiết bị mới xin vào không
    setInterval(() => { if (!document.hidden && LS.get('ctl', null)) refresh.prompted = false, refresh(); }, 30000);
  }

  const boot = () => { settingsPanel(); renderBanner(); setInterval(() => { if (!document.hidden) renderBanner(); }, 60_000); };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();
}());
