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
  const session = () => LS.get('session', null);
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
  };
  const errText = (e) => ERR[e] || e || 'Lỗi';
  /** App thêm thông báo lỗi riêng (vd. lệnh PLC) mà không sửa lõi. */
  const addErrors = (m) => Object.assign(ERR, m);

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
    try {
      const r = await fetch(base() + path, {
        method,
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${s?.token || ''}`,
          'X-Device-Id': devId(),
          ...(tok?.token ? { 'X-Control-Token': tok.token } : {}),
          ...(en?.ticket && en.exp > Date.now() ? { 'X-Enroll-Ticket': en.ticket } : {}),
          ...(extra || {}),
        },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      return { status: r.status, ok: r.ok, body: await r.json().catch(() => ({})) };
    } catch {
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
    const o = await api('POST', '/api/webauthn/register/options', {});
    if (!o.ok) return o.body;
    const opts = o.body;
    const cred = await navigator.credentials.create({
      publicKey: {
        ...opts,
        challenge: b64uToBuf(opts.challenge),
        user: { ...opts.user, id: b64uToBuf(opts.user.id) },
        excludeCredentials: (opts.excludeCredentials || []).map((c) => ({ ...c, id: b64uToBuf(c.id) })),
      },
    });
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
    if (r.ok) { saveToken(r.body); LS.set('hasPasskey', true); if (r.body.recoveryCodes?.length) await showRecoveryCodes(r.body.recoveryCodes); }
    return r.body;
  }

  async function passkeyUnlock() {
    const o = await api('POST', '/api/webauthn/auth/options', {});
    if (!o.ok) return o.body;
    const opts = o.body;
    const cred = await navigator.credentials.get({
      publicKey: {
        ...opts,
        challenge: b64uToBuf(opts.challenge),
        allowCredentials: (opts.allowCredentials || []).map((c) => ({ ...c, id: b64uToBuf(c.id) })),
      },
    });
    const r = await api('POST', '/api/webauthn/auth/verify', {
      credential: {
        id: cred.id,
        response: {
          clientDataJSON: bufToB64u(cred.response.clientDataJSON),
          authenticatorData: bufToB64u(cred.response.authenticatorData),
          signature: bufToB64u(cred.response.signature),
        },
      },
    });
    if (r.ok) saveToken(r.body);
    return r.body;
  }

  async function totpUnlock(code) {
    const r = await api('POST', '/api/control/unlock', { code });
    if (r.ok) saveToken(r.body);
    return r.body;
  }

  async function totpEnable(code) {
    const r = await api('POST', '/api/control/totp/enable', { code });
    if (r.ok) { saveToken(r.body); if (r.body.recoveryCodes?.length) await showRecoveryCodes(r.body.recoveryCodes); }
    return r.body;
  }

  /* ---------- hộp thoại ---------- */
  function modal(html) {
    const wrap = document.createElement('div');
    wrap.className = 'ctl-modal';
    wrap.innerHTML = `<div class="ctl-box" role="dialog" aria-modal="true">${html}</div>`;
    document.body.appendChild(wrap);
    return { el: wrap, q: (s) => wrap.querySelector(s), close: () => wrap.remove() };
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
      <input class="ctl-code" inputmode="numeric" maxlength="6" autocomplete="one-time-code" placeholder="000000">
      <p class="ctl-err" style="color:var(--bad)"></p>
      <div class="row"><button class="primary ctl-go">Xác nhận</button><button class="fit ctl-cancel">Huỷ</button></div>`;
    return new Promise((resolve) => {
      m.q('.ctl-cancel').onclick = () => resolve(false);
      m.q('.ctl-go').onclick = async () => {
        const r = await totpEnable(m.q('.ctl-code').value.trim());
        if (r.ok) resolve(true); else m.q('.ctl-err').textContent = errText(r.error);
      };
    });
  }

  async function passkeyEnrollFlow(m) {
    try {
      const r = await passkeyRegister(`${/iPhone|iPad/.test(navigator.userAgent) ? 'iPhone' : /Android/.test(navigator.userAgent) ? 'Android' : 'Máy tính'} ${new Date().toLocaleDateString('vi-VN')}`);
      if (r.ok) return true;
      m.lastErr = r.error;
      m.q('.ctl-err').textContent = errText(r.error);
    } catch (e) {
      m.q('.ctl-err').textContent = e?.name === 'NotAllowedError' ? 'Đã huỷ trên thiết bị.' : errText('webauthn_failed');
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

  /** Chọn cách đăng ký yếu tố điều khiển trên máy này (lần đầu, hoặc máy mới đã có vé). */
  function enrollChoice(m, canPkPlatform, done, title = 'Bảo mật điều khiển') {
    const body = m.q('.ctl-body');
    {
      body.innerHTML = `
        <h3>${title}</h3>
        <p class="muted">Chọn cách xác nhận mỗi khi điều khiển thiết bị từ xa. Chỉ cần làm một lần trên máy này.</p>
        <div class="ctl-err" style="color:var(--bad)"></div>
        <div class="row" style="flex-direction:column;gap:8px">
          ${canPkPlatform ? '<button class="primary" data-a="pk">Dùng vân tay / Face ID</button>' : ''}
          <button class="${canPkPlatform ? 'fit' : 'primary'}" data-a="totp">Dùng ứng dụng Authenticator (mã 6 số)</button>
          <button class="fit" data-a="x">Để sau</button>
        </div>`;
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
            nd.textContent = 'Xác nhận bằng email / chờ 24 giờ';
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
    let st = null;
    if (req) {
      const r = await poll(req);
      if (r.ok && ['pending', 'cooling', 'approved'].includes(r.body.status)) st = r.body; else { LS.del('devReq'); req = null; }
    }
    if (!req) {
      const r = await api('POST', '/api/devices/request', { label });
      if (!r.ok) {
        body.innerHTML = `<h3>Thêm thiết bị mới</h3><p style="color:var(--bad)">${escHtml(errText(r.body.error))}</p>${closeBtn}`;
        return wireClose();
      }
      req = { id: r.body.id, pollToken: r.body.pollToken, options: r.body.options, coolingHours: r.body.coolingHours };
      LS.set('devReq', req);
      st = { status: 'pending' };
    }

    let shown = null; let enrolling = false;
    const err = (t) => { const e = m.q('.ctl-err'); if (e) e.textContent = t || ''; };

    function renderPending() {
      const o = req.options || {};
      body.innerHTML = `
        <h3>Thêm thiết bị mới</h3>
        ${o.device === false ? '' : '<p><b>Cách nhanh nhất:</b> mở ứng dụng trên <b>máy cũ</b> → sẽ có thông báo "Thiết bị mới xin vào" → bấm <b>Cho phép</b>. Màn hình này tự tiếp tục.</p>'}
        <div class="ctl-err" style="color:var(--bad)"></div>
        ${o.recoveryCode ? `<hr><p class="muted">Không còn máy cũ? Dùng <b>mã khôi phục</b> (chờ ${req.coolingHours || 24} giờ):</p>
          <input class="ctl-rc" placeholder="XXXX-XXXX-XXXX" autocapitalize="characters" autocomplete="off">
          <div class="row"><button class="fit ctl-rc-go">Dùng mã khôi phục</button></div>` : ''}
        ${o.email ? `<hr><p class="muted">Hoặc nhận mã qua <b>email đã xác minh</b>:</p>
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
        return enrollChoice(m, canPkPlatform, (v) => { LS.del('enroll'); done(v); }, 'Thiết bị đã được cho phép');
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
          <div class="row"><button class="primary" data-a="approve" data-id="${q.id}">Cho phép</button><button class="danger" data-a="deny" data-id="${q.id}">Từ chối</button></div></div>`).join('')}
        <div class="row"><button class="fit ctl-close">Đóng</button></div>`;
      m.q('.ctl-close').onclick = m.close;
      m.el.querySelectorAll('[data-a]').forEach((b) => {
        b.onclick = async () => {
          const x = await api('POST', `/api/devices/requests/${b.dataset.id}/${b.dataset.a}`, {});
          if (!x.ok) { m.q('.ctl-err').textContent = errText(x.body.error); return; }
          list = list.filter((q) => q.id !== b.dataset.id); draw();
        };
      });
    };
    draw();
  }

  /** Hỏi người dùng xác thực để mở khoá điều khiển. Resolve true khi đã có phiên điều khiển. */
  function unlock(info = {}) {
    const methods = info.methods || { passkey: false, totp: false, enrolled: false };
    return new Promise(async (resolve) => {
      const canPk = passkeySupported();
      const canPlatform = await platformAuthenticator();
      const m = modal(`<div class="ctl-body"></div>`);
      const done = (v) => { m.close(); resolve(v); };
      const body = m.q('.ctl-body');

      const render = () => {
        const reason = { network_changed: 'Bạn vừa đổi mạng — cần xác nhận lại.', expired: 'Phiên điều khiển đã hết hạn.' }[info.reason] || '';
        if (!methods.enrolled) { enrollChoice(m, canPk && canPlatform, done); return; }
        body.innerHTML = `
          <h3>Xác nhận để điều khiển</h3>
          ${reason ? `<p class="muted">${reason}</p>` : ''}
          <div class="ctl-err" style="color:var(--bad)"></div>
          ${methods.passkey && canPk ? '<div class="row"><button class="primary ctl-pk">Dùng vân tay / Face ID</button></div>' : ''}
          ${methods.totp ? `<label>Mã Authenticator<input class="ctl-code" inputmode="numeric" maxlength="6" autocomplete="one-time-code" placeholder="000000"></label>
            <div class="row"><button class="${methods.passkey && canPk ? 'fit' : 'primary'} ctl-go">Xác nhận</button></div>` : ''}
          <div class="row"><button class="fit ctl-newdev">Máy mới / mất máy cũ?</button><button class="fit ctl-cancel">Huỷ</button></div>`;
        const err = (t) => { m.q('.ctl-err').textContent = t || ''; };
        m.q('.ctl-cancel').onclick = () => done(false);
        m.q('.ctl-newdev').onclick = () => newDeviceFlow(m, done, canPk && canPlatform);
        const pk = m.q('.ctl-pk');
        if (pk) {
          const run = async () => {
            try {
              const r = await passkeyUnlock();
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
            const r = await totpUnlock(input.value.trim());
            if (r.ok) done(true); else err(errText(r.error));
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
    const post = async (path, body) => {
      const r = await fetch(location.origin + path, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Device-Id': devId() }, body: JSON.stringify(body) });
      return { ok: r.ok, body: await r.json().catch(() => ({})) };
    };
    const o = await post('/api/login/passkey/options', {});
    if (!o.ok) return o.body;
    const cred = await navigator.credentials.get({
      publicKey: { ...o.body, challenge: b64uToBuf(o.body.challenge), allowCredentials: [] },
    });
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
    if (r.ok) { saveToken(r.body); LS.set('hasPasskey', true); }
    return r.body;
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
    api, unlock, errText, addErrors, modal, escHtml, LS, loginWithPasskey, offerEnroll, passkeySupported, platformAvailable: platformAuthenticator,
    reviewDevices, renderBanner, devId,
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
