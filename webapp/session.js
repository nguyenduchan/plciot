'use strict';
/*
 * Token đăng nhập ngắn hạn (72 giờ) nhưng gia hạn trượt: khi đang dùng, server gửi token mới trong header
 * X-Renewed-Token và file này cập nhật localStorage. Nạp TRƯỚC mọi script khác.
 */
(function () {
  const orig = window.fetch;
  window.fetch = async function renewingFetch(...args) {
    const res = await orig.apply(this, args);
    try {
      const t = res.headers.get('X-Renewed-Token');
      if (t) {
        const s = JSON.parse(localStorage.getItem('session'));
        if (s && !s.demo && s.token) { s.token = t; localStorage.setItem('session', JSON.stringify(s)); }
      }
    } catch {}
    return res;
  };
}());
