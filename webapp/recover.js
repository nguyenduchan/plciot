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

  const err = (e) => { $('#error').textContent = ERR[e?.error] || e?.detail || e?.error || e || ''; };
  const show = (n) => { ['s1', 's2', 's3'].forEach((k, i) => { $('#' + k).hidden = i + 1 !== n; }); };
  const fmt = (ms) => new Date(ms).toLocaleString('vi-VN');

  async function api(path, body) {
    const r = await fetch(location.origin + path, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body || {}),
    });
    const data = await r.json().catch(() => ({}));
    return { ok: r.ok, data };
  }

  function renderStatus(d) {
    const st = $('#st');
    const plcBtn = $('#plc');
    plcBtn.hidden = true;
    clearInterval(timer);
    if (d.status === 'pending_review') {
      st.textContent = `Yêu cầu chuyển sang ${d.newPhone} đang chờ quản trị viên duyệt. Chủ tài khoản đã được thông báo.`;
      plcBtn.hidden = false;
    } else if (d.status === 'cooling') {
      st.textContent = `Đã được chấp thuận. Tài khoản sẽ chuyển sang ${d.newPhone} lúc ${fmt(d.executeAt)} nếu chủ tài khoản không huỷ. Sau đó đăng nhập bằng số mới (mật khẩu giữ nguyên, hoặc dùng OTP Telegram).`;
      plcBtn.hidden = false;
    } else if (d.status === 'applied') {
      st.textContent = `Hoàn tất. Hãy đăng nhập bằng số ${d.newPhone} (OTP Telegram).`;
      ls.del();
    } else {
      st.textContent = `Trạng thái: ${d.status}. ${d.status === 'cancelled' || d.status === 'rejected' ? 'Yêu cầu đã bị huỷ/từ chối.' : ''}`;
      ls.del();
    }
    if (d.plcOk) $('#plc-hint').textContent = '✅ Đã ghi nhận bạn có mặt tại thiết bị.';
    else if (d.plcBit != null) {
      const left = Math.max(0, Math.round((d.plcExpiresAt - Date.now()) / 1000));
      $('#plc-hint').textContent = `Hãy kích hoạt đầu vào X${d.plcBit} trên PLC trong ${left} giây…`;
      timer = setInterval(pollPlc, 2000);
    }
  }

  async function refresh() {
    err('');
    const { ok, data } = await api('/api/recovery/status', { id });
    if (!ok) { err(data); ls.del(); show(1); return; }
    show(3);
    renderStatus(data);
  }

  async function pollPlc() {
    const { data } = await api('/api/recovery/plc/check', { id });
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
    const { ok, data } = await api('/api/recovery/plc/start', { id });
    if (!ok) { err(data); return; }
    refresh();
  };

  $('#refresh').onclick = refresh;

  if (id) refresh(); else show(1);
})();
