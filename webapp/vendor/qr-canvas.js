/* Vẽ mã QR lên canvas bằng vendor/qrcode-generator.js (MIT). API tương thích QRCode.toCanvas(canvas, text, {width, margin}). */
(function () {
  if (window.QRCode && window.QRCode.toCanvas) return;
  window.QRCode = {
    toCanvas(canvas, text, o) {
      o = o || {};
      const q = window.qrcode(0, o.errorCorrectionLevel || 'M');
      q.addData(String(text)); q.make();
      const n = q.getModuleCount(), m = o.margin == null ? 2 : o.margin;
      const cell = Math.max(2, Math.floor((o.width || 280) / (n + 2 * m))), size = cell * (n + 2 * m);
      canvas.width = canvas.height = size;
      const c = canvas.getContext('2d');
      c.fillStyle = '#fff'; c.fillRect(0, 0, size, size);
      c.fillStyle = '#000';
      for (let r = 0; r < n; r++) for (let k = 0; k < n; k++) if (q.isDark(r, k)) c.fillRect((k + m) * cell, (r + m) * cell, cell, cell);
      return Promise.resolve(canvas);
    },
  };
})();
