'use strict';
/* Trang xem trước toàn bộ icon theo danh mục chuẩn (PlcIcons.catalog). */
(function () {
  const I = window.PlcIcons; if (!I) return;
  let on = true;
  const bar = document.getElementById('bar');
  function drawBar() {
    const cur = I.getStyle();
    const sh = I.getShape();
    bar.dataset.x = 1;
    bar.innerHTML = I.styles.map((s) => `<button type="button" class="${s.id === cur ? 'primary' : 'fit'}" data-s="${s.id}">${s.name}</button>`).join('')
      + `<button type="button" class="${I.getShape() === 'pid' ? 'primary' : 'fit'}" id="shp">Hình: ${I.getShape() === 'pid' ? 'P&ID chuẩn' : 'Minh hoạ'}</button><button type="button" class="fit" id="tog">${on ? 'Đang chạy ▶' : 'Đang dừng ■'}</button>`;
    bar.querySelectorAll('[data-s]').forEach((b) => { b.onclick = () => { I.setStyle(b.dataset.s); drawBar(); }; });
    document.getElementById('shp').onclick = () => I.setShape(I.getShape() === 'pid' ? 'illust' : 'pid');
    document.getElementById('tog').onclick = () => { on = !on; drawBar(); draw(); };
  }
  function draw() {
    const groups = {};
    for (const c of I.catalog) (groups[c.group] ||= []).push(c);
    document.getElementById('catalog').innerHTML = Object.entries(groups).map(([g, list]) => `<h2>${g} (${list.length})</h2><div class="grid">${list.map((c) => `
      <div class="cell"><div class="dev-card cat-${I.category(c.id)}${on ? '' : ' is-off'}" style="border:0;padding:0;background:none;box-shadow:none"><span class="dev-ic">${I.device(c.id, { on, speed: 1.6 })}</span></div>
        <b>${c.vi}</b><code>${c.id}</code><small>${c.anim}</small><small>${c.aliases.slice(0, 5).join(', ')}</small></div>`).join('')}</div>`).join('');
  }
  document.addEventListener('plc-icstyle', () => { drawBar(); draw(); });
  drawBar(); draw();
}());
