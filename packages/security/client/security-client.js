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
    setup_incomplete: 'Tài khoản mới phải đăng ký đủ Face ID / vân tay (nếu máy hỗ trợ) và mật khẩu trước khi vào.',
    biometric_required: 'Máy này hỗ trợ Face ID / vân tay nên phải bật trước khi hoàn tất đăng ký.',
    platform_unavailable: 'Máy này không có Face ID / vân tay / Windows Hello (hoặc trình duyệt không hỗ trợ) nên không bật được. Dùng mật khẩu hoặc Authenticator.',
    missing_credentials: 'Nhập mật khẩu hoặc mã OTP.',
    password_locked: 'Nhập sai mật khẩu quá nhiều lần. Thử lại sau 15 phút hoặc dùng OTP Telegram.',
    password_new_device: 'Máy này chưa xác nhận OTP Telegram: cần thêm Face ID / vân tay (đã bật trước đó) hoặc dùng OTP Telegram.',
    second_factor_required: 'Máy này chưa xác nhận OTP Telegram: nhập thêm mật khẩu rồi bấm Đăng nhập, hoặc dùng OTP Telegram.',
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

  /**
   * Hộp xác nhận sinh trắc kiểu app phổ biến: biểu tượng Face ID / vân tay, trạng thái, nút Tiếp tục.
   * Lệnh WebAuthn chỉ chạy khi người dùng chạm nút trong hộp này (cử chỉ mới), nên iOS không chặn dù lấy challenge mất thời gian.
   */
  const FACE_SVG = '<svg viewBox="0 0 64 64" fill="none" stroke="currentColor" stroke-width="3.2" stroke-linecap="round" stroke-linejoin="round"><path d="M8 22V14a6 6 0 0 1 6-6h8M42 8h8a6 6 0 0 1 6 6v8M56 42v8a6 6 0 0 1-6 6h-8M22 56h-8a6 6 0 0 1-6-6v-8"/><path d="M23 25v5M41 25v5M32 26v9h-3M23 43c5 5 13 5 18 0"/></svg>';
  const FINGER_SVG = '<svg viewBox="0 0 64 64" fill="none" stroke="currentColor" stroke-width="3.2" stroke-linecap="round" stroke-linejoin="round"><path d="M16 26a16 16 0 0 1 32 0M12 34a20 20 0 0 1 40 0v4M22 52c3-5 4-9 4-14a6 6 0 0 1 12 0c0 6 2 10 6 14M32 38c0 6-1 11-5 16M44 48c1 2 2 4 4 6M20 32a12 12 0 0 1 24 0"/></svg>';
  const CHECK_SVG = '<svg viewBox="0 0 64 64" fill="none" stroke="currentColor" stroke-width="4" stroke-linecap="round" stroke-linejoin="round"><circle cx="32" cy="32" r="24"/><path d="M21 33l8 8 15-17"/></svg>';
  const isApple = () => /iPhone|iPad|Macintosh/.test(navigator.userAgent) && 'ontouchend' in document;
  // Web không cho biết loại cảm biến, nên đoán nhãn theo thiết bị: iPhone màn hình dài (cạnh >= 812) = Face ID, iPhone khác / iPad = Touch ID.
  const bioName = () => {
    const ua = navigator.userAgent;
    if (/iPhone/.test(ua)) return Math.max(screen.width, screen.height) >= 812 ? 'Face ID' : 'Touch ID';
    if (/iPad/.test(ua) || (/Macintosh/.test(ua) && 'ontouchend' in document)) return 'Touch ID';
    if (/Windows/.test(ua)) return 'Windows Hello';
    return 'vân tay';
  };

  function bioSheet({ title, hint, goLabel = 'Tiếp tục' }) {
    const m = modal(`<div class="ctl-body bio-sheet">
      <div class="bio-icon bio-wait">${bioName() === 'Face ID' ? FACE_SVG : FINGER_SVG}</div>
      <h3>${escHtml(title)}</h3>
      <p class="muted bio-msg">Đang chuẩn bị…</p>
      <div class="row"><button class="primary bio-go" disabled>${escHtml(goLabel)}</button><button class="fit bio-x">Huỷ</button></div></div>`);
    const icon = m.q('.bio-icon'); const msg = m.q('.bio-msg'); const go = m.q('.bio-go'); const x = m.q('.bio-x');
    const state = (cls, svg) => { icon.className = `bio-icon ${cls}`; if (svg) icon.innerHTML = svg; };
    let cancel = () => {};
    x.onclick = () => { cancel(); m.close(); };
    return {
      /** Báo đã sẵn sàng; chờ người dùng chạm rồi chạy fn() ngay trong cử chỉ đó. Trả về kết quả của fn. */
      waitTap(fn) {
        return new Promise((resolve, reject) => {
          cancel = () => reject(new DOMException('cancelled', 'NotAllowedError'));
          msg.textContent = hint; go.disabled = false; go.focus();
          go.onclick = () => {
            go.disabled = true; msg.textContent = `Hãy xác nhận ${bioName()} trên máy…`; state('bio-scan');
            let p; try { p = fn(); } catch (e) { return reject(e); }
            Promise.resolve(p).then(resolve, reject);
          };
        });
      },
      status(t) { msg.textContent = t; },
      ok(t) { state('bio-ok', CHECK_SVG); msg.textContent = t; go.hidden = true; x.hidden = true; },
      fail(t) { state('bio-fail'); msg.textContent = t; go.hidden = true; x.hidden = false; x.textContent = 'Đóng'; x.onclick = () => m.close(); },
      close() { m.close(); },
    };
  }

  /**
   * Safari/iOS chỉ mở hộp Face ID khi còn "cử chỉ chạm"; sau khi chờ mạng (lấy challenge) cử chỉ hết hạn nên lệnh bị bỏ qua
   * và người dùng thấy "bấm không có gì xảy ra". Hết cử chỉ thì hiện nút để chạm lại ngay trước khi gọi WebAuthn.
   */
  function webauthn(kind, args) {
    const call = () => navigator.credentials[kind](args);
    if (!navigator.userActivation || navigator.userActivation.isActive) return call();
    return new Promise((resolve, reject) => {
      const m = modal(`<div class="ctl-body"><h3>Xác nhận vân tay / Face ID</h3><p class="muted">Bấm nút bên dưới rồi xác nhận trên điện thoại.</p>
        <div class="row"><button class="primary" data-a="go">Xác nhận bằng vân tay / Face ID</button><button class="fit" data-a="x">Huỷ</button></div></div>`);
      const end = (fn, v) => { m.close(); fn(v); };
      m.q('[data-a="go"]').onclick = () => { call().then((c) => end(resolve, c), (e) => end(reject, e)); };
      m.q('[data-a="x"]').onclick = () => end(reject, new DOMException('cancelled', 'NotAllowedError'));
    });
  }

  async function passkeyRegister(name) {
    dbg('register.start', 'Bắt đầu đăng ký Passkey/Face ID', { name });
    // Thiết bị không có sinh trắc: không gọi WebAuthn (Windows/Chrome sẽ mở cửa sổ "không hỗ trợ" rồi quay về vô nghĩa).
    if (!passkeySupported() || !(await platformAuthenticator())) return { ok: false, error: 'platform_unavailable' };
    const sheet = bioSheet({ title: `Bật đăng nhập bằng ${bioName()}`, hint: `Chạm Tiếp tục, rồi xác nhận ${bioName()} khi máy hỏi.` });
    const o = await api('POST', '/api/webauthn/register/options', {});
    if (!o.ok) {
      dbg('register.options_fail', o.body?.error || 'options failed', o.body, 'error');
      sheet.close();
      return o.body;
    }
    dbg('register.options_ok', 'Đã nhận challenge — chờ Face ID / vân tay', { rpId: o.body?.rp?.id || o.body?.rpId });
    let cred;
    try {
      const opts = o.body;
      const args = {
        publicKey: {
          ...opts,
          challenge: b64uToBuf(opts.challenge),
          user: { ...opts.user, id: b64uToBuf(opts.user.id) },
          hints: ['client-device'],
          excludeCredentials: (opts.excludeCredentials || []).map((c) => ({ ...c, id: b64uToBuf(c.id) })),
        },
      };
      cred = await sheet.waitTap(() => navigator.credentials.create(args));
    } catch (e) {
      dbg('register.gesture_fail', e?.name || 'create failed', { name: e?.name, message: e?.message }, 'error');
      if (e?.message === 'cancelled') { sheet.close(); throw e; }
      const iosHint = isApple() ? ' Nếu iPhone báo không hỗ trợ passkey: vào Cài đặt > tên của bạn > iCloud > Mật khẩu và Khoá, bật đồng bộ.' : '';
      sheet.fail((e?.name === 'NotAllowedError' ? `Chưa xác nhận được ${bioName()}. Hãy thử lại.` : `Không bật được (${e?.name || 'lỗi'}).`) + iosHint);
      throw e;
    }
    dbg('register.gesture_ok', 'Thiết bị đã tạo credential', { credId: String(cred?.id || '').slice(0, 16) }, 'ok');
    sheet.status('Đang lưu…');
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
      sheet.ok(`Đã bật đăng nhập bằng ${bioName()}`);
      await new Promise((resolve) => setTimeout(resolve, 900));
      sheet.close();
      if (r.body.recoveryCodes?.length) await showRecoveryCodes(r.body.recoveryCodes);
    } else {
      dbg('register.verify_fail', r.body?.error || 'verify failed', r.body, 'error');
      sheet.fail(errText(r.body?.error));
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
      cred = await webauthn('get', {
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
    // Máy hỗ trợ sinh trắc (canPk đã gồm kiểm tra cảm biến) thì BẮT BUỘC bật Face ID / vân tay; mật khẩu, email chỉ là thêm.
    // Lối thoát duy nhất: bật không được (iCloud Keychain tắt, trình duyệt lỗi…) thì chọn "dùng mật khẩu thay thế" (ghi nhận).
    const bioRequired = Boolean(canPk) && !opts.recovery;
    let optOut = false;
    let setPw = '';
    body.innerHTML = `
      <h3>${opts.recovery ? 'Đặt lại thông tin đăng nhập' : 'Thiết lập đăng nhập'}</h3>
      <p class="muted">${opts.recovery ? 'Khôi phục thành công. Đặt mật khẩu mới và/hoặc email nếu muốn. Muốn bật lại vân tay / Face ID và điều khiển thiết bị, hãy làm trong Cài đặt (cần xác nhận thêm vì lý do an toàn).' : bioRequired ? `Máy của bạn hỗ trợ <b>${bioName()}</b> nên bước này là <b>bắt buộc</b>. Mật khẩu và email là tuỳ chọn thêm.` : 'Máy này không có Face ID / vân tay nên hãy chọn <b>mật khẩu</b> (bắt buộc). Email là tuỳ chọn.'}</p>
      <div class="ctl-err" style="color:var(--bad)"></div><div class="ctl-ok" style="color:var(--ok,#16a34a)"></div>
      ${opts.recovery ? '' : canPk ? `<div class="row"><button class="primary" data-a="pk">${bioRequired ? `Bắt buộc: bật ${bioName()}` : 'Bật vân tay / Face ID'}</button></div><div class="row su-nobio" hidden><button class="fit" data-a="nobio">Không bật được ${bioName()}? Dùng mật khẩu thay thế</button></div>` : '<p class="muted">Máy này không có vân tay / Face ID.</p>'}
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
      const ready = opts.recovery || (bioRequired && !optOut ? hasPk : (hasPw || hasPk));
      m.q('[data-a="go"]').disabled = !ready;
      m.q('[data-a="go"]').title = ready ? '' : (bioRequired && !optOut ? `Cần bật ${bioName()} trước` : 'Chọn ít nhất một cách: vân tay / Face ID hoặc mật khẩu');
    };
    refresh();
    const click = async (a, b) => {
      err('');
      if (a === 'x') return done(false);
      if (a === 'go') return done(opts.recovery ? true : hasPk ? true : { basic: true, password: setPw, bioCapable: bioRequired, bioOptOut: optOut });
      if (a === 'nobio') {
        optOut = true; m.q('.su-nobio').hidden = true; m.q('[data-a="pk"]').textContent = `Thử lại bật ${bioName()}`;
        return ok('Đã chuyển sang dùng mật khẩu thay thế: hãy đặt mật khẩu rồi bấm Hoàn tất.'), refresh();
      }
      b.disabled = true;
      try {
        if (a === 'pk') {
          if (await passkeyEnrollFlow(m)) { hasPk = true; b.textContent = '✓ Đã bật vân tay / Face ID'; ok('Đã bật vân tay / Face ID.'); } else {
            if (m.lastErr) err(errText(m.lastErr));
            if (bioRequired && !optOut) m.q('.su-nobio').hidden = false;
          }
        } else if (a === 'pw') {
          const p1 = m.q('.su-pw').value; const p2 = m.q('.su-pw2').value;
          if (p1.length < 8) return err(errText('password_weak'));
          if (p1 !== p2) return err('Hai mật khẩu không khớp.');
          const r = await api('POST', '/api/account/password', { password: p1 });
          if (r.ok) { hasPw = true; setPw = p1; if (pendingSession) pendingSession.methods = { ...(pendingSession.methods || {}), password: true }; b.textContent = '✓ Đã đặt mật khẩu'; ok('Đã đặt mật khẩu.'); } else err(errText(r.body.error));
        } else if (a === 'mail') {
          const r = await api('POST', '/api/account/email/request', { email: m.q('.su-mail').value.trim() });
          if (r.ok && r.body.saved) ok('Đã lưu email. Sẽ xác minh khi hệ thống hỗ trợ gửi email.');
          else if (r.ok) { m.q('.su-mailcode').hidden = false; ok('Đã gửi mã tới email. Nhập mã để xác minh.'); } else err(errText(r.body.error));
        } else if (a === 'mailok') {
          const r = await api('POST', '/api/account/email/verify', { otp: m.q('.su-code').value.trim() });
          if (r.ok) { m.q('.su-mailcode').hidden = true; ok('Đã xác minh email (dùng để khôi phục sau 72 giờ).'); } else err(errText(r.body.error));
        }
      } finally { b.disabled = false; refresh(); }
    };
    body.querySelectorAll('button[data-a]').forEach((b) => { b.onclick = () => click(b.dataset.a, b); });
  }

  /** Mở khoá lại ứng dụng (đã khoá do nền/nhàn rỗi) cho tài khoản chỉ có mật khẩu. */
  function passwordPrompt(m, done, title = 'Mở khoá ứng dụng') {
    const body = m.q('.ctl-body');
    body.innerHTML = `
      <h3>${escHtml(title)}</h3>
      <p class="muted">Bước 2/2: nhập mật khẩu của bạn (OTP đã xác nhận).</p>
      <div class="ctl-err" style="color:var(--bad)"></div>
      <label>Mật khẩu<input type="password" class="pp-pw" autocomplete="current-password" placeholder="Mật khẩu"></label>
      <div class="row"><button class="primary pp-go">Mở khoá</button><button class="fit pp-x">Huỷ</button></div>`;
    const go = () => { const v = m.q('.pp-pw').value; if (!v) { m.q('.ctl-err').textContent = errText('password_invalid'); return; } done({ basic: true, password: v }); };
    m.q('.pp-go').onclick = go;
    m.q('.pp-pw').onkeydown = (e) => { if (e.key === 'Enter') go(); };
    m.q('.pp-x').onclick = () => done(false);
    setTimeout(() => m.q('.pp-pw')?.focus(), 50);
  }

  /** Phiên quá 10 phút mà chưa có yếu tố nào: xác nhận lại bằng mật khẩu hoặc OTP Telegram ngay tại chỗ, không phải đăng xuất. */
  async function reauthModal() {
    const sec = await api('GET', '/api/account/security');
    const hasPw = Boolean(sec.body?.hasPassword);
    return new Promise((resolve) => {
      const m = modal(`<div class="ctl-body">
        <h3>Xác nhận lại để tiếp tục</h3>
        <p class="muted">Để bảo mật, việc bật vân tay / Face ID cần bạn vừa xác nhận gần đây.</p>
        <div class="ctl-err" style="color:var(--bad)"></div>
        ${hasPw ? '<label>Mật khẩu<input type="password" class="ra-pw" autocomplete="current-password"></label><div class="row"><button class="primary" data-a="pw">Xác nhận bằng mật khẩu</button></div>' : ''}
        <div class="row"><button class="fit" data-a="send">Gửi OTP Telegram</button></div>
        <label class="ra-otp-row" hidden>Mã OTP<input class="ra-otp" inputmode="numeric" maxlength="6" autocomplete="one-time-code" placeholder="000000"></label>
        <div class="row"><button class="primary ra-otp-go" data-a="otp" hidden>Xác nhận OTP</button><button class="fit" data-a="x">Huỷ</button></div></div>`);
      const err = (t) => { m.q('.ctl-err').textContent = t || ''; };
      const finish = (token) => {
        const s = LS.get('session', null);
        if (token && s) LS.set('session', { ...s, token });
        m.close(); resolve(Boolean(token));
      };
      m.q('.ctl-body').querySelectorAll('button[data-a]').forEach((b) => {
        b.onclick = async () => {
          const a = b.dataset.a;
          err('');
          if (a === 'x') return finish(null);
          if (a === 'send') {
            const phone = String(session()?.username || '');
            const r = await fetch(location.origin + '/api/login/request-otp', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Device-Id': devId() }, body: JSON.stringify({ phone }) }).then((x) => x.json()).catch(() => ({ error: 'offline' }));
            if (r.error) return err(errText(r.error));
            m.q('.ra-otp-row').hidden = false; m.q('.ra-otp-go').hidden = false; m.q('.ra-otp').focus();
            return;
          }
          const body = a === 'pw' ? { password: m.q('.ra-pw').value } : { otp: m.q('.ra-otp').value.trim() };
          const r = await api('POST', '/api/account/reauth', body);
          if (r.ok && r.body.token) return finish(r.body.token);
          err(errText(r.body.error));
        };
      });
    });
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
          if (methods.password) passwordPrompt(m, done, pendingSession.src === 'resume' ? 'Mở khoá ứng dụng' : 'Nhập mật khẩu để hoàn tất đăng nhập'); else loginSetup(m, canPk && canPlatform, done);
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
          ${pendingSession && methods.password ? '<label>Hoặc nhập mật khẩu<input type="password" class="ctl-pw" autocomplete="current-password" placeholder="Mật khẩu"></label><div class="row"><button class="fit ctl-pwgo">Xác nhận bằng mật khẩu</button></div>' : ''}
          <div class="row"><button class="fit ctl-newdev">Máy mới / mất máy cũ?</button><button class="fit ctl-cancel">Huỷ</button></div>`;
        const pwgo = m.q('.ctl-pwgo');
        if (pwgo) pwgo.onclick = () => { const v = m.q('.ctl-pw').value; if (!v) { err('Nhập mật khẩu.'); return; } done({ basic: true, password: v }); };
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
          // Chỉ có passkey: bật luôn hộp sinh trắc. Máy không có Face ID/vân tay/Windows Hello thì KHÔNG tự bật (sẽ ra cửa sổ
          // hệ thống "không hỗ trợ"); người dùng vẫn bấm nút nếu muốn dùng điện thoại khác qua mã QR.
          if (!methods.totp && canPlatform) run();
          else if (!methods.totp) err('Máy này không có Face ID / vân tay / Windows Hello. Bấm nút để dùng điện thoại khác (mã QR), hoặc "Máy mới / mất máy cũ?".');
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
  async function loginWithPasskey(password) {
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
      cred = await webauthn('get', {
        publicKey: { ...o.body, challenge: b64uToBuf(o.body.challenge), allowCredentials: [], hints: ['client-device'] },
      });
    } catch (e) {
      dbg('login.gesture_fail', e?.name || 'get failed', { name: e?.name, message: e?.message }, 'error');
      throw e;
    }
    dbg('login.gesture_ok', 'Face ID / vân tay OK', { credId: String(cred?.id || '').slice(0, 16) }, 'ok');
    const r = await post('/api/login/passkey/verify', {
      cid: o.body.cid,
      ...(password ? { password } : {}),
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
    const cred = await webauthn('get', { publicKey: { ...o, challenge: b64uToBuf(o.challenge), allowCredentials: [], hints: ['client-device'] } });
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

  /** Bật vân tay / Face ID ngay trên máy này (dùng sau khi vừa đăng nhập): hộp sinh trắc của chính thiết bị, không phải mã QR. */
  /** Đường dẫn mở thẳng Cài đặt (chỉ Android / Windows cho phép trang web làm việc này; iPhone thì không). */
  function settingsLink() {
    const ua = navigator.userAgent;
    if (/Android/.test(ua)) return { href: 'intent:#Intent;action=android.settings.SECURITY_SETTINGS;end', text: 'Mở Cài đặt bảo mật' };
    if (/Windows/.test(ua)) return { href: 'ms-settings:signinoptions', text: 'Mở Cài đặt Windows Hello' };
    return null;
  }

  /** Hướng dẫn từng bước bật Face ID / vân tay trong Cài đặt của máy. Trả khi người dùng bấm "Đã bật, thử lại" (true) hoặc "Đóng" (false). */
  function bioGuide() {
    const ua = navigator.userAgent;
    const bio = bioName();
    let steps;
    if (/iPhone|iPad/.test(ua)) {
      steps = [
        `Mở <b>Cài đặt</b>, chọn <b>${bio === 'Touch ID' ? 'Touch ID & Mật mã' : 'Face ID & Mật mã'}</b>, nhập mật mã. Bảo đảm đã thiết lập ${bio} và bật <b>Mật khẩu tự động điền</b>.`,
        'Mở <b>Cài đặt, [tên bạn], iCloud, Mật khẩu và Chuỗi khoá</b>, bật <b>Đồng bộ máy này</b>.',
        'Mở <b>Cài đặt, Mật khẩu, Tuỳ chọn mật khẩu</b> (Password Options). Bật <b>Tự động điền mật khẩu và passkey</b>, chỉ chọn <b>Mật khẩu</b>; <b>tắt Authenticator</b> và các app khác nếu có.',
        'Dùng <b>Safari</b> hoặc <b>Chrome</b> (không dùng trình duyệt trong Telegram / Zalo), đóng hẳn rồi mở lại trang này.',
      ];
    } else if (/Android/.test(ua)) {
      steps = [
        'Mở <b>Cài đặt, Bảo mật (hoặc Sinh trắc học)</b>, thiết lập <b>khoá màn hình</b> và đăng ký <b>vân tay / khuôn mặt</b> nếu chưa có.',
        'Mở <b>Cài đặt, Mật khẩu, passkey và tài khoản</b>, đặt <b>Dịch vụ ưu tiên</b> là <b>Trình quản lý mật khẩu của Google</b>; tắt Authenticator và các dịch vụ khác.',
        'Dùng <b>Chrome</b>, đóng hẳn rồi mở lại trang này.',
      ];
    } else if (/Windows/.test(ua)) {
      steps = [
        'Mở <b>Cài đặt, Tài khoản, Tuỳ chọn đăng nhập</b>.',
        'Thiết lập <b>Windows Hello</b> (khuôn mặt, vân tay hoặc mã PIN) rồi quay lại trang này.',
      ];
    } else {
      steps = ['Bật khoá màn hình và vân tay / khuôn mặt trong Cài đặt bảo mật của thiết bị, rồi quay lại thử lại.'];
    }
    const link = settingsLink();
    return new Promise((resolve) => {
      const m = modal(`<div class="ctl-body"><h3>Cách bật ${escHtml(bio)}</h3>
        <ol class="muted" style="padding-left:20px;line-height:1.5">${steps.map((t) => `<li style="margin-bottom:8px">${t}</li>`).join('')}</ol>
        ${link ? '' : '<p class="muted">Trang web không mở được Cài đặt của iPhone; hãy làm theo các bước trên rồi quay lại đây.</p>'}
        <div class="row" style="flex-direction:column">
          ${link ? `<button class="fit" data-a="open">${escHtml(link.text)}</button>` : ''}
          <button class="primary" data-a="retry">Đã bật, thử lại</button><button class="fit" data-a="x">Đóng</button></div></div>`);
      m.q('[data-a="open"]')?.addEventListener('click', () => { location.href = link.href; });
      m.q('[data-a="retry"]').onclick = () => { m.close(); resolve(true); };
      m.q('[data-a="x"]').onclick = () => { m.close(); resolve(false); };
    });
  }

  /** Hộp thông báo ngắn có nút "Đã hiểu". */
  function notice(title, text) {
    return new Promise((resolve) => {
      const m = modal(`<div class="ctl-body"><h3>${escHtml(title)}</h3><p class="muted">${escHtml(text)}</p>
        <div class="row"><button class="primary" data-a="ok">Đã hiểu</button></div></div>`);
      m.q('[data-a="ok"]').onclick = () => { m.close(); resolve(); };
    });
  }

  async function enrollPasskeyNow() {
    if (!passkeySupported() || !(await platformAuthenticator())) {
      if (await bioGuide()) return enrollPasskeyNow();
      return false;
    }
    const name = `${/iPhone|iPad/.test(navigator.userAgent) ? 'iPhone' : /Android/.test(navigator.userAgent) ? 'Android' : 'Máy tính'} ${new Date().toLocaleDateString('vi-VN')}`;
    let r = await passkeyRegister(name);
    if (r.error === 'reauth_required' && await reauthModal()) r = await passkeyRegister(name);
    if (!r.ok && r.error && r.error !== 'reauth_required') {
      await notice('Chưa bật được vân tay / Face ID', errText(r.error));
      if (await bioGuide()) return enrollPasskeyNow();
    }
    return Boolean(r.ok);
  }

  /* =================== Quy trình 3 bước (docs/LOGIN_FLOW.md) =================== */
  const pwWeak = (pw) => pw.length < 8;

  /** Bước 2 (đăng nhập): xác thực khoá đã đăng ký bằng hộp Face ID / vân tay. Trả { ok } hoặc { error }. */
  async function bioLoginStep() {
    const sheet = bioSheet({ title: `Đăng nhập bằng ${bioName()}`, hint: `Chạm Tiếp tục, rồi xác nhận ${bioName()} khi máy hỏi.` });
    try {
      const o = await api('POST', '/api/webauthn/auth/options', {});
      if (!o.ok) { sheet.close(); return { error: o.body.error }; }
      const opts = o.body;
      const cred = await sheet.waitTap(() => navigator.credentials.get({
        publicKey: { ...opts, challenge: b64uToBuf(opts.challenge), allowCredentials: (opts.allowCredentials || []).map((c) => ({ ...c, id: b64uToBuf(c.id) })) },
      }));
      sheet.status('Đang xác nhận…');
      const r = await api('POST', '/api/webauthn/auth/verify', {
        credential: { id: cred.id, response: { clientDataJSON: bufToB64u(cred.response.clientDataJSON), authenticatorData: bufToB64u(cred.response.authenticatorData), signature: bufToB64u(cred.response.signature) } },
      });
      if (!r.ok) { sheet.fail(errText(r.body.error)); return { error: r.body.error }; }
      saveToken(r.body);
      sheet.ok(`Đã xác nhận ${bioName()}`);
      await new Promise((resolve) => setTimeout(resolve, 700));
      sheet.close();
      return { ok: true };
    } catch (e) {
      if (e?.message === 'cancelled') { sheet.close(); return { error: 'cancelled' }; }
      sheet.fail(e?.name === 'NotAllowedError' ? `Chưa xác nhận được ${bioName()}. Hãy thử lại.` : `Không xác nhận được (${e?.name || 'lỗi'}).`);
      return { error: 'webauthn_failed' };
    }
  }

  /** Khung hộp thoại cho các bước có nhập liệu. Trả { m, body, err, done }. */
  function stepBox(title, sub) {
    const m = modal(`<div class="ctl-body"><h3>${escHtml(title)}</h3><p class="muted">${escHtml(sub)}</p><div class="ctl-err" style="color:var(--bad)"></div><div class="su-body"></div></div>`);
    return { m, body: m.q('.su-body'), err: (t) => { m.q('.ctl-err').textContent = t || ''; } };
  }

  /** Bước 3: tạo mật khẩu (nhập + nhập lại), gửi lên server. Trả mật khẩu đã đặt hoặc null nếu huỷ. */
  function passwordSetStep(stepLabel) {
    return new Promise((resolve) => {
      const box = stepBox(`${stepLabel}: tạo mật khẩu`, 'Tài khoản chưa có mật khẩu. Nhập mật khẩu (từ 8 ký tự, không chứa số điện thoại) và nhập lại.');
      box.body.innerHTML = `<label>Mật khẩu<input type="password" class="sp-1" autocomplete="new-password"></label>
        <label>Nhập lại mật khẩu<input type="password" class="sp-2" autocomplete="new-password"></label>
        <div class="row"><button class="primary sp-go">Lưu mật khẩu</button><button class="fit sp-x">Huỷ</button></div>`;
      const go = box.body.querySelector('.sp-go');
      const submit = async () => {
        const p1 = box.body.querySelector('.sp-1').value; const p2 = box.body.querySelector('.sp-2').value;
        if (pwWeak(p1)) return box.err(errText('password_weak'));
        if (p1 !== p2) return box.err('Hai mật khẩu không khớp.');
        go.disabled = true; box.err('');
        const r = await api('POST', '/api/account/password', { password: p1 });
        go.disabled = false;
        if (!r.ok) return box.err(errText(r.body.error));
        box.m.close(); resolve(p1);
      };
      go.onclick = submit;
      box.body.querySelector('.sp-2').onkeydown = (e) => { if (e.key === 'Enter') submit(); };
      box.body.querySelector('.sp-x').onclick = () => { box.m.close(); resolve(null); };
      setTimeout(() => box.body.querySelector('.sp-1')?.focus(), 50);
    });
  }

  /** Bước 3: nhập mật khẩu đã đăng ký và hoàn tất (thử lại được khi sai, không mất OTP). Trả payload đăng nhập hoặc null. */
  function passwordEnterStep(stepLabel, extra = {}) {
    return new Promise((resolve) => {
      const box = stepBox(`${stepLabel}: nhập mật khẩu`, pendingSession?.src === 'resume' ? 'Nhập mật khẩu để mở khoá ứng dụng.' : 'Nhập mật khẩu của tài khoản để vào ứng dụng.');
      box.body.innerHTML = `<label>Mật khẩu<input type="password" class="sp-1" autocomplete="current-password"></label>
        <div class="row"><button class="primary sp-go">Vào ứng dụng</button><button class="fit sp-x">Huỷ</button></div>`;
      const go = box.body.querySelector('.sp-go');
      const submit = async () => {
        const pw = box.body.querySelector('.sp-1').value;
        if (!pw) return box.err('Nhập mật khẩu.');
        go.disabled = true; box.err('');
        const r = await api('POST', '/api/login/complete-basic', { password: pw, ...extra });
        go.disabled = false;
        if (!r.ok) return box.err(errText(r.body.error));
        box.m.close(); resolve(r.body);
      };
      go.onclick = submit;
      box.body.querySelector('.sp-1').onkeydown = (e) => { if (e.key === 'Enter') submit(); };
      box.body.querySelector('.sp-x').onclick = () => { box.m.close(); resolve(null); };
      setTimeout(() => box.body.querySelector('.sp-1')?.focus(), 50);
    });
  }

  /** Bước 2 (đăng ký): bắt buộc bật sinh trắc. Lối thoát duy nhất khi thất bại: dùng mật khẩu thay thế. Trả 'ok' | 'optout' | 'cancel'. */
  async function bioRegisterStep(strict = false) {
    for (;;) {
      let r;
      try { r = await passkeyRegister(`${/iPhone|iPad/.test(navigator.userAgent) ? 'iPhone' : /Android/.test(navigator.userAgent) ? 'Android' : 'Máy tính'} ${new Date().toLocaleDateString('vi-VN')}`); } catch (e) { r = { ok: false, error: e?.message === 'cancelled' ? 'cancelled' : 'webauthn_failed' }; }
      if (r.ok) return 'ok';
      if (r.error === 'reauth_required' && await reauthModal()) continue;
      // Hộp Face ID còn mở ở trạng thái lỗi: lấy lý do rồi đóng để chỉ còn một hộp lựa chọn
      const why = document.querySelector('.bio-sheet .bio-msg')?.textContent || '';
      document.querySelectorAll('.bio-sheet').forEach((el) => el.closest('.ctl-modal')?.remove());
      const choice = await new Promise((resolve) => {
        const box = stepBox(`Chưa bật được ${bioName()}`, `Máy của bạn hỗ trợ ${bioName()} nên bước này là bắt buộc${strict ? ' để hoàn tất tài khoản mới' : ''}.`);
        box.err(why || (r.error && r.error !== 'cancelled' ? errText(r.error) : ''));
        // Tài khoản mới: phải đăng ký đủ, không có lối thoát (chỉ thử lại hoặc huỷ). Tài khoản cũ vẫn có "dùng mật khẩu thay thế".
        box.body.innerHTML = `<div class="row" style="flex-direction:column"><button class="primary sp-retry">Thử lại bật ${escHtml(bioName())}</button>
          <button class="fit sp-guide">Hướng dẫn bật ${escHtml(bioName())} trong Cài đặt</button>
          ${strict ? '' : '<button class="fit sp-alt">Không bật được? Dùng mật khẩu thay thế</button>'}<button class="fit sp-x">Huỷ đăng nhập</button></div>`;
        box.body.querySelector('.sp-retry').onclick = () => { box.m.close(); resolve('retry'); };
        box.body.querySelector('.sp-guide').onclick = async () => { box.m.close(); resolve(await bioGuide() ? 'retry' : 'again'); };
        box.body.querySelector('.sp-alt')?.addEventListener('click', () => { box.m.close(); resolve('optout'); });
        box.body.querySelector('.sp-x').onclick = () => { box.m.close(); resolve('cancel'); };
      });
      if (choice === 'retry') continue;
      if (choice === 'again') { r = null; continue; }
      return choice;
    }
  }

  /**
   * Sau khi xác nhận OTP (hoặc mở khoá lại): bước 2 sinh trắc, bước 3 mật khẩu. Trả payload đăng nhập hoặc null (huỷ).
   *   bước 2: máy hỗ trợ sinh trắc: đã đăng ký thì đăng nhập, chưa thì bắt buộc đăng ký (public key lên server);
   *   bước 3: server chưa có mật khẩu thì tạo mới; đã có mà chưa dùng sinh trắc thì nhập mật khẩu.
   */
  async function loginStepper(data) {
    const bio = await bioInfo();
    const resume = data.src === 'resume';
    const methods = data.methods || {};
    let usedBio = false;
    let optOut = false;
    if (bio.supported && (methods.passkey || !resume)) {
      if (methods.passkey) {
        for (;;) {
          const r = await bioLoginStep();
          if (r.ok) { usedBio = true; break; }
          if (r.error === 'cancelled') return null;
          if (!(await confirmStep(`Chưa xác nhận được ${bioName()}`, 'Thử lại, hoặc huỷ đăng nhập.', 'Thử lại'))) return null;
        }
      } else {
        const r = await bioRegisterStep(Boolean(data.isNew));
        if (r === 'cancel') return null;
        usedBio = r === 'ok';
        optOut = r === 'optout';
      }
    }
    // Tài khoản mới: ngay trước bước mật khẩu có bước email khôi phục (tuỳ chọn, bấm Tiếp tục để bỏ qua không cần nhập)
    if (data.isNew) await emailOptionalStep();
    const stepNo = bio.supported && !optOut ? 'Bước 3/3' : 'Bước 2/2';
    let password = null;
    if (!methods.password) {
      password = await passwordSetStep(stepNo);
      if (!password) return null;
    } else if (!usedBio) {
      return passwordEnterStep(stepNo, bio.supported && !resume ? { bioCapable: true, bioOptOut: true } : {});
    }
    if (usedBio) {
      const done = await api('POST', '/api/login/complete', {});
      if (!done.ok) throw new Error(errText(done.body.error));
      return done.body;
    }
    // Vừa đặt mật khẩu mới (không dùng sinh trắc): hoàn tất bằng chính mật khẩu đó
    const done = await api('POST', '/api/login/complete-basic', { password, ...(bio.supported && !resume ? { bioCapable: true, bioOptOut: true } : {}) });
    if (!done.ok) throw new Error(errText(done.body.error));
    return done.body;
  }

  /** Tuỳ chọn cho tài khoản mới: nhập email khôi phục (gửi mã xác minh). Bỏ qua được; lỗi gửi (vd. server chưa bật email) cũng không chặn đăng ký. */
  function emailOptionalStep() {
    return new Promise((resolve) => {
      const box = stepBox('Email khôi phục (tuỳ chọn)', 'Thêm email để nhận mã khôi phục khi mất Telegram. Không bắt buộc, có thể bỏ qua và thêm sau trong Cài đặt.');
      box.body.innerHTML = `<label>Email<input type="email" class="se-mail" autocomplete="email" placeholder="ban@example.com"></label>
        <div class="se-codebox" hidden><p class="muted">Đã gửi mã tới email. Nhập mã rồi bấm Xác nhận mã, hoặc Bỏ qua.</p><label>Mã gửi tới email<input class="se-code" inputmode="numeric" maxlength="6" autocomplete="one-time-code" placeholder="000000"></label></div>
        <div class="row"><button class="primary se-send">Tiếp tục</button><button class="fit se-skip">Bỏ qua</button></div>`;
      const send = box.body.querySelector('.se-send');
      let sent = false;
      send.onclick = async () => {
        box.err('');
        if (!sent) {
          const email = box.body.querySelector('.se-mail').value.trim();
          if (!email) { box.m.close(); resolve(false); return; } // để trống: sang bước tiếp theo
          send.disabled = true;
          const r = await api('POST', '/api/account/email/request', { email });
          send.disabled = false;
          if (!r.ok) return box.err(errText(r.body.error));
          if (r.body.saved) { // máy chủ chưa bật gửi email: đã ghi nhận, xác minh sau
            box.body.innerHTML = '<p class="muted">Đã lưu email. Hệ thống sẽ xác minh khi hỗ trợ gửi email; bạn không cần làm gì thêm.</p><div class="row"><button class="primary se-ok">Tiếp tục</button></div>';
            box.body.querySelector('.se-ok').onclick = () => { box.m.close(); resolve(true); };
            return;
          }
          sent = true; box.body.querySelector('.se-codebox').hidden = false; send.textContent = 'Xác nhận mã';
          box.body.querySelector('.se-code').focus();
          return;
        }
        send.disabled = true;
        const r = await api('POST', '/api/account/email/verify', { otp: box.body.querySelector('.se-code').value.trim() });
        send.disabled = false;
        if (!r.ok) return box.err(errText(r.body.error));
        box.m.close(); resolve(true);
      };
      box.body.querySelector('.se-skip').onclick = () => { box.m.close(); resolve(false); };
      setTimeout(() => box.body.querySelector('.se-mail')?.focus(), 50);
    });
  }

  /** Hộp xác nhận có/không. */
  function confirmStep(title, text, yes) {
    return new Promise((resolve) => {
      const box = stepBox(title, text);
      box.body.innerHTML = `<div class="row"><button class="primary sp-y">${escHtml(yes)}</button><button class="fit sp-n">Huỷ</button></div>`;
      box.body.querySelector('.sp-y').onclick = () => { box.m.close(); resolve(true); };
      box.body.querySelector('.sp-n').onclick = () => { box.m.close(); resolve(false); };
    });
  }

  /** Đăng nhập sinh trắc trên máy tin cậy xong mà tài khoản chưa có mật khẩu: tạo mật khẩu rồi hoàn tất. */
  async function completeNeedPassword(data) {
    pendingSession = { token: data.token, userId: data.userId, apiBase: location.origin, src: data.src, methods: data.methods };
    try {
      const password = await passwordSetStep('Bước 3/3');
      if (!password) return null;
      const done = await api('POST', '/api/login/complete-basic', { password });
      if (!done.ok) throw new Error(errText(done.body.error));
      return done.body;
    } finally { pendingSession = null; }
  }

  /** Máy tin cậy hỗ trợ sinh trắc nhưng tài khoản chưa có khoá: sau khi nhập mật khẩu, bắt buộc đăng ký sinh trắc rồi mới vào. */
  async function enrollMandatory() {
    const r = await bioRegisterStep();
    return r; // 'ok' | 'optout' | 'cancel'
  }

  /** Phát hiện sinh trắc: hỗ trợ không + nhãn hiển thị (Face ID / Touch ID / vân tay / Windows Hello). */
  async function bioInfo() {
    const supported = passkeySupported() && await platformAuthenticator();
    return { supported, label: bioName() };
  }

  async function completeOtp(data) {
    if (!data.pending || !data.token) throw new Error(errText('login_step_up_required'));
    pendingSession = { token: data.token, userId: data.userId, apiBase: location.origin, src: data.src, methods: data.methods };
    if (data.methods?.passkey) LS.set('hasPasskey', true); // khôi phục cờ sau khi người dùng xoá dữ liệu trình duyệt
    LS.del('ctl');
    try {
      return await loginStepper(data);
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
    recoverySetup, passkeyProof, enrollPasskeyNow, enrollMandatory, completeNeedPassword, bioInfo, notice, api, unlock, errText, addErrors, modal, escHtml, LS, loginWithPasskey, offerEnroll, completeOtp, resumeLogin, passkeySupported, platformAvailable: platformAuthenticator,
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
    // Chỉ ẩn khi trình duyệt không có WebAuthn (không HTTPS / WebView cũ). Có WebAuthn mà chưa nhận ra cảm biến vẫn cho bấm thử.
    $('#ctl-pk-add').hidden = !passkeySupported();
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
      msg('Đang chuẩn bị… (xác nhận vân tay / Face ID khi máy hỏi)');
      $('#ctl-msg')?.scrollIntoView?.({ block: 'center', behavior: 'smooth' });
      if (!passkeySupported()) return msg('Trình duyệt này không hỗ trợ vân tay / Face ID (cần HTTPS). Hãy dùng Authenticator.', true);
      try {
        let r = await passkeyRegister('Thiết bị');
        if (r.error === 'reauth_required' && await reauthModal()) r = await passkeyRegister('Thiết bị');
        if (r.error === 'step_up_required' && await unlock({ ...r, methods: (await api('GET', '/api/control/status')).body.methods })) r = await passkeyRegister('Thiết bị');
        msg(r.ok ? 'Đã thêm vân tay / Face ID.' : errText(r.error), !r.ok);
      } catch (e) { msg(e?.name === 'NotAllowedError' ? 'Đã huỷ hoặc máy từ chối. Bấm lại và xác nhận vân tay / Face ID khi máy hỏi.' : `${errText('webauthn_failed')} (${e?.name || 'lỗi'}${e?.message ? `: ${e.message}` : ''})`, true); }
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
