'use strict';
/* Nút QUAY LẠI cửa sổ cha — dùng chung cho mọi trang webapp.
 *  - Cửa sổ nổi (hộp thoại, màn quét QR, chat, ảnh phóng to…): chưa có nút quay lại thì tự thêm "‹ Quay lại" ở góc trên;
 *    nút Back của điện thoại / trình duyệt đóng cửa sổ trên cùng thay vì rời trang.
 *  - Tab con của trang chính (Băng tải, Điều khiển, Báo cáo, Cài đặt): nút "‹" cạnh tiêu đề → về Tổng quan; Back cũng vậy.
 *  - Trang con riêng (vd. admin-settings.html): <body data-parent="admin.html"> → nút "‹ Quay lại" trên đầu trang.
 * Không đổi logic của từng cửa sổ: "quay lại" = bấm đúng nút Huỷ/Đóng sẵn có của cửa sổ đó (để Promise/huỷ camera… chạy như cũ). */
(function () {
  const WINDOWS = '.ctl-modal, .cf-back, .qr-res, .qs, .mq, .chat-view, #sup-zoom';
  // Nút đóng sẵn có của từng loại cửa sổ (thứ tự ưu tiên); không có thì tìm nút chữ Huỷ/Đóng/✕
  const CLOSERS = '[data-back-close], #qs-back, #mq-back, #chat-close, #dev-modal-close, #qr-res-close, .sup-zoom-x, .close';
  const CLOSE_TEXT = /^(huỷ|hủy|đóng|✕|×|quay lại|để sau|bỏ qua)$/i;
  const HAS_BACK = '.nav-back, #qs-back, #mq-back, [aria-label="Quay lại"]';
  const BOX = '.ctl-box, .cf-box, .qr-res-card, .chat-head';

  const css = document.createElement('style');
  css.textContent = `
.nav-back{display:inline-flex;align-items:center;gap:4px;min-height:36px;padding:4px 12px 4px 8px;margin:0 0 8px;border-radius:999px;
  border:1px solid var(--line,#8884);background:var(--card,#fff);color:inherit;font:600 14px/1 inherit;cursor:pointer;width:auto;flex:none}
.nav-back::before{content:'‹';font-size:22px;line-height:1;margin-top:-2px}
.chat-head .nav-back{margin:0 8px 0 0;min-height:32px}
#sup-zoom>.nav-back{position:absolute;top:calc(10px + env(safe-area-inset-top));left:10px;z-index:2}
.hdr-back{display:inline-flex;align-items:center;justify-content:center;width:36px;height:36px;margin:0 6px 0 -6px;padding:0;border-radius:50%;
  border:0;background:transparent;color:inherit;font-size:28px;line-height:1;cursor:pointer;flex:none}
.hdr-back[hidden]{display:none}
.page-back{margin:0 0 10px}`;
  document.head.appendChild(css);

  const isOpen = (el) => el.isConnected && !el.hidden && getComputedStyle(el).display !== 'none' && getComputedStyle(el).visibility !== 'hidden';
  const original = new WeakSet();   // cửa sổ có sẵn trong HTML (đóng = ẩn); cửa sổ tạo bằng JS không có nút đóng thì gỡ khỏi trang
  document.querySelectorAll(WINDOWS).forEach((el) => original.add(el));

  function closer(win) {
    const own = [...win.querySelectorAll(CLOSERS)].find((b) => !b.closest('.nav-back') && isOpen(b));
    if (own) return own;
    return [...win.querySelectorAll('button')].find((b) => !b.classList.contains('nav-back') && isOpen(b) && CLOSE_TEXT.test(b.textContent.trim()));
  }
  function closeWin(win) {
    const b = closer(win);
    if (b) { b.click(); return; }
    if (win.id === 'sup-zoom' || !original.has(win)) win.remove(); else win.hidden = true;
  }

  function ensureBackButton(win) {
    if (win.querySelector(HAS_BACK)) return;
    if (closer(win)) return;   // cửa sổ đã có nút Huỷ/Đóng của chính nó → không thêm nút "Quay lại" thừa (nút Back của máy vẫn đóng được qua closeWin)
    const box = win.querySelector(BOX) || win;
    const b = document.createElement('button');
    b.type = 'button'; b.className = 'nav-back'; b.textContent = 'Quay lại'; b.setAttribute('aria-label', 'Quay lại');
    b.addEventListener('click', (e) => { e.stopPropagation(); closeWin(win); });
    box.prepend(b);
  }

  /* ---------- lịch sử: mỗi cửa sổ / tab con đang mở = một mục; Back đóng cái trên cùng ---------- */
  const stack = [];   // các cửa sổ đang mở theo thứ tự (mới nhất cuối)
  let ignorePop = 0;
  const push = (tag) => { try { history.pushState({ backNav: tag }, ''); } catch { /* trình duyệt chặn */ } };
  const popOwn = () => { if (history.state?.backNav) { ignorePop++; history.back(); } };

  function scan() {
    document.querySelectorAll(WINDOWS).forEach((win) => {
      if (isOpen(win) && !stack.includes(win)) { ensureBackButton(win); stack.push(win); push('win'); }
    });
    for (let i = stack.length - 1; i >= 0; i--) {
      if (!isOpen(stack[i])) { stack.splice(i, 1); popOwn(); }   // đóng bằng nút của chính cửa sổ → bỏ mục lịch sử tương ứng
    }
  }

  /* ---------- tab con của trang chính → về Tổng quan ---------- */
  const nav = document.getElementById('nav');
  const dashBtn = nav?.querySelector('button[data-tab="dash"]');
  const title = document.getElementById('title');
  let hdrBack = null; let tabPushed = false;
  const curTab = () => nav?.querySelector('button.on')?.dataset.tab || 'dash';
  if (nav && dashBtn && title) {
    hdrBack = document.createElement('button');
    hdrBack.type = 'button'; hdrBack.className = 'hdr-back'; hdrBack.textContent = '‹'; hdrBack.hidden = true;
    hdrBack.setAttribute('aria-label', 'Quay lại Tổng quan');
    hdrBack.addEventListener('click', () => dashBtn.click());
    title.before(hdrBack);
  }
  function syncTab() {
    if (!hdrBack) return;
    const sub = curTab() !== 'dash';
    hdrBack.hidden = !sub;
    if (sub && !tabPushed) { tabPushed = true; push('tab'); }
    else if (!sub && tabPushed) { tabPushed = false; popOwn(); }
  }

  window.addEventListener('popstate', () => {
    if (ignorePop > 0) { ignorePop--; return; }
    const top = stack[stack.length - 1];
    if (top) { stack.pop(); closeWin(top); return; }   // đóng cửa sổ trên cùng; nếu nó không đóng được thì lần quét sau thêm lại
    if (hdrBack && curTab() !== 'dash') { tabPushed = false; dashBtn.click(); }
  });

  let queued = false;
  const tick = () => { queued = false; scan(); syncTab(); };
  // setTimeout (không dùng requestAnimationFrame: tab chạy nền / khung xem trước sẽ dừng rAF)
  new MutationObserver(() => { if (!queued) { queued = true; setTimeout(tick, 30); } })
    .observe(document.body, { subtree: true, childList: true, attributes: true, attributeFilter: ['hidden', 'class', 'style', 'open'] });

  /* ---------- trang con riêng: <body data-parent="..."> ---------- */
  function pageBack() {
    const parent = document.body.dataset.parent;
    if (!parent || document.querySelector('.page-back')) return;
    const b = document.createElement('button');
    b.type = 'button'; b.className = 'nav-back page-back'; b.textContent = 'Quay lại'; b.setAttribute('aria-label', 'Quay lại');
    b.addEventListener('click', () => {
      // về đúng trang trước nếu đến từ trang cùng web; mở thẳng (link ngoài / thông báo đẩy) thì về trang cha
      let same = false; try { same = document.referrer && new URL(document.referrer).origin === location.origin; } catch { /* */ }
      if (same && history.length > 1) history.back(); else location.href = parent;
    });
    (document.querySelector('h1') || document.body.firstElementChild)?.before(b);
  }

  const start = () => { pageBack(); tick(); };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start); else start();
}());
