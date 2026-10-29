/* GENERATED từ packages/security/client/recover.js bằng "npm run sync-client". KHÔNG sửa ở đây. */
'use strict';
/* Account recovery without a session (lost old phone/Telegram). */
(function () {
  const $ = (s) => document.querySelector(s);
  const KEY = 'recoveryTicket';
  const ls = {
    get() { try { return localStorage.getItem(KEY); } catch { return null; } },
    set(v) { try { localStorage.setItem(KEY, v); } catch {} },
    del() { try { localStorage.removeItem(KEY); } catch {} },
  };
  const ERR = {
    invalid_phone: 'Cần số di động Việt Nam hợp lệ.',
    user_not_found: 'Không tìm thấy tài khoản với SĐT cũ này.',
    same_phone: 'SĐT mới trùng SĐT cũ.',
    phone_in_use: 'SĐT mới đã thuộc tài khoản khác.',
    new_phone_telegram_not_linked: 'SĐT mới chưa liên kết Telegram: mở bot → /start → chia sẻ đúng số đó.',
    telegram_in_use: 'Telegram này đang gắn với tài khoản khác.',
    change_already_pending: 'Tài khoản này đã có yêu cầu đang chờ xử lý.',
    rate_limited: 'Thử quá nhiều lần. Vui lòng chờ rồi thử lại.',
    otp_invalid: 'Mã OTP sai.',
    otp_expired: 'Mã hết hạn. Bắt đầu lại.',
    otp_locked: 'Nhập sai quá nhiều. Bắt đầu lại sau.',
    recovery_locked: 'Quá nhiều lần thử mã khôi phục. Thử lại sau 24 giờ.',
    otp_send_failed: 'Không gửi được Telegram. Thử lại.',
    plc_offline: 'PLC của tài khoản đang offline, không thể thử thách lúc này.',
    plc_challenge_expired: 'Thử thách đã hết hạn. Bắt đầu lại.',
    request_not_found: 'Không tìm thấy yêu cầu.',
    request_not_pending: 'Yêu cầu không còn ở trạng thái chờ.',
  };
  let id = ls.get();
  let timer = null;
  let presenceEnabled = false;

  function normalizeIdentity(value) {
    if (window.AuthApp?.normalizeIdentity) return window.AuthApp.normalizeIdentity(value);
    let phone = String(value || '').replace(/\D/g, '');
    if (phone.startsWith('00')) phone = phone.slice(2);
    if (phone.length === 9 && /^[3-9]/.test(phone)) phone = '84' + phone;
    if (phone.startsWith('0') && phone.length === 10) phone = '84' + phone.slice(1);
    return phone;
  }

  const err = (e) => { $('#error').textContent = ERR[e?.error] || (e?.error ? window.Security.errText(e.error) : e) || ''; };
  const show = (n) => { ['s1', 's2', 's3'].forEach((k, i) => { $('#' + k).hidden = i + 1 !== n; }); };
  const fmt = (ms) => new Date(ms).toLocaleString('vi-VN');

  async function api(path, body) {
    try {
      const identity = normalizeIdentity(body?.newPhone);
      const device = await window.SecurityDevice.proof(path === '/api/recovery/start' ? identity : body.id, path);
      const r = await fetch(location.origin + path, {
        method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Device-Id': device.deviceId },
        body: JSON.stringify({ ...body, publicKey: device.publicKey, deviceProof: device.deviceProof }),
      });
      const data = await r.json().catch(() => ({}));
      return { ok: r.ok, data };
    } catch (error) {
      return { ok: false, data: { error: ['secure_context_required', 'device_storage_unavailable'].includes(error?.message) ? error.message : 'offline' } };
    }
  }

  function renderStatus(d) {
    const st = $('#st');
    const plcBtn = $('#plc');
    plcBtn.hidden = true;
    clearInterval(timer);
    if (d.status === 'pending_otp') {
      show(2);
      return;
    } else if (d.status === 'pending_review') {
      st.textContent = `Yêu cầu chuyển sang ${d.newPhone} đang chờ quản trị viên duyệt. Chủ tài khoản đã được thông báo.`;
      plcBtn.hidden = !presenceEnabled;
    } else if (d.status === 'cooling') {
      st.textContent = `Yêu cầu chuyển sang ${d.newPhone} đang trong thời gian chờ, dự kiến lúc ${fmt(d.executeAt)}. Sau khi hoàn tất, đăng nhập và thiết lập yếu tố mới trên chính trình duyệt này.`;
      plcBtn.hidden = !presenceEnabled;
    } else if (d.status === 'applied') {
      st.textContent = `Hoàn tất đổi số. Trên chính trình duyệt này, đăng nhập bằng số ${d.newPhone} rồi thiết lập passkey hoặc Authenticator mới. Yếu tố cũ đã được thu hồi.`;
      ls.del();
    } else {
      st.textContent = `Trạng thái: ${d.status}. ${d.status === 'cancelled' || d.status === 'rejected' ? 'Yêu cầu đã bị huỷ/từ chối.' : ''}`;
      ls.del();
    }
    if (d.plcOk) $('#plc-hint').textContent = 'Đã ghi nhận bằng chứng hiện diện.';
    else if (d.plcBit != null) {
      const left = Math.max(0, Math.round((d.plcExpiresAt - Date.now()) / 1000));
      $('#plc-hint').textContent = window.AuthApp?.presenceHint?.(d, left) || `Hoàn tất bước xác minh hiện diện trong ${left} giây.`;
      timer = setInterval(pollPlc, 2000);
    }
  }

  async function refresh() {
    err('');
    const { ok, data } = await api('/api/recovery/status', { id });
    if (!ok) {
      err(data);
      if (data.error === 'request_not_found') { ls.del(); show(1); }
      else { show(3); $('#st').textContent = 'Chưa tải được trạng thái. Yêu cầu đã lưu; hãy thử kiểm tra lại.'; }
      return;
    }
    show(3);
    renderStatus(data);
  }

  async function pollPlc() {
    const { data } = await api('/api/recovery/proof/check', { id });
    if (data.plcOk || data.error) { clearInterval(timer); refresh(); if (data.error) err(data); }
  }

  $('#go1').onclick = async () => {
    err('');
    const { ok, data } = await api('/api/recovery/start', {
      oldPhone: $('#old').value.trim(), newPhone: $('#new').value.trim(), note: $('#note').value.trim(),
    });
    if (!ok) { err(data); return; }
    id = data.id;
    ls.set(id);
    show(2);
  };

  $('#go2').onclick = async () => {
    err('');
    const { ok, data } = await api('/api/recovery/confirm', {
      id, newOtp: $('#otp').value.trim(), recoveryCode: $('#code').value.trim(),
    });
    if (!ok) { err(data); return; }
    refresh();
  };

  $('#plc-go').onclick = async () => {
    err('');
    const { ok, data } = await api('/api/recovery/proof/start', { id });
    if (!ok) { err(data); return; }
    refresh();
  };

  $('#refresh').onclick = refresh;

  async function boot() {
    try {
      const response = await fetch(location.origin + '/api/auth/config');
      const config = await response.json();
      presenceEnabled = response.ok && config.presence === true;
    } catch {}
    if (id) await refresh(); else show(1);
  }
  boot();
})();
