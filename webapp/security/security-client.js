/* GENERATED từ packages/security/client/security-client.js bằng "npm run sync-client". KHÔNG sửa ở đây. */
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
    reauth_required: 'Cần đăng nhập lại (mật khẩu) trước khi thiết lập bảo mật.',
    step_up_required: 'Cần xác thực để điều khiển.',
    webauthn_failed: 'Xác thực vân tay / Face ID không thành công.',
    credential_exists: 'Thiết bị này đã được đăng ký.',
    rate_limited: 'Thao tác quá nhanh, chờ một chút.',
    first_device_required: 'Đây không phải thiết bị đầu tiên. Duyệt từ máy cũ hoặc dùng mã khôi phục.',
    totp_already_enabled: 'Authenticator đã được bật.',
    device_proof_required: 'Không xác minh được khoá của thiết bị này. Hãy dùng đúng trình duyệt đã tạo yêu cầu.',
    recovery_device_required: 'Hãy hoàn tất thiết lập trên trình duyệt đã tạo yêu cầu khôi phục.',
    independent_proof_required: 'Cần máy cũ hoặc mã khôi phục; không thể chỉ chờ để được cấp quyền.',
    notification_required: 'Chưa gửi được cảnh báo bảo mật. Yêu cầu chưa được tự động áp dụng.',
    approval_code_invalid: 'Mã ghép không đúng. Đối chiếu mã đang hiện trên máy mới.',
    secure_context_required: 'Cần HTTPS và trình duyệt hỗ trợ lưu khoá thiết bị.',
    device_storage_unavailable: 'Không lưu được khoá thiết bị. Kiểm tra quyền lưu dữ liệu của trình duyệt.',
    device_revoked: 'Khoá thiết bị đã bị thu hồi.',
    credential_rotation_failed: 'Chưa hoàn tất thu hồi credential cũ. Hãy thử lại sau.',
    account_disabled: 'Tài khoản đã bị khoá. Liên hệ quản trị viên.',
    session_revoked: 'Phiên đăng nhập đã bị thu hồi. Hãy đăng nhập lại.',
    password_invalid: 'Sai mật khẩu hoặc tài khoản chưa đặt mật khẩu.',
    setup_incomplete: 'Tài khoản mới phải đăng ký đủ Face ID / vân tay (nếu máy hỗ trợ) và mật khẩu trước khi vào.',
    biometric_required: 'Máy này hỗ trợ Face ID / vân tay nên phải bật trước khi hoàn tất đăng ký.',
    platform_unavailable: 'Máy này không có Face ID / vân tay / Windows Hello. Dùng mật khẩu hoặc Authenticator.',
    missing_credentials: 'Nhập mật khẩu.',
    password_locked: 'Nhập sai mật khẩu quá nhiều lần. Thử lại sau 15 phút.',
    password_new_device: 'Máy mới chưa tin cậy. Dùng mã khôi phục + mật khẩu (Khôi phục). Face ID máy cũ không mang sang.',
    second_factor_required: 'Máy chưa tin cậy: nhập thêm mật khẩu.',
    password_weak: 'Mật khẩu tối thiểu 8 ký tự.',
    recover_need_two: 'Cần ít nhất 2 yếu tố khác loại: mã khôi phục, mật khẩu, vân tay / Face ID.',
    recover_invalid: 'Thông tin khôi phục không đúng.',
    recover_locked: 'Thử sai quá nhiều lần. Chờ 15 phút rồi thử lại.',
    unauthorized: 'Phiên đăng nhập hết hạn. Hãy đăng nhập lại.',
    forbidden: 'Bạn không có quyền thực hiện thao tác này.',
    server_error: 'Máy chủ gặp lỗi. Thử lại sau ít phút.',
    offline: 'Không kết nối được máy chủ. Kiểm tra mạng rồi thử lại.',
    enroll_required: 'Điều khiển đã bị khoá: hãy bật vân tay / Face ID hoặc Authenticator.',
    totp_not_enabled: 'Chưa bật Authenticator trên tài khoản này.',
    no_passkey: 'Tài khoản này chưa đăng ký vân tay / Face ID.',
    unknown_credential: 'Passkey này chưa được đăng ký cho tài khoản.',
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
    privacy_consent_required: 'Cần đồng ý Thông báo bảo vệ dữ liệu cá nhân.',
    privacy_version_mismatch: 'Thông báo bảo vệ dữ liệu đã cập nhật. Tải lại trang rồi đồng ý phiên bản mới.',
    last_admin: 'Không thể xoá admin cuối cùng của hệ thống.',
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
    try { await window.SecurityDevice?.ready?.(); } catch { /* proof() báo lỗi rõ hơn ở nhánh cần chứng minh */ }
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

  async function passkeyRegister(name, stepLabel) {
    dbg('register.start', 'Bắt đầu đăng ký Passkey/Face ID', { name });
    // Thiết bị không có sinh trắc: không gọi WebAuthn (Windows/Chrome sẽ mở cửa sổ "không hỗ trợ" rồi quay về vô nghĩa).
    if (!passkeySupported() || !(await platformAuthenticator())) return { ok: false, error: 'platform_unavailable' };
    const sheet = bioSheet({ title: `${stepLabel ? `${stepLabel}: ` : ''}Bật đăng nhập bằng ${bioName()}`, hint: `Chạm Tiếp tục, rồi xác nhận ${bioName()} khi máy hỏi.` });
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
      // Trong luồng setup tài khoản mới: gộp mã vào kho lưu cuối (cùng username/mật khẩu), tránh hiện 2 lần.
      if (r.body.recoveryCodes?.length) {
        if (pendingSession?.isNew || ['claim', 'invite', 'bio'].includes(pendingSession?.src)) {
          pendingSession._codes = r.body.recoveryCodes;
        } else await showRecoveryCodes(r.body.recoveryCodes);
      }
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
    if (r.ok) {
      saveToken(r.body);
      if (r.body.recoveryCodes?.length) {
        if (pendingSession?.isNew || ['claim', 'invite', 'bio'].includes(pendingSession?.src)) pendingSession._codes = r.body.recoveryCodes;
        else await showRecoveryCodes(r.body.recoveryCodes);
      }
    }
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

  /**
   * Bắt buộc lưu thông tin đăng nhập (không còn SĐT/email).
   * Hiện username + mật khẩu (nếu vừa tạo) + mã khôi phục; chỉ đóng khi xác nhận đã lưu.
   */
  function showCredentialsVault({ username, password, codes, registered } = {}) {
    const list = Array.isArray(codes) ? codes.filter(Boolean) : [];
    if (!username && !password && !list.length) return Promise.resolve(false);
    return new Promise((resolve) => {
      const codeText = list.join('\n');
      const exportText = [
        'Thông tin đăng nhập plciot (giữ bí mật)',
        username ? `Tên tài khoản: ${username}` : '',
        password ? `Mật khẩu: ${password}` : '',
        list.length ? `Mã khôi phục:\n${codeText}` : '',
        '',
        'Đổi điện thoại: đăng nhập bằng username + mật khẩu (hoặc mã khôi phục). Không quét lại QR tem.',
        'Face ID / vân tay chỉ dùng trên từng máy đã tin cậy.',
      ].filter((line, i, arr) => line !== '' || (arr[i - 1] && arr[i - 1] !== '')).join('\n');
      const m = modal(`
        <h3>${registered ? '✓ Đăng ký thành công — hãy lưu lại ngay' : 'Lưu thông tin đăng nhập'}</h3>
        ${registered ? '<p><b>Bạn cần đúng 3 thứ dưới đây để đăng nhập lại hoặc khôi phục tài khoản khi đổi điện thoại, mất máy hay quên mật khẩu.</b></p>' : ''}
        <p class="muted">Không có SĐT/email để khôi phục. Hãy lưu các mục dưới đây (trình quản lý mật khẩu / in / ảnh). Mật khẩu và mã khôi phục <b>chỉ hiện một lần</b> ở đây — đóng cửa sổ này là không xem lại được.</p>
        ${username ? `<p><b>Tên tài khoản</b></p><pre class="codes">${escHtml(username)}</pre>` : ''}
        ${password ? `<p><b>Mật khẩu</b></p><pre class="codes">${escHtml(password)}</pre>` : ''}
        ${list.length ? `<p><b>Mã khôi phục</b> (mỗi mã dùng một lần; mất máy → chờ 24 giờ)</p><pre class="codes">${escHtml(codeText)}</pre>` : ''}
        <p class="muted">Đổi điện thoại: dùng username + mật khẩu hoặc Khôi phục. <b>Không</b> quét lại QR tem thiết bị.</p>
        <div class="row"><button class="fit ctl-copy">Sao chép tất cả</button><button class="fit ctl-dl">Tải .txt</button></div>
        <label style="display:flex;gap:8px;align-items:center;margin-top:12px"><input type="checkbox" class="ctl-saved"> Tôi đã lưu tên tài khoản${password ? ', mật khẩu' : ''}${list.length ? ' và mã khôi phục' : ''}</label>
        <div class="row"><button class="primary ctl-done" disabled>Xong</button></div>`);
      m.q('.ctl-saved').onchange = (e) => { m.q('.ctl-done').disabled = !e.target.checked; };
      m.q('.ctl-copy').onclick = async () => { try { await navigator.clipboard.writeText(exportText); m.q('.ctl-copy').textContent = 'Đã chép'; } catch {} };
      m.q('.ctl-dl').onclick = () => {
        const a = document.createElement('a');
        a.href = URL.createObjectURL(new Blob([`${exportText}\n`], { type: 'text/plain' }));
        a.download = 'plciot-dang-nhap.txt'; a.click();
      };
      m.q('.ctl-done').onclick = () => { m.close(); resolve(true); };
    });
  }

  /** Hiện mã khôi phục một lần (tương thích chỗ gọi cũ). */
  function showRecoveryCodes(codes) {
    return showCredentialsVault({ codes });
  }


  /**
   * Thiết lập đăng nhập: mật khẩu là bắt buộc (không còn SĐT/email);
   * Face ID / vân tay là tiện ích trên máy này (bắt buộc nếu máy hỗ trợ, trừ khi opt-out).
   */
  function loginSetup(m, canPk, done, opts = {}) {
    const body = m.q('.ctl-body');
    if (opts.recovery) canPk = false;
    let hasPw = Boolean(pendingSession?.methods?.password);
    let hasPk = false;
    const bioRequired = Boolean(canPk) && !opts.recovery;
    let optOut = false;
    let setPw = '';
    body.innerHTML = `
      <h3>${opts.recovery ? 'Đặt lại thông tin đăng nhập' : 'Thiết lập đăng nhập'}</h3>
      <p class="muted">${opts.recovery ? 'Khôi phục thành công. Đặt mật khẩu mới nếu muốn. Face ID / điều khiển: làm lại trong Cài đặt trên máy này.' : bioRequired ? `<b>Mật khẩu bắt buộc</b> (để đổi điện thoại sau này). Máy hỗ trợ <b>${bioName()}</b> — nên bật cho tiện trên máy này.` : '<b>Mật khẩu bắt buộc</b>. Máy này không có Face ID / vân tay.'}</p>
      <div class="ctl-err" style="color:var(--bad)"></div><div class="ctl-ok" style="color:var(--ok,#16a34a)"></div>
      ${opts.recovery ? '' : canPk ? `<div class="row"><button class="fit" data-a="pk">Bật ${bioName()} trên máy này</button></div><div class="row su-nobio" hidden><button class="fit" data-a="nobio">Không bật được ${bioName()}? Tiếp tục với mật khẩu</button></div>` : '<p class="muted">Máy này không có vân tay / Face ID.</p>'}
      <label>Mật khẩu (từ 8 ký tự)<input type="password" class="su-pw" autocomplete="new-password" placeholder="Mật khẩu"></label>
      <label>Nhập lại mật khẩu<input type="password" class="su-pw2" autocomplete="new-password" placeholder="Nhập lại"></label>
      <div class="row"><button class="primary" data-a="pw">Đặt mật khẩu</button></div>
      <div class="row"><button class="primary" data-a="go" disabled>${opts.recovery ? 'Vào ứng dụng' : 'Hoàn tất'}</button>${opts.recovery ? '' : '<button class="fit" data-a="x">Huỷ đăng nhập</button>'}</div>`;
    const err = (t) => { m.q('.ctl-err').textContent = t || ''; if (t) m.q('.ctl-ok').textContent = ''; };
    const ok = (t) => { m.q('.ctl-ok').textContent = t || ''; if (t) m.q('.ctl-err').textContent = ''; };
    const refresh = () => {
      // Mật khẩu bắt buộc; Face ID tiện trên máy này (không chặn Hoàn tất nếu đã có mật khẩu).
      const ready = opts.recovery || hasPw;
      m.q('[data-a="go"]').disabled = !ready;
      m.q('[data-a="go"]').title = ready ? '' : 'Cần đặt mật khẩu';
      if (bioRequired && !hasPk && !optOut) m.q('.su-nobio').hidden = false;
    };
    refresh();
    const click = async (a, b) => {
      err('');
      if (a === 'x') return done(false);
      if (a === 'go') {
        if (opts.recovery) return done(true);
        if (!hasPw) return err('Cần đặt mật khẩu trước.');
        return done(hasPk ? true : { basic: true, password: setPw, bioCapable: Boolean(canPk), bioOptOut: true });
      }
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
      <p class="muted">Nhập mật khẩu tài khoản để mở khoá.</p>
      <div class="ctl-err" style="color:var(--bad)"></div>
      <label>Mật khẩu<input type="password" class="pp-pw" autocomplete="current-password" placeholder="Mật khẩu"></label>
      <div class="row"><button class="primary pp-go">Mở khoá</button><button class="fit pp-x">Huỷ</button></div>`;
    const go = () => { const v = m.q('.pp-pw').value; if (!v) { m.q('.ctl-err').textContent = errText('password_invalid'); return; } done({ basic: true, password: v }); };
    m.q('.pp-go').onclick = go;
    m.q('.pp-pw').onkeydown = (e) => { if (e.key === 'Enter') go(); };
    m.q('.pp-x').onclick = () => done(false);
    setTimeout(() => m.q('.pp-pw')?.focus(), 50);
  }

  /** Phiên quá 10 phút: xác nhận lại bằng mật khẩu (không OTP/Telegram). */
  async function reauthModal() {
    const sec = await api('GET', '/api/account/security');
    const hasPw = Boolean(sec.body?.hasPassword);
    return new Promise((resolve) => {
      const m = modal(`<div class="ctl-body">
        <h3>Xác nhận lại để tiếp tục</h3>
        <p class="muted">Để bảo mật, việc bật vân tay / Face ID cần bạn vừa xác nhận gần đây.</p>
        <div class="ctl-err" style="color:var(--bad)"></div>
        ${hasPw
          ? '<label>Mật khẩu<input type="password" class="ra-pw" autocomplete="current-password"></label><div class="row"><button class="primary" data-a="pw">Xác nhận bằng mật khẩu</button><button class="fit" data-a="x">Huỷ</button></div>'
          : '<p class="muted">Tài khoản chưa có mật khẩu. Đăng xuất rồi đăng nhập lại bằng vân tay / Face ID.</p><div class="row"><button class="fit" data-a="x">Đóng</button></div>'}
        </div>`);
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
          const r = await api('POST', '/api/account/reauth', { password: m.q('.ra-pw').value });
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

  /** Đếm ngược: "2 giờ 05:12" hoặc "05:12" hoặc "Hết hạn". */
  function fmtCountdown(untilMs) {
    const left = Math.max(0, Number(untilMs || 0) - Date.now());
    if (!Number(untilMs)) return '—';
    if (left <= 0) return 'Hết hạn';
    const s = Math.floor(left / 1000);
    const h = Math.floor(s / 3600);
    const m = Math.floor((s % 3600) / 60);
    const sec = s % 60;
    const mm = String(m).padStart(2, '0');
    const ss = String(sec).padStart(2, '0');
    return h > 0 ? `${h} giờ ${mm}:${ss}` : `${mm}:${ss}`;
  }

  /** Gắn interval cập nhật mọi phần tử [data-countdown] trong root; trả hàm dừng. */
  function bindCountdowns(root) {
    const tick = () => {
      if (!root || !document.body.contains(root)) return;
      root.querySelectorAll('[data-countdown]').forEach((el) => {
        const until = Number(el.getAttribute('data-countdown') || 0);
        el.textContent = fmtCountdown(until);
        el.classList.toggle('ctl-cd-done', until > 0 && until <= Date.now());
      });
    };
    tick();
    const id = setInterval(tick, 1000);
    return () => clearInterval(id);
  }

  /**
   * Máy mới (mất máy cũ hoặc đổi máy): xin quyền điều khiển bằng
   *   • duyệt từ máy cũ (ngay)  • mã khôi phục (chờ 24 giờ).
   * Không dùng QR tem thiết bị. Yêu cầu nhớ trong localStorage để quay lại sau cooling.
   */
  async function newDeviceFlow(m, done, canPkPlatform) {
    const body = m.q('.ctl-body');
    const gone = () => !document.body.contains(m.el);
    const fmtT = (ms) => (ms ? new Date(ms).toLocaleString('vi-VN') : '—');
    const ua = /iPhone|iPad/.test(navigator.userAgent) ? 'iPhone' : /Android/.test(navigator.userAgent) ? 'Android' : 'Máy tính';
    const label = `${ua} ${new Date().toLocaleDateString('vi-VN')}`;
    const closeBtn = '<div class="row"><button class="fit ctl-close">Đóng</button></div>';
    let stopCd = () => {};
    const wireClose = () => {
      const b = m.q('.ctl-close');
      if (b) b.onclick = () => { stopCd(); done(false); };
    };
    const poll = (req) => api('POST', `/api/devices/requests/${req.id}/poll`, { pollToken: req.pollToken });

    let req = LS.get('devReq', null);
    if (req && req.userId !== session()?.userId) { LS.del('devReq'); req = null; }
    let st = null;
    if (req) {
      const r = await poll(req);
      if (r.ok && ['pending', 'cooling', 'approved'].includes(r.body.status)) {
        st = r.body;
        if (r.body.approvalCode) req.approvalCode = r.body.approvalCode;
        if (r.body.coolingHours != null) req.coolingHours = r.body.coolingHours;
      } else { LS.del('devReq'); req = null; }
    }
    if (!req) {
      const replaceLost = await new Promise((resolve) => {
        body.innerHTML = `<h3>Thêm thiết bị</h3>
          <p class="muted">Đổi điện thoại: đăng nhập bằng <b>mật khẩu</b> rồi thêm máy này. <b>Không</b> quét lại QR tem phần cứng.</p>
          <label><input type="checkbox" class="ctl-lost"> Máy cũ bị mất: thu hồi Face ID / Authenticator và phiên cũ khi máy mới thiết lập xong</label>
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
      req = {
        id: r.body.id, pollToken: r.body.pollToken, options: r.body.options,
        coolingHours: r.body.coolingHours, userId: session()?.userId,
        approvalCode: r.body.approvalCode, kind: r.body.kind,
      };
      LS.set('devReq', req);
      st = { status: 'pending', expiresAt: Date.now() + 30 * 60_000, approvalCode: r.body.approvalCode };
    }

    let shown = null; let enrolling = false;
    let lastExecuteAt = st?.executeAt || null;
    let lastExpiresAt = st?.expiresAt || null;
    const err = (t) => { const e = m.q('.ctl-err'); if (e) e.textContent = t || ''; };

    function renderPending() {
      stopCd();
      const o = req.options || {};
      const code = req.approvalCode || st?.approvalCode || '——————';
      body.innerHTML = `
        <h3>Đổi máy — chờ duyệt</h3>
        <div class="ctl-notice">Đưa <b>mã ghép</b> cho máy cũ. Trên máy cũ: Cài đặt → Duyệt thiết bị mới → nhập mã → <b>Cho phép</b>.</div>
        <p class="muted" style="margin:8px 0 4px">Mã ghép (máy cũ nhập)</p>
        <div class="ctl-pair-code">${escHtml(code)}</div>
        <p class="ctl-cd-wrap">Yêu cầu hết hạn sau: <b class="ctl-cd" data-countdown="${Number(lastExpiresAt || 0)}">—</b></p>
        <div class="ctl-err" style="color:var(--bad)"></div>
        ${o.device === false ? '<p class="muted">Tài khoản chưa có máy cũ để duyệt — dùng mã khôi phục bên dưới.</p>' : ''}
        ${o.recoveryCode ? `<hr><p class="muted">Không còn máy cũ? Nhập <b>mã khôi phục</b> (chờ khoảng ${req.coolingHours || 24} giờ). Không dùng QR tem.</p>
          <label>Mã khôi phục<input class="ctl-rc" placeholder="XXXX-XXXX-XXXX" autocapitalize="characters" autocomplete="off"></label>
          <div class="row"><button class="fit ctl-rc-go">Dùng mã khôi phục</button></div>` : ''}
        ${!o.recoveryCode && o.device === false ? '<p class="muted">Chưa có mã khôi phục. Hết đường: nhờ quản trị unclaim thiết bị.</p>' : ''}
        ${closeBtn}`;
      wireClose();
      stopCd = bindCountdowns(body);
      const rc = m.q('.ctl-rc-go');
      if (rc) rc.onclick = async () => {
        const r = await api('POST', `/api/devices/requests/${req.id}/recovery`, { code: m.q('.ctl-rc').value.trim() });
        if (!r.ok) return err(errText(r.body.error));
        handle({ ...r.body, status: r.body.status });
      };
    }

    function renderCooling() {
      stopCd();
      body.innerHTML = `
        <h3>Đang chờ cấp quyền</h3>
        <div class="ctl-notice">Đã nhận mã khôi phục. Quyền điều khiển sẽ mở sau thời gian chờ bảo mật. Có thể đóng app và quay lại sau.</div>
        <p class="ctl-cd-wrap">Còn lại: <b class="ctl-cd ctl-cd-lg" data-countdown="${Number(lastExecuteAt || 0)}">—</b></p>
        <p class="muted">Dự kiến: <b>${escHtml(fmtT(lastExecuteAt))}</b></p>
        <p class="muted">Hết giờ, màn hình này tự tiếp tục để bạn bật Face ID / Authenticator.</p>
        <div class="ctl-err" style="color:var(--bad)"></div>
        ${closeBtn}`;
      wireClose();
      stopCd = bindCountdowns(body);
    }

    function handle(b) {
      if (enrolling || gone()) return;
      if (b.approvalCode) req.approvalCode = b.approvalCode;
      if (b.executeAt != null) lastExecuteAt = b.executeAt;
      if (b.expiresAt != null) lastExpiresAt = b.expiresAt;
      if (b.status === 'approved' && b.ticket) {
        stopCd();
        enrolling = true;
        LS.set('enroll', { ticket: b.ticket, exp: Date.now() + (b.ticketExpiresIn || 900) * 1000 });
        LS.del('devReq');
        return enrollChoice(m, canPkPlatform, (v) => {
          LS.del('enroll');
          if (v && req.kind !== 'replace_lost') LS.set('reviewDevices', { userId: session()?.userId });
          done(v);
        }, 'Thiết bị đã được cho phép — bật Face ID / Authenticator');
      }
      if (b.status === 'cooling') {
        if (shown !== 'cooling') { shown = 'cooling'; renderCooling(); }
        else {
          const el = m.q('[data-countdown]');
          if (el && lastExecuteAt) el.setAttribute('data-countdown', String(lastExecuteAt));
        }
        return;
      }
      if (['denied', 'cancelled', 'expired'].includes(b.status)) {
        stopCd();
        LS.del('devReq');
        const why = { denied: 'Máy cũ đã từ chối yêu cầu.', cancelled: 'Yêu cầu đã bị huỷ.', expired: 'Yêu cầu đã hết hạn — hãy tạo lại.' }[b.status];
        body.innerHTML = `<h3>Thêm thiết bị mới</h3><div class="ctl-notice">${why}</div>${closeBtn}`;
        wireClose();
        shown = b.status;
        return;
      }
      if (shown !== 'pending') { shown = 'pending'; renderPending(); }
      else {
        const el = m.q('[data-countdown]');
        if (el && lastExpiresAt) el.setAttribute('data-countdown', String(lastExpiresAt));
        const codeEl = m.q('.ctl-pair-code');
        if (codeEl && req.approvalCode) codeEl.textContent = req.approvalCode;
      }
    }

    handle(st || { status: 'pending' });
    while (!gone() && !enrolling) {
      await new Promise((r) => setTimeout(r, 2000));
      if (gone() || enrolling) break;
      const r = await poll(req);
      if (r.status === 401) {
        stopCd();
        body.innerHTML = `<h3>Phiên hết hạn</h3><p>Đăng nhập lại bằng mật khẩu để tiếp tục yêu cầu đã lưu.</p>${closeBtn}`;
        wireClose();
        break;
      }
      if (r.ok) handle(r.body);
    }
    stopCd();
    return null;
  }

  /** Máy cũ: xem các thiết bị đang xin vào — nhập mã ghép + đếm ngược nếu đang cooling. */
  async function reviewDevices() {
    let r = await api('GET', '/api/devices/requests');
    if (r.status === 401 && r.body.error === 'step_up_required') {
      LS.del('ctl');
      if (!(await unlock(r.body))) return;
      r = await api('GET', '/api/devices/requests');
    }
    if (!r.ok) return;
    let list = r.body.requests || [];
    if (!list.length) {
      const m0 = modal('<h3>Thiết bị mới</h3><p class="muted">Không có yêu cầu nào đang chờ.</p><div class="row"><button class="fit ctl-close">Đóng</button></div>');
      m0.q('.ctl-close').onclick = m0.close;
      return;
    }
    const m = modal('<div class="ctl-body"></div>');
    let stopCd = () => {};
    const draw = () => {
      stopCd();
      if (!list.length) return m.close();
      m.q('.ctl-body').innerHTML = `
        <h3>Thiết bị mới xin vào</h3>
        <div class="ctl-notice">Chỉ <b>Cho phép</b> nếu chính bạn vừa mở máy mới. Nhập <b>mã ghép 6 số</b> đang hiện trên máy mới.</div>
        <div class="ctl-err" style="color:var(--bad)"></div>
        ${list.map((q) => `<div class="pend">
          <b>${escHtml(q.label || 'Thiết bị')}</b>
          ${q.kind === 'replace_lost' ? '<p style="color:var(--bad)">Máy cũ bị mất — Cho phép sẽ thu hồi Face ID / phiên máy này.</p>' : ''}
          <p class="muted">${new Date(q.createdAt).toLocaleString('vi-VN')}${q.ip ? ` · IP ${escHtml(q.ip)}` : ''}</p>
          ${q.status === 'cooling' ? `<p class="ctl-cd-wrap">Đang chờ (mã khôi phục): còn <b data-countdown="${Number(q.executeAt || 0)}">—</b><br><span class="muted">Tự cấp lúc ${new Date(q.executeAt).toLocaleString('vi-VN')} — bạn vẫn có thể <b>Từ chối</b></span></p>` : ''}
          ${q.status === 'pending' && q.expiresAt ? `<p class="ctl-cd-wrap muted">Yêu cầu hết hạn sau: <b data-countdown="${Number(q.expiresAt)}">—</b></p>` : ''}
          ${q.status === 'pending' ? `<label>Mã ghép trên máy mới<input data-code="${q.id}" inputmode="numeric" maxlength="6" autocomplete="one-time-code" placeholder="000000"></label>
          <div class="row"><button class="primary" data-a="approve" data-id="${q.id}">Cho phép</button><button class="danger" data-a="deny" data-id="${q.id}">Từ chối</button></div>`
          : `<div class="row"><button class="danger" data-a="deny" data-id="${q.id}">Từ chối / huỷ chờ</button></div>`}
        </div>`).join('')}
        <div class="row"><button class="fit ctl-close">Đóng</button></div>`;
      m.q('.ctl-close').onclick = () => { stopCd(); m.close(); };
      stopCd = bindCountdowns(m.q('.ctl-body'));
      m.el.querySelectorAll('[data-a]').forEach((b) => {
        b.onclick = async () => {
          const code = m.q(`[data-code="${b.dataset.id}"]`)?.value?.trim() || '';
          if (b.dataset.a === 'approve' && !/^\d{6}$/.test(code)) {
            m.q('.ctl-err').textContent = 'Nhập đủ mã ghép 6 số đang hiện trên máy mới.';
            m.q(`[data-code="${b.dataset.id}"]`)?.focus();
            return;
          }
          const x = await api('POST', `/api/devices/requests/${b.dataset.id}/${b.dataset.a}`, { approvalCode: code });
          if (!x.ok) { m.q('.ctl-err').textContent = errText(x.body.error); return; }
          list = list.filter((q) => q.id !== b.dataset.id);
          draw();
        };
      });
      const first = m.q('input[data-code]');
      if (first) setTimeout(() => first.focus(), 50);
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
        // lệnh nguy hiểm cho phép xác nhận bằng mật khẩu đăng nhập kể cả khi chưa bật Face ID / Authenticator
        const pwOnly = Boolean(info.commandChallenge && methods.password);
        if (!methods.enrolled && !pwOnly) { enrollChoice(m, canPk, done, info.title || 'Thiết lập bảo mật'); return; }
        body.innerHTML = `
          <h3>${escHtml(info.title || 'Xác nhận để điều khiển')}</h3>
          ${reason ? `<p class="muted">${reason}</p>` : ''}
          <div class="ctl-err" style="color:var(--bad)"></div>
          ${methods.passkey && canPk ? '<div class="row"><button class="primary ctl-pk">Dùng vân tay / Face ID</button></div>' : ''}
          ${methods.totp ? `<label>Mã Authenticator<input class="ctl-code" inputmode="numeric" maxlength="6" autocomplete="one-time-code" placeholder="000000"></label>
            <div class="row"><button class="${methods.passkey && canPk ? 'fit' : 'primary'} ctl-go">Xác nhận</button></div>` : ''}
          ${info.commandChallenge && methods.password ? '<label>Hoặc mật khẩu đăng nhập<input type="password" class="ctl-cpw" autocomplete="current-password" placeholder="Mật khẩu"></label><div class="row"><button class="fit ctl-cpwgo">Xác nhận lệnh bằng mật khẩu</button></div>' : ''}
          ${pendingSession && methods.password ? '<label>Hoặc nhập mật khẩu<input type="password" class="ctl-pw" autocomplete="current-password" placeholder="Mật khẩu"></label><div class="row"><button class="fit ctl-pwgo">Xác nhận bằng mật khẩu</button></div>' : ''}
          <div class="row"><button class="fit ctl-newdev">Máy mới / mất máy cũ?</button><button class="fit ctl-cancel">Huỷ</button></div>`;
        const cpwgo = m.q('.ctl-cpwgo');
        if (cpwgo) {
          const cpw = m.q('.ctl-cpw');
          const goPw = async () => {
            if (cpwgo.disabled || finished) return;
            if (!cpw.value) { err('Nhập mật khẩu.'); return; }
            cpwgo.disabled = true; err('');
            try {
              const r = await api('POST', '/api/control/unlock-password', { password: cpw.value }, extra);
              if (r.ok) { saveToken(r.body); done(true); } else err(errText(r.body?.error));
            } finally { cpwgo.disabled = false; }
          };
          cpwgo.onclick = goPw;
          cpw.onkeydown = (e) => { if (e.key === 'Enter') goPw(); };
        }
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
  /** Đường dẫn mở thẳng Cài đặt của máy. Chỉ có trên Android / Windows / macOS: iPhone chặn mọi liên kết tới app Cài đặt từ trang web (lỗi «địa chỉ không hợp lệ»), nên không đưa nút ở đó. */
  function settingsLink() {
    const ua = navigator.userAgent;
    if (/Android/.test(ua)) return { href: 'intent:#Intent;action=android.settings.SECURITY_SETTINGS;end', text: 'Mở Cài đặt bảo mật' };
    if (/Windows/.test(ua)) return { href: 'ms-settings:signinoptions', text: 'Mở Cài đặt Windows Hello' };
    if (/Macintosh/.test(ua)) return { href: 'x-apple.systempreferences:com.apple.preferences.password', text: 'Mở Cài đặt Touch ID' };
    return null;
  }

  /**
   * Hình minh hoạ màn hình Cài đặt iPhone (vẽ bằng SVG, KHÔNG phải ảnh chụp thật): khoanh đỏ chỗ cần chạm / bật / tắt.
   * rows: { h } tiêu đề nhóm | { t, k: 'nav'|'toggle'|'check', on, hi: nhãn đỏ } — hi có giá trị thì được khoanh.
   */
  function mockScreen({ title, back = 'Cài đặt', rows }) {
    const W = 260; const RH = 30; const HH = 20; const TOP = 34;
    const x = (v) => escHtml(String(v));
    let y = TOP; let body = ''; let marks = '';
    for (const r of rows) {
      if (r.h) {
        body += `<text x="14" y="${y + 14}" font-size="8.5" fill="#6d6d72">${x(r.h)}</text>`;
        y += HH;
        continue;
      }
      body += `<rect x="6" y="${y}" width="${W - 12}" height="${RH}" fill="#fff"/><line x1="16" y1="${y + RH}" x2="${W - 6}" y2="${y + RH}" stroke="#e5e5ea" stroke-width=".7"/>`;
      body += `<text x="16" y="${y + 19}" font-size="11" fill="#111">${x(r.t)}</text>`;
      const cx = W - 36;
      if (r.k === 'toggle') {
        body += `<rect x="${cx}" y="${y + 6}" width="30" height="18" rx="9" fill="${r.on ? '#34c759' : '#e5e5ea'}"/><circle cx="${r.on ? cx + 21 : cx + 9}" cy="${y + 15}" r="7.2" fill="#fff"/>`;
      } else if (r.k === 'check') {
        body += `<text x="${W - 26}" y="${y + 20}" font-size="15" fill="#007aff">✓</text>`;
      } else {
        body += `<text x="${W - 22}" y="${y + 20}" font-size="15" fill="#c4c4c7">›</text>`;
      }
      if (r.hi) {
        marks += `<rect x="3" y="${y - 1}" width="${W - 6}" height="${RH + 2}" rx="7" fill="none" stroke="#e11d48" stroke-width="2.4"/>`
          + `<rect x="${W - 62}" y="${y - 9}" width="54" height="14" rx="7" fill="#e11d48"/><text x="${W - 35}" y="${y + 1}" font-size="8.5" font-weight="700" fill="#fff" text-anchor="middle">${x(r.hi)}</text>`;
      }
      y += RH;
    }
    const H = y + 10;
    return `<svg viewBox="0 0 ${W} ${H}" width="100%" role="img" aria-label="Hình minh hoạ: ${x(title)}" style="max-width:300px;display:block;border-radius:10px;border:1px solid #d1d1d6;background:#f2f2f7;font-family:-apple-system,system-ui,sans-serif">`
      + `<text x="12" y="21" font-size="10.5" fill="#007aff">‹ ${x(back)}</text><text x="${W / 2 + 10}" y="21" font-size="11" font-weight="700" fill="#111" text-anchor="middle">${x(title)}</text>`
      + body + marks + '</svg>';
  }

  /** Danh sách kiểm tra nhanh (vài dòng) hiện ngay trong hộp lỗi; hướng dẫn chi tiết chỉ mở khi người dùng bấm xem. */
  function quickChecklist() {
    const ua = navigator.userAgent;
    const bio = bioName();
    if (/iPhone|iPad/.test(ua)) return [`Đã thiết lập ${bio} và mã khoá màn hình`, 'Đã đăng nhập iCloud (Mật khẩu và Chuỗi khoá đang bật)', 'Đang dùng Safari hoặc Chrome (không dùng trình duyệt trong Zalo / Telegram)'];
    if (/Android/.test(ua)) return ['Đã đặt khoá màn hình và thêm vân tay / khuôn mặt', 'Đang dùng Chrome'];
    if (/Windows/.test(ua)) return ['Đã thiết lập Windows Hello (khuôn mặt, vân tay hoặc PIN)'];
    if (/Macintosh/.test(ua)) return ['Đã thêm vân tay Touch ID'];
    return ['Máy đã bật khoá màn hình và vân tay / khuôn mặt'];
  }

  /** Hướng dẫn ngắn bật Face ID / vân tay + nút mở thẳng Cài đặt. Trả true khi bấm "Đã bật, thử lại", false khi "Đóng". */
  function bioGuide() {
    const ua = navigator.userAgent;
    const bio = bioName();
    // Mỗi bước: tiêu đề + danh sách thao tác cụ thể (chạm vào đâu, bật / chọn gì). Chữ in đậm là tên nút / mục trên máy.
    const back = { t: 'Quay lại trang này', a: ['Bấm <b>Đã bật, thử lại</b>.'] };
    let steps;
    if (/iPhone|iPad/.test(ua)) {
      steps = [
        { t: `Thiết lập ${bio}`,
          img: mockScreen({ title: bio === 'Touch ID' ? 'Touch ID & Mật mã' : 'Face ID & Mật mã', rows: [
            { t: `Thiết lập ${bio}`, k: 'nav', hi: 'CHẠM' },
            { h: `DÙNG ${bio.toUpperCase()} CHO` },
            { t: 'Mở khoá iPhone', k: 'toggle', on: true },
            { t: 'Tự động điền mật khẩu', k: 'toggle', on: true, hi: 'BẬT' },
          ] }),
          a: [
          `Mở <b>Cài đặt</b> › chạm <b>${bio === 'Touch ID' ? 'Touch ID & Mật mã' : 'Face ID & Mật mã'}</b>, nhập mật mã máy.`,
          `Nếu chưa có: chạm <b>Thiết lập ${bio}</b> và làm theo hướng dẫn trên màn hình.`,
          'Ở mục <b>Dùng Face ID cho</b>: bật <b>Tự động điền mật khẩu</b>.'.replace('Face ID', bio),
        ] },
        { t: 'Bật đồng bộ iCloud cho passkey',
          img: mockScreen({ title: 'Mật khẩu và Chuỗi khoá', back: 'iCloud', rows: [
            { t: 'Đồng bộ máy này', k: 'toggle', on: true, hi: 'BẬT' },
            { t: 'Chuỗi khoá iCloud', k: 'nav' },
          ] }),
          a: [
          'Mở <b>Cài đặt</b> › chạm <b>tên của bạn</b> (đầu trang) › <b>iCloud</b>.',
          'Chạm <b>Mật khẩu và Chuỗi khoá</b> (hoặc <b>Mật khẩu</b>).',
          'Bật <b>Đồng bộ máy này</b>.',
        ] },
        { t: 'Cho phép tự điền passkey',
          img: mockScreen({ title: 'Tuỳ chọn mật khẩu', back: 'Mật khẩu', rows: [
            { t: 'Tự động điền mật khẩu và passkey', k: 'toggle', on: true, hi: 'BẬT' },
            { h: 'TỰ ĐỘNG ĐIỀN TỪ' },
            { t: 'Mật khẩu', k: 'check', hi: 'CHỌN' },
            { t: 'Authenticator', k: 'toggle', on: false, hi: 'TẮT' },
          ] }),
          a: [
          'Mở <b>Cài đặt</b> › <b>Mật khẩu</b> › <b>Tuỳ chọn mật khẩu</b>.',
          'Bật <b>Tự động điền mật khẩu và passkey</b>.',
          'Ở mục <b>Tự động điền từ</b>: bật <b>Mật khẩu</b> (iCloud); <b>tắt</b> Authenticator và các app khác.',
        ] },
        { t: 'Mở lại trang bằng đúng trình duyệt', a: [
          'Dùng <b>Safari</b> hoặc <b>Chrome</b>; không dùng trình duyệt trong Zalo / Telegram.',
          'Đóng hẳn trang rồi mở lại.',
        ] },
        back,
      ];
    } else if (/Android/.test(ua)) {
      steps = [
        { t: 'Đặt khoá màn hình và sinh trắc', a: [
          'Mở <b>Cài đặt</b> › <b>Bảo mật</b> (hoặc <b>Sinh trắc học</b>).',
          'Chạm <b>Khoá màn hình</b>, đặt mã PIN / hình / mật khẩu nếu chưa có.',
          'Chạm <b>Vân tay</b> hoặc <b>Mở khoá bằng khuôn mặt</b> › thêm vân tay / khuôn mặt của bạn.',
        ] },
        { t: 'Chọn trình quản lý passkey', a: [
          'Mở <b>Cài đặt</b> › <b>Mật khẩu, passkey và tài khoản</b>.',
          'Ở <b>Dịch vụ ưu tiên</b>: chọn <b>Trình quản lý mật khẩu của Google</b>; tắt Authenticator và các dịch vụ khác.',
        ] },
        { t: 'Mở lại trang bằng Chrome', a: ['Đóng hẳn trang rồi mở lại bằng <b>Chrome</b>.'] },
        back,
      ];
    } else if (/Windows/.test(ua)) {
      steps = [
        { t: 'Thiết lập Windows Hello', a: [
          'Mở <b>Cài đặt</b> › <b>Tài khoản</b> › <b>Tuỳ chọn đăng nhập</b>.',
          'Chọn <b>Nhận dạng khuôn mặt</b>, <b>Nhận dạng vân tay</b> hoặc <b>PIN</b> › chạm <b>Thiết lập</b>.',
          'Làm theo hướng dẫn (tạo PIN nếu được yêu cầu).',
        ] },
        back,
      ];
    } else if (/Macintosh/.test(ua)) {
      steps = [
        { t: 'Thêm vân tay Touch ID', a: [
          'Mở <b>Cài đặt hệ thống</b> › <b>Touch ID & Mật khẩu</b>.',
          'Chạm <b>Thêm vân tay</b> và làm theo hướng dẫn.',
        ] },
        back,
      ];
    } else {
      steps = [
        { t: 'Bật khoá màn hình và sinh trắc', a: ['Trong Cài đặt bảo mật của máy: đặt khoá màn hình và thêm vân tay / khuôn mặt.'] },
        back,
      ];
    }
    const link = settingsLink();
    const badge = 'flex:0 0 26px;height:26px;border-radius:50%;background:var(--acc,#2563eb);color:var(--bg,#fff);display:flex;align-items:center;justify-content:center;font-weight:700;font-size:13px';
    return new Promise((resolve) => {
      const m = modal(`<div class="ctl-body"><h3>Bật ${escHtml(bio)} — ${steps.length} bước</h3>
        <p class="muted" style="margin:0;font-size:13px">Chạm từng bước để xem chi tiết.</p>
        <ol style="list-style:none;margin:10px 0;padding:0;display:flex;flex-direction:column;gap:10px">${steps.map((st, i) => `
          <li><details ${i === 0 ? 'open' : ''} style="border:1px solid var(--line,#444);border-radius:10px;padding:8px 10px">
            <summary style="display:flex;gap:10px;align-items:center;cursor:pointer;list-style:none"><span style="${badge}">${i + 1}</span><span style="font-weight:600">${escHtml(st.t)}</span></summary>
            <div style="margin-top:8px;padding-left:36px">
              ${st.img ? `<div style="margin:0 0 6px">${st.img}<div class="muted" style="font-size:11px;margin-top:2px">Hình minh hoạ — vòng đỏ là chỗ cần chạm / bật / tắt (giao diện máy bạn có thể khác chút).</div></div>` : ''}
              <ul class="muted" style="margin:0;padding-left:18px;font-size:13px;line-height:1.45">${st.a.map((x) => `<li style="margin-bottom:3px">${x}</li>`).join('')}</ul></div></details></li>`).join('')}
        </ol>
        ${link ? '' : '<p class="muted" style="margin:6px 0;font-size:13px">iPhone không cho trang web mở Cài đặt: hãy vuốt về Màn hình chính và mở app <b>Cài đặt</b>.</p>'}
        <div class="row" style="flex-direction:column">
          ${link ? `<button class="primary" data-a="open">${escHtml(link.text)}</button>` : ''}
          <button class="${link ? 'fit' : 'primary'}" data-a="retry">Đã bật, thử lại</button><button class="fit" data-a="x">Đóng</button></div></div>`);
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
      const box = stepBox(`${stepLabel}: tạo mật khẩu`, 'Mật khẩu bắt buộc (từ 8 ký tự, không chứa tên đăng nhập). Dùng để đăng nhập khi đổi điện thoại — Face ID không mang sang máy mới.');
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
  async function bioRegisterStep(strict = false, stepLabel = '') {
    for (;;) {
      let r;
      try { r = await passkeyRegister(`${/iPhone|iPad/.test(navigator.userAgent) ? 'iPhone' : /Android/.test(navigator.userAgent) ? 'Android' : 'Máy tính'} ${new Date().toLocaleDateString('vi-VN')}`, stepLabel); } catch (e) { r = { ok: false, error: e?.message === 'cancelled' ? 'cancelled' : 'webauthn_failed' }; }
      dbg('bio.step_result', r.ok ? 'ok' : (r.error || 'fail'), { ok: Boolean(r.ok), error: r.error, detail: r.detail, strict }, r.ok ? 'ok' : 'warn');
      if (r.ok) return 'ok';
      if (r.error === 'reauth_required' && await reauthModal()) continue;
      // Hộp Face ID còn mở ở trạng thái lỗi: lấy lý do rồi đóng để chỉ còn một hộp lựa chọn
      const why = document.querySelector('.bio-sheet .bio-msg')?.textContent || '';
      document.querySelectorAll('.bio-sheet').forEach((el) => el.closest('.ctl-modal')?.remove());
      const choice = await new Promise((resolve) => {
        const box = stepBox(`Chưa bật được ${bioName()}`, `Máy của bạn hỗ trợ ${bioName()} nên bước này là bắt buộc${strict ? ' để hoàn tất tài khoản mới' : ''}.`);
        box.err(why || (r.error && r.error !== 'cancelled' ? errText(r.error) : ''));
        const quick = quickChecklist().map((t) => `<li style="margin-bottom:3px">${escHtml(t)}</li>`).join('');
        // Tài khoản mới: phải đăng ký đủ, không có lối thoát (chỉ thử lại hoặc huỷ). Tài khoản cũ vẫn có "dùng mật khẩu thay thế".
        box.body.innerHTML = `<p class="muted" style="margin:0 0 4px;font-size:13px">Kiểm tra nhanh:</p>
          <ul class="muted" style="margin:0 0 10px;padding-left:18px;font-size:13px;line-height:1.4">${quick}</ul>
          <div class="row" style="flex-direction:column"><button class="primary sp-retry">Thử lại bật ${escHtml(bioName())}</button>
          <button class="fit sp-guide">Xem hướng dẫn chi tiết</button>
          ${strict ? '' : '<button class="fit sp-alt">Không bật được? Dùng mật khẩu thay thế</button>'}<button class="fit sp-x">Huỷ đăng nhập</button></div>`;
        box.body.querySelector('.sp-retry').onclick = () => { box.m.close(); resolve('retry'); };
        box.body.querySelector('.sp-guide').onclick = async () => { box.m.close(); resolve(await bioGuide() ? 'retry' : 'again'); };
        box.body.querySelector('.sp-alt')?.addEventListener('click', () => { box.m.close(); resolve('optout'); });
        box.body.querySelector('.sp-x').onclick = () => { box.m.close(); resolve('cancel'); };
      });
      dbg('bio.step_choice', String(choice), { choice }, 'info');
      if (choice === 'retry') continue;
      if (choice === 'again') { r = null; continue; }
      return choice;
    }
  }

  /**
   * Sau claim/invite/resume: sinh trắc (máy này) + mật khẩu bắt buộc.
   * Kết thúc: hiện kho lưu username + mật khẩu + mã khôi phục (một lần).
   */
  async function loginStepper(data) {
    const bio = await bioInfo();
    dbg('stepper.start', 'Bắt đầu các bước thiết lập', { bio, registering: Boolean(data.registering), methods: data.methods, src: data.src }, 'info');
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
        // Không bắt buộc Face ID tuyệt đối (máy mới khác nhau): cho phép bỏ qua → mật khẩu.
        const r = await bioRegisterStep(Boolean(data.registering), data.registering ? 'Bước 2/3' : '');
        if (r === 'cancel') return null;
        usedBio = r === 'ok';
        optOut = r === 'optout';
      }
    }
    const stepNo = data.registering ? (bio.supported ? 'Bước 3/3' : 'Bước 2/2') : (!methods.password && bio.supported) ? 'Bước 2/2' : 'Bước 1/1';
    let password = null;
    if (!methods.password) {
      password = await passwordSetStep(stepNo);
      if (!password) return null;
    } else if (!usedBio) {
      return passwordEnterStep(stepNo, bio.supported && !resume ? { bioCapable: true, bioOptOut: true } : {});
    }
    let done;
    if (usedBio) {
      done = await api('POST', '/api/login/complete', {});
      if (!done.ok) throw new Error(errText(done.body.error));
    } else {
      done = await api('POST', '/api/login/complete-basic', { password, ...(bio.supported && !resume ? { bioCapable: true, bioOptOut: true } : {}) });
      if (!done.ok) throw new Error(errText(done.body.error));
    }
    const body = done.body;
    const codes = body.recoveryCodes || pendingSession?._codes || [];
    if (data.isNew || password || codes.length) {
      await showCredentialsVault({
        username: body.username || pendingSession?.username || data.username,
        password: password || undefined,
        codes,
        registered: Boolean(data.registering),
      });
    }
    return body;
  }

  /** Tuỳ chọn cho tài khoản mới: nhập email khôi phục (gửi mã xác minh). Bỏ qua được; lỗi gửi (vd. server chưa bật email) cũng không chặn đăng ký. */
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
    pendingSession = {
      token: data.token, userId: data.userId, username: data.username,
      apiBase: location.origin, src: data.src, methods: data.methods, isNew: Boolean(data.isNew),
    };
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
    recoverySetup, passkeyProof, enrollPasskeyNow, enrollMandatory, completeNeedPassword, bioInfo, notice, api, unlock, errText, addErrors, modal, escHtml, LS, loginWithPasskey, offerEnroll, completeOtp, resumeLogin, passkeySupported, platformAvailable: platformAuthenticator, showCredentialsVault, showRecoveryCodes,
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
