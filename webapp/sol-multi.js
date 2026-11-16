/* Giao diện theo GATEWAY: loại webapp do gateway quyết định (không theo user). Bundle của user chứa shell + giao diện của mọi
 * giải pháp mà các gateway của họ dùng (sol/<id>/…, bản khai solutions.json). devices.js phát 'plc-gw-active' khi người dùng chọn
 * tab gateway → ở đây gỡ giao diện cũ, nạp CSS/spec của giải pháp gateway đó và gắn engine (industry.js) chỉ với số liệu của gateway đó.
 * Gateway không có giải pháp (hoặc cơ bản) → bản shell cơ bản. */
(function () {
  let manifest = null, loading = null;
  const loadManifest = () => manifest ? Promise.resolve(manifest)
    : (loading = loading || fetch('solutions.json', { cache: 'no-cache' }).then((r) => (r.ok ? r.json() : {})).catch(() => ({}))
      .then((m) => { manifest = m && typeof m === 'object' ? m : {}; document.dispatchEvent(new Event('plc-sol-manifest')); return manifest; }));

  const loadJs = (src) => new Promise((res) => {
    const s = document.createElement('script');
    s.src = src; s.async = false; s.dataset.sol = '1';
    s.onload = () => res(true); s.onerror = () => res(false);
    document.body.appendChild(s);
  });
  const clearCss = () => document.querySelectorAll('link[data-sol]').forEach((l) => l.remove());
  const setCss = (list) => { clearCss(); for (const href of list || []) { const l = document.createElement('link'); l.rel = 'stylesheet'; l.href = href; l.dataset.sol = '1'; document.head.appendChild(l); } };
  const themeMeta = () => document.querySelector('meta[name="theme-color"]');
  const baseTheme = themeMeta()?.content || '';

  /* Mỗi gateway có giải pháp đều có một engine: gateway đang chọn chạy đầy đủ (hiện giao diện), các gateway còn lại chạy NGẦM
   * (chỉ theo dõi số liệu/cảnh báo) để tổng cảnh báo chưa xem không bỏ sót gateway nào. */
  const specs = {}, inst = new Map();   // specs: id → spec đã nạp; inst: base → { id, full, h }
  let token = 0, queue = Promise.resolve();
  const dropAll = () => { for (const i of inst.values()) { try { i.h?.unmount(); } catch (e) { console.warn('sol unmount', e); } } inst.clear(); };
  const unmountOne = (base) => { const i = inst.get(base); if (i) { try { i.h?.unmount(); } catch (e) { console.warn('sol unmount', e); } inst.delete(base); } };
  async function ensureSpec(id, m, my) {
    if (specs[id]) return true;
    for (const src of m.js || []) {
      if (/(^|\/)industry\.js(\?|$)/.test(src) && window.IndustryEngine) continue;   // engine dùng chung: nạp một lần
      await loadJs(src);
      if (my !== token) return false;
    }
    if (!window.INDUSTRY) return false;
    specs[id] = window.INDUSTRY;
    return true;
  }
  async function run(all, active, my) {
    if (my !== token) return;
    const man = await loadManifest();
    if (my !== token) return;
    const want = new Map();   // base → id
    for (const g of all) if (g.base && g.solution && man[g.solution]) want.set(g.base, g.solution);
    for (const base of [...inst.keys()]) if (want.get(base) !== inst.get(base).id) unmountOne(base);   // gateway mất / đổi giải pháp
    const am = active?.solution && man[active.solution] ? man[active.solution] : null;
    setCss(am?.css || []);
    const t = themeMeta(); if (t && baseTheme) t.content = (am && am.themeColor) || baseTheme;
    // gỡ engine đầy đủ cũ nếu không còn là gateway đang chọn, rồi dựng lại ở chế độ ngầm
    for (const [base, i] of [...inst]) if (i.full !== (base === active?.base)) unmountOne(base);
    for (const [base, id] of want) {
      if (inst.has(base)) continue;
      if (!(await ensureSpec(id, man[id], my))) { if (my !== token) return; continue; }
      if (my !== token || !window.IndustryEngine) return;
      const full = base === active?.base;
      inst.set(base, { id, full, h: window.IndustryEngine.mount(specs[id], { base, headless: !full }) });
    }
  }

  document.addEventListener('plc-gw-active', (e) => {
    const my = ++token, all = e.detail?.all || [], active = e.detail?.gw || null;
    queue = queue.then(() => run(all, active, my)).catch((err) => console.warn('sol-multi', err));
  });
  window.SolMulti = { title: (id) => (id && manifest?.[id]?.title) || '' };
  loadManifest();
})();
