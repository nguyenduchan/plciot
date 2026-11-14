'use strict';
/**
 * Ảnh trong chat hỗ trợ (dùng chung cho app và trang admin).
 *  ChatImage.prepare(file)           -> Blob JPEG đã thu nhỏ (cạnh dài ≤ 1600px), xoá EXIF/metadata nhờ vẽ lại bằng canvas
 *  ChatImage.attach(container, url, token)   tải ảnh bằng Bearer (thẻ <img> không gửi được header) rồi hiện; bấm để mở ảnh lớn
 * Chỉ ảnh. Không có nút/biểu mẫu thanh toán nào trong khung chat (docs/CHAT-COMPLIANCE.md).
 */
(function () {
  const MAX_SIDE = 1600;
  const MAX_BYTES = 1_800_000;

  async function decode(file) {
    if (window.createImageBitmap) { try { return await createImageBitmap(file); } catch { /* thử cách khác */ } }
    return new Promise((resolve, reject) => {
      const url = URL.createObjectURL(file); const img = new Image();
      img.onload = () => { URL.revokeObjectURL(url); resolve(img); };
      img.onerror = () => { URL.revokeObjectURL(url); reject(new Error('bad_image')); };
      img.src = url;
    });
  }

  async function prepare(file) {
    if (!file || !/^image\//.test(file.type)) throw new Error('bad_image');
    const src = await decode(file);
    const w0 = src.width || src.naturalWidth; const h0 = src.height || src.naturalHeight;
    const k = Math.min(1, MAX_SIDE / Math.max(w0, h0));
    const c = document.createElement('canvas');
    c.width = Math.max(1, Math.round(w0 * k)); c.height = Math.max(1, Math.round(h0 * k));
    const ctx = c.getContext('2d');
    ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, c.width, c.height);   // nền trắng cho PNG trong suốt
    ctx.drawImage(src, 0, 0, c.width, c.height);
    for (const q of [0.85, 0.72, 0.6, 0.45]) {
      const blob = await new Promise((res) => c.toBlob(res, 'image/jpeg', q));
      if (blob && blob.size <= MAX_BYTES) return blob;
    }
    throw new Error('image_too_large');
  }

  async function attach(container, url, token) {
    const holder = document.createElement('div');
    holder.className = 'sup-img'; holder.textContent = 'Đang tải ảnh…';
    container.appendChild(holder);
    try {
      const r = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
      if (!r.ok) throw new Error('x');
      const obj = URL.createObjectURL(await r.blob());
      const img = document.createElement('img');
      img.src = obj; img.alt = 'Ảnh chụp màn hình'; img.className = 'sup-photo';
      img.addEventListener('click', () => zoom(obj));
      holder.textContent = ''; holder.appendChild(img);
    } catch { holder.textContent = 'Không tải được ảnh.'; }
  }

  /** Bấm ảnh trong chat: mở ngay trong trang ở KÍCH THƯỚC GỐC (cuộn để xem phần còn lại).
   *  Bấm vào ảnh để chuyển qua lại "vừa màn hình" ↔ "kích thước gốc"; bấm nền, nút ✕ hoặc Esc để đóng. */
  function zoom(src) {
    document.getElementById('sup-zoom')?.remove();
    const o = document.createElement('div'); o.id = 'sup-zoom';
    const im = document.createElement('img'); im.src = src; im.alt = 'Ảnh kích thước gốc';
    im.addEventListener('click', (e) => { e.stopPropagation(); o.classList.toggle('fit'); });
    const x = document.createElement('button'); x.type = 'button'; x.className = 'sup-zoom-x'; x.textContent = '✕'; x.setAttribute('aria-label', 'Đóng ảnh');
    const close = () => { o.remove(); document.removeEventListener('keydown', onKey); };
    const onKey = (e) => { if (e.key === 'Escape') close(); };
    x.addEventListener('click', (e) => { e.stopPropagation(); close(); });
    o.addEventListener('click', close); document.addEventListener('keydown', onKey);
    o.append(im, x);
    document.body.appendChild(o);
  }

  /** Hiện ngay ảnh cục bộ (trước khi lên máy chủ) để người gửi thấy tin của mình rõ ràng lập tức. */
  function preview(container, objectUrl) {
    const holder = document.createElement('div'); holder.className = 'sup-img';
    const img = document.createElement('img'); img.src = objectUrl; img.alt = 'Ảnh đang gửi'; img.className = 'sup-photo';
    img.addEventListener('click', () => zoom(objectUrl));
    holder.appendChild(img); container.appendChild(holder);
  }

  window.ChatImage = { prepare, attach, preview, zoom };
})();
