'use strict';
/* Settings → "Tài khoản & bảo mật": change phone, recovery email, recovery codes. */
(function () {
  const $ = (s) => document.querySelector(s);
  const LS = {
    get(k, d) { try { return JSON.parse(localStorage.getItem(k)) ?? d; } catch { return d; } },
    del(k) { try { localStorage.removeItem(k); } catch {} },
  };
  const session = LS.get('session', null);
  const root = $('#acct');
  if (!root || !session?.token || session.demo) return;
  root.hidden = false;

  const ERR = {
    invalid_credentials: 'Cần xác nhận lại danh tính.',
    invalid_phone: 'Cần số di động Việt Nam hợp lệ.',
    same_phone: 'Trùng số hiện tại.',
    phone_in_use: 'Số này đã thuộc tài khoản khác.',
    new_phone_telegram_not_linked: 'Số mới chưa liên kết Telegram: mở bot → /start → chia sẻ số đó.',
    telegram_in_use: 'Telegram này đang gắn với tài khoản khác.',
    old_channel_unavailable: 'Kênh xác minh cũ chưa sẵn sàng.',
    email_quarantine: 'Email mới thêm chưa dùng được (đang trong thời gian chờ).',
    no_recovery_codes: 'Chưa có mã khôi phục. Hãy tạo trước.',
    change_already_pending: 'Đã có một yêu cầu đang chờ xử lý.',
    otp_invalid: 'Mã OTP sai.',
    otp_expired: 'Mã hết hạn, bắt đầu lại.',
    otp_locked: 'Nhập sai quá nhiều, bắt đầu lại sau.',
    recovery_code_invalid: 'Mã khôi phục sai hoặc đã dùng.',
    recovery_locked: 'Quá nhiều lần thử mã khôi phục. Thử lại sau 24 giờ.',
    rate_limited: 'Thử quá nhiều lần, vui lòng chờ.',
    email_disabled: 'Máy chủ chưa cấu hình gửi email.',
    invalid_email: 'Email không hợp lệ.',
    email_send_failed: 'Không gửi được email.',
    otp_send_failed: 'Không gửi được Telegram.',
    session_revoked: 'Phiên đã bị thu hồi.',
    reauth_required: 'Để bảo mật, hãy đăng xuất rồi đăng nhập lại (vân tay hoặc OTP Telegram) trước khi thực hiện thao tác này.',
    step_up_required: 'Cần xác nhận bằng vân tay / Authenticator.',
    cancelled: 'Đã huỷ.',
    unauthorized: 'Phiên hết hạn, đăng nhập lại.',
  };

  let sec = null;
  let changeId = null;
  let chan = 'telegram';

  function msg(text, bad) {
    const el = $('#acct-msg');
    el.textContent = text || '';
    el.classList.toggle('err', Boolean(bad));
  }
  const errText = (d) => ERR[d.error] || window.Security.errText(d.error) || 'Lỗi không xác định';
  const fmt = (ms) => new Date(ms).toLocaleString('vi-VN');

  // Thao tác nhạy cảm không còn hỏi mật khẩu: server đòi xác nhận bằng vân tay / Authenticator (step_up_required).
  async function api(path, body, retried) {
    const r = await window.Security.api(body === undefined ? 'GET' : 'POST', path, body);
    const data = r.body;
    if (r.status === 401 && data.error === 'step_up_required' && !retried && window.Security) {
      LS.del('ctl');
      if (await window.Security.unlock(data)) return api(path, body, true);
      return { ok: false, data: { error: 'cancelled' } };
    }
    if (r.status === 401 && data.error === 'reauth_required') return { ok: false, data };
    if (r.status === 401 && ['unauthorized', 'session_revoked'].includes(data.error)) {
      LS.del('session');
      location.replace('login.html?revoked=1');
    }
    return { ok: r.ok, data };
  }

  function busy(ids, on) {
    ids.forEach((id) => { const e = $('#' + id); if (e) e.disabled = on; });
  }

  function renderChannels() {
    const sel = $('#pc-chan');
    const opts = [];
    if (sec.contactLinked) opts.push(['primary', window.AuthApp?.contactLabel || 'OTP kênh xác thực hiện tại']);
    if (sec.emailVerified) {
      opts.push(['email', sec.emailUsableAt ? `OTP email (chờ đến ${fmt(sec.emailUsableAt)})` : 'OTP email']);
    }
    if (sec.recoveryCodesRemaining > 0) {
      opts.push(['recovery_code', `Mã khôi phục (còn ${sec.recoveryCodesRemaining}) — chờ ${sec.coolingHours} giờ`]);
    }
    sel.innerHTML = '';
    opts.forEach(([v, t]) => {
      const o = document.createElement('option');
      o.value = v; o.textContent = t;
      sel.appendChild(o);
    });
    sel.disabled = !opts.length;
  }

  function renderSummary() {
    const lines = [
      `SĐT: <b>${window.Security.escHtml(sec.phoneLocal)}</b>`,
      `Kênh xác thực: ${sec.contactLinked ? 'đã liên kết ✅' : 'chưa liên kết ⚠️'}`,
      `Email khôi phục: ${sec.emailVerified ? `${window.Security.escHtml(sec.email)} ✅` : 'chưa có'}${sec.emailUsableAt ? ` (dùng được từ ${fmt(sec.emailUsableAt)})` : ''}`,
      `Mã khôi phục còn lại: <b>${sec.recoveryCodesRemaining}</b>${sec.recoveryCodesRemaining ? '' : ' ⚠️ chưa tạo'}`,
    ];
    $('#acct-sum').innerHTML = lines.join('<br>');
    $('#acct-pending').innerHTML = '';
    sec.pending.filter((p) => p.status !== 'pending_otp').forEach((p) => {
      const d = document.createElement('div');
      d.className = 'pend';
      const label = p.status === 'cooling'
        ? `Đổi sang ${p.newPhone} có hiệu lực lúc ${fmt(p.executeAt)}`
        : `Yêu cầu khôi phục → ${p.newPhone} đang chờ quản trị duyệt`;
      d.textContent = label;
      const b = document.createElement('button');
      b.className = 'danger';
      b.textContent = 'Huỷ yêu cầu';
      b.onclick = async () => {
        const { ok, data } = await api('/api/account/phone/cancel', { id: p.id });
        msg(ok ? 'Đã huỷ yêu cầu.' : errText(data), !ok);
        load();
      };
      d.appendChild(b);
      $('#acct-pending').appendChild(d);
    });
    window.AuthApp?.onSecuritySummary?.(sec);
    $('#em-addr').placeholder = sec.emailEnabled ? 'ban@example.com' : 'Máy chủ chưa bật email';
    $('#em-send').disabled = !sec.emailEnabled;
    renderChannels();
  }

  async function load() {
    const { ok, data } = await api('/api/account/security');
    if (!ok) { $('#acct-sum').textContent = errText(data); return; }
    sec = data;
    renderSummary();
  }

  /* ---- change phone ---- */
  function showStep(n) {
    $('#pc-1').hidden = n !== 1;
    $('#pc-2').hidden = n !== 2;
  }

  $('#pc-start').onclick = async () => {
    msg('');
    chan = $('#pc-chan').value;
    if (!chan) { msg('Chưa có kênh xác minh nào khả dụng.', true); return; }
    busy(['pc-start'], true);
    const { ok, data } = await api('/api/account/phone/start', {
      newPhone: $('#pc-new').value.trim(), oldChannel: chan,
    });
    busy(['pc-start'], false);
    if (!ok) { msg(errText(data), true); return; }
    changeId = data.id;
    $('#pc-old-wrap').hidden = chan === 'recovery_code';
    $('#pc-code-wrap').hidden = chan !== 'recovery_code';
    $('#pc-otp-old').placeholder = chan === 'email' ? 'Mã gửi qua email' : 'Mã gửi qua kênh xác thực cũ';
    showStep(2);
    msg(`Đã gửi mã tới số mới ${data.newPhoneMasked}.`);
  };

  $('#pc-abort').onclick = async () => {
    if (changeId) await api('/api/account/phone/cancel', { id: changeId });
    changeId = null;
    showStep(1);
    msg('');
    load();
  };

  $('#pc-confirm').onclick = async () => {
    msg('');
    busy(['pc-confirm'], true);
    const { ok, data } = await api('/api/account/phone/confirm', {
      id: changeId,
      newOtp: $('#pc-otp-new').value.trim(),
      oldOtp: $('#pc-otp-old').value.trim(),
      recoveryCode: $('#pc-code').value.trim(),
    });
    busy(['pc-confirm'], false);
    if (!ok) { msg(errText(data) + (data.which === 'old' ? ' (mã kênh cũ)' : data.which === 'new' ? ' (mã số mới)' : ''), true); return; }
    if (data.status === 'applied') {
      msg('Đã đổi số. Đang đăng xuất để đăng nhập lại bằng số mới…');
      LS.del('session');
      setTimeout(() => location.replace('login.html?changed=1'), 1500);
      return;
    }
    changeId = null;
    showStep(1);
    msg(`Đã ghi nhận. Số mới sẽ có hiệu lực lúc ${fmt(data.executeAt)}; bạn có thể huỷ trước đó.`);
    load();
  };

  /* ---- email ---- */
  $('#em-send').onclick = async () => {
    msg('');
    busy(['em-send'], true);
    const { ok, data } = await api('/api/account/email/request', {
      email: $('#em-addr').value.trim(),
    });
    busy(['em-send'], false);
    if (!ok) { msg(errText(data), true); return; }
    $('#em-1').hidden = true;
    $('#em-2').hidden = false;
    msg('Đã gửi mã tới email.');
  };

  $('#em-verify').onclick = async () => {
    msg('');
    const { ok, data } = await api('/api/account/email/verify', { otp: $('#em-otp').value.trim() });
    if (!ok) { msg(errText(data), true); return; }
    $('#em-1').hidden = false;
    $('#em-2').hidden = true;
    $('#em-otp').value = '';
    msg('Đã xác minh email.');
    load();
  };

  /* ---- recovery codes ---- */
  let lastCodes = '';
  $('#rc-gen').onclick = async () => {
    msg('');
    const { ok, data } = await api('/api/account/recovery-codes', {});
    if (!ok) { msg(errText(data), true); return; }
    lastCodes = data.codes.join('\n');
    $('#rc-out').textContent = lastCodes;
    $('#rc-out').hidden = false;
    $('#rc-actions').hidden = false;
    msg('Lưu các mã này ngay — chúng sẽ không hiển thị lại.');
    load();
  };
  $('#rc-copy').onclick = async () => {
    try { await navigator.clipboard.writeText(lastCodes); msg('Đã sao chép.'); } catch { msg('Không sao chép được; hãy chọn và chép tay.', true); }
  };
  $('#rc-dl').onclick = () => {
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([`Ma khoi phuc Giam sat PLC\n${new Date().toISOString()}\n\n${lastCodes}\n`], { type: 'text/plain' }));
    a.download = 'plc-recovery-codes.txt';
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 2000);
  };

  load();
  document.addEventListener('security-profile-refresh', load);
})();
