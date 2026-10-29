'use strict';
/*
 * Điều khiển PLC (RIÊNG của app này). Lệnh KHÔNG publish thẳng MQTT mà gửi tới POST /api/control/cmd; mọi xác thực
 * (Passkey / TOTP, banner bắt buộc bật yếu tố, thêm thiết bị…) do window.Security (packages/security) đảm nhiệm.
 * Lệnh nguy hiểm: server chờ nút nhấn vật lý tại xưởng (waitPhysical).
 */
(function () {
  const S = window.Security;
  const { api, unlock, modal, LS, renderBanner } = S;
  S.addErrors({
    forbidden: 'Tài khoản không có quyền điều khiển.',
    bad_command: 'Lệnh không hợp lệ.',
    mqtt_unavailable: 'Máy chủ chưa gửi được lệnh tới PLC.',
    value_out_of_range: 'Giá trị ngoài khoảng cho phép.',
    enroll_required: 'Điều khiển đang bị khoá: hãy bật vân tay / Face ID hoặc Authenticator trong tab Điều khiển.',
    confirm_expired: 'Hết thời gian chờ nút xác nhận tại xưởng.',
  });

  function waitPhysical(info) {
    const m = modal(`
      <h3>Xác nhận tại xưởng</h3>
      <p>Lệnh này cần <b>bấm nút vật lý</b> (ngõ vào X${info.bit}) tại xưởng trong <b class="ctl-left">${info.expiresIn}</b> giây.</p>
      <div class="row"><button class="fit ctl-cancel">Huỷ</button></div>`);
    return new Promise((resolve) => {
      let left = info.expiresIn; let stop = false;
      m.q('.ctl-cancel').onclick = () => { stop = true; m.close(); resolve({ error: 'cancelled' }); };
      (async function poll() {
        while (!stop && left > 0) {
          await new Promise((r) => setTimeout(r, 1000));
          if (stop) return;
          left--; const el = m.q('.ctl-left'); if (el) el.textContent = String(left);
          const r = await api('GET', `/api/control/confirm/${info.confirmId}`);
          if (r.body.sent) { m.close(); return resolve({ ok: true, id: info.id }); }
          if (!r.ok && r.body.error) { m.close(); return resolve({ error: r.body.error }); }
        }
        if (!stop) { m.close(); resolve({ error: 'confirm_expired' }); }
      }());
    });
  }

  /** @returns {Promise<{ok:true}|{error:string}>} */
  async function send(cmd) {
    if (window.AppLock?.isLocked()) return { error: 'app_locked' };
    let command = { ...cmd, id: cmd.id || Array.from(crypto.getRandomValues(new Uint8Array(6)), (byte) => byte.toString(16).padStart(2, '0')).join('') };
    let challenge = null;
    for (let attempt = 0; attempt < 3; attempt++) {
      const r = await api('POST', '/api/control/cmd', command, challenge ? { 'X-Command-Challenge': challenge } : undefined);
      if (r.status === 401 && r.body.error === 'step_up_required') {
        if (r.body.commandChallenge) {
          const { target, command: requested } = r.body;
          const confirmed = await new Promise((resolve) => {
            const m = modal(`<h3>Xác nhận lệnh PLC</h3><p>${S.escHtml(target.site)} / ${S.escHtml(target.device)}</p>
              <p>Ghi D${requested.a} = <b>${requested.v}</b></p>
              <div class="row"><button class="primary ctl-confirm">Xác nhận</button><button class="fit ctl-cancel">Huỷ</button></div>`);
            m.q('.ctl-confirm').onclick = () => { m.close(); resolve(true); };
            m.q('.ctl-cancel').onclick = () => { m.close(); resolve(false); };
          });
          if (!confirmed) return { error: 'cancelled' };
          challenge = r.body.commandChallenge;
          command = r.body.command;
        }
        LS.del('ctl');
        if (attempt < 2 && await unlock({ ...r.body, title: challenge ? 'Xác nhận lệnh PLC' : undefined })) continue;
        return { error: 'cancelled' };
      }
      if (r.status === 403 && r.body.error === 'enroll_required') {
        if (typeof window.showTab === 'function') window.showTab('ctrl');
        renderBanner();
        return { error: 'enroll_required' };
      }
      if (r.status === 202 && r.body.pending) return waitPhysical(r.body);
      if (r.status === 401) return { error: 'session_expired' };
      return r.ok ? { ok: true, id: r.body.id } : { error: r.body.error || 'error' };
    }
    return { error: 'cancelled' };
  }


  // window.Ctl giữ nguyên tên cũ cho app.js / account.js / site.js / admin.js / login.js
  window.Ctl = { ...S, send };
}());
