/* Bật/tắt cảnh báo nguy hiểm trên điện thoại (Web Push). Server không lưu số điện thoại/email. */
(() => {
  const $ = (id) => document.getElementById(id);
  const msg = (t) => { const el = $('push-msg'); if (el) el.textContent = t; };
  const session = () => { try { return JSON.parse(localStorage.getItem('session') || 'null'); } catch { return null; } };
  const tok = () => session()?.token || '';
  const api = async (path, opt = {}) => {
    const r = await fetch(path, { ...opt, headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${tok()}`, ...(opt.headers || {}) } });
    return { ok: r.ok, status: r.status, body: await r.json().catch(() => ({})) };
  };
  const b64 = (s) => Uint8Array.from(atob(s.replace(/-/g, '+').replace(/_/g, '/')), (c) => c.charCodeAt(0));
  const supported = 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window;

  async function current() {
    if (!supported) return null;
    const reg = await navigator.serviceWorker.ready;
    return reg.pushManager.getSubscription();
  }
  async function refresh() {
    const on = $('push-on'), off = $('push-off'), test = $('push-test');
    if (!on) return;
    if (!supported) { msg('Trình duyệt này chưa hỗ trợ thông báo đẩy. Trên iPhone: bấm Chia sẻ → Thêm vào Màn hình chính rồi mở từ biểu tượng.'); on.hidden = true; return; }
    const sub = await current();
    on.hidden = Boolean(sub); off.hidden = !sub; test.hidden = !sub;
    msg(sub ? 'Đã bật cảnh báo trên thiết bị này.' : (Notification.permission === 'denied' ? 'Bạn đã chặn thông báo cho trang này trong cài đặt trình duyệt.' : 'Chưa bật.'));
  }
  async function enable() {
    try {
      const perm = await Notification.requestPermission();
      if (perm !== 'granted') return refresh();
      const k = await api('/api/push/key');
      if (!k.ok) return msg('Không lấy được khoá từ máy chủ.');
      const reg = await navigator.serviceWorker.ready;
      const sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: b64(k.body.publicKey) });
      const r = await api('/api/push/subscribe', { method: 'POST', body: JSON.stringify({ subscription: sub.toJSON() }) });
      if (!r.ok) { await sub.unsubscribe(); return msg('Máy chủ từ chối đăng ký: ' + (r.body.error || r.status)); }
      refresh();
    } catch (e) { msg('Lỗi: ' + e.message); }
  }
  async function disable() {
    try {
      const sub = await current();
      if (sub) { await api('/api/push/unsubscribe', { method: 'POST', body: JSON.stringify({ endpoint: sub.endpoint }) }); await sub.unsubscribe(); }
      refresh();
    } catch (e) { msg('Lỗi: ' + e.message); }
  }
  async function test() {
    const r = await api('/api/push/test', { method: 'POST', body: '{}' });
    msg(r.ok ? `Đã gửi thử tới ${r.body.sent} thiết bị.` : 'Gửi thử thất bại: ' + (r.body.error || r.status));
  }
  document.addEventListener('DOMContentLoaded', () => {
    $('push-on')?.addEventListener('click', enable);
    $('push-off')?.addEventListener('click', disable);
    $('push-test')?.addEventListener('click', test);
    refresh();
  });
})();
