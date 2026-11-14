'use strict';
/* Khoá phóng to bằng hai ngón / chạm đúp trên webapp (giữ cuộn một ngón bình thường). Ảnh trong chat có nút phóng to riêng.
   Kết hợp: viewport maximum-scale=1,user-scalable=no (Android/Chrome) + chặn cử chỉ (iOS Safari bỏ qua user-scalable). */
(function () {
  const stop = (e) => e.preventDefault();
  ['gesturestart', 'gesturechange', 'gestureend'].forEach((t) => document.addEventListener(t, stop, { passive: false }));
  document.addEventListener('touchmove', (e) => { if (e.touches && e.touches.length > 1) e.preventDefault(); }, { passive: false });
  let last = 0;   // chạm đúp để phóng to
  document.addEventListener('touchend', (e) => {
    const now = Date.now();
    if (now - last < 300 && !(e.target.closest && e.target.closest('input,textarea,select,[contenteditable]'))) e.preventDefault();
    last = now;
  }, { passive: false });
  document.addEventListener('wheel', (e) => { if (e.ctrlKey) e.preventDefault(); }, { passive: false });   // pinch trên touchpad
})();
