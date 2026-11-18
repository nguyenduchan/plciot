'use strict';
/* "Đang xem": khi webapp đang mở và hiện trên màn hình, báo server mỗi ~20 giây để gateway gửi dữ liệu NHANH (vd. 2 giây).
   Đóng/ẩn tab > ~1 phút thì gateway tự quay về tốc độ lưu của gói (vd. 1 phút) — đỡ tốn băng thông và tải server. */
(function () {
  const EVERY_MS = 20000;
  function session() { try { return JSON.parse(localStorage.getItem('session')); } catch { return null; } }
  let inflight = false;
  async function beat() {
    if (inflight || document.visibilityState !== 'visible') return;
    const s = session();
    if (!s || !s.token) return;
    inflight = true;
    try {
      await fetch(`${s.apiBase || location.origin}/api/viewing`, { method: 'POST', headers: { Authorization: `Bearer ${s.token}` } });
    } catch { /* mất mạng: thử lại lần sau */ }
    finally { inflight = false; }
  }
  setInterval(beat, EVERY_MS);
  document.addEventListener('visibilitychange', beat);
  window.addEventListener('focus', beat);
  window.addEventListener('online', beat);
  beat();
}());
