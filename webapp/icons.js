'use strict';
/**
 * Bộ icon SVG cho thiết bị + giá trị (đồ hoạ vector, đổi màu theo chủ đề, có hiệu ứng khi thiết bị chạy):
 *   bơm/quạt/động cơ quay, nước chảy qua ống/van, bồn có sóng nước, băng tải chạy, đồng hồ áp suất kim dao động.
 * Dùng: PlcIcons.device('pump', { on:true, speed:70 }) → chuỗi <svg>; PlcIcons.value('level') → icon nhỏ cho giá trị.
 * Hiệu ứng bật bằng class "on" trên <svg> (CSS trong style.css), tốc độ quay qua biến --spin. Tôn trọng prefers-reduced-motion.
 */
(function () {
  const S = (inner, cls = '') => `<svg class="ic ${cls}" viewBox="0 0 48 48" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${inner}</svg>`;

  const DEVICE = {
    pump: () => S(`<path d="M4 30h9M26 13V6h14"/><circle cx="26" cy="30" r="13"/><g class="ic-rot"><path d="M26 30l0-9M26 30l9 0M26 30l0 9M26 30l-9 0"/><circle cx="26" cy="30" r="2.6" fill="currentColor" stroke="none"/></g><path class="ic-flow" d="M5 30h7M30 6h9"/><path d="M12 43h28"/>`),
    fan: () => S(`<circle cx="24" cy="24" r="19"/><g class="ic-rot"><path d="M24 24c-1-8 2-13 8-13 4 0 4 6 0 9zM24 24c8-1 13 2 13 8 0 4-6 4-9 0zM24 24c1 8-2 13-8 13-4 0-4-6 0-9zM24 24c-8 1-13-2-13-8 0-4 6-4 9 0z"/></g><circle cx="24" cy="24" r="2.4" fill="currentColor" stroke="none"/>`),
    tank: () => S(`<path d="M10 10c0-3 28-3 28 0v28c0 3-28 3-28 0z"/><path d="M10 10c0 3 28 3 28 0"/><g class="ic-water"><path d="M10 26c4-3 7 3 11 0s7 3 11 0 4-1 6 0v12c0 3-28 3-28 0z" fill="currentColor" fill-opacity=".28" stroke="none"/><path class="ic-wave" d="M10 26c4-3 7 3 11 0s7 3 11 0 4-1 6 0"/></g><path d="M44 18h-3M44 26h-3M44 34h-3"/>`),
    valve: () => S(`<path d="M3 30h10M35 30h10"/><path d="M13 20l11 10-11 10zM35 20L24 30l11 10z"/><path d="M24 30V14M16 12h16"/><path class="ic-flow" d="M4 30h8M36 30h8"/>`),
    motor: () => S(`<rect x="7" y="13" width="26" height="22" rx="4"/><path d="M13 13v22M19 13v22M25 13v22"/><path d="M33 24h5"/><g class="ic-rot"><circle cx="41" cy="24" r="4"/><path d="M41 20v8M37 24h8"/></g><path d="M10 35v5M30 35v5M6 40h28"/>`),
    env: () => S(`<path d="M20 28V10a4 4 0 0 1 8 0v18a8 8 0 1 1-8 0z"/><circle cx="24" cy="35" r="3.2" fill="currentColor" stroke="none"/><path class="ic-pulse" d="M24 32V16"/><path d="M33 12h5M33 19h3M33 26h5"/>`),
    humidity: () => S(`<path d="M24 5C17 15 12 21 12 29a12 12 0 0 0 24 0c0-8-5-14-12-24z"/><path class="ic-pulse" d="M19 31a5 5 0 0 0 5 5"/>`),
    energy: () => S(`<circle cx="24" cy="24" r="19"/><path class="ic-pulse" d="M27 8L15 27h9l-3 13 12-19h-9z" fill="currentColor" fill-opacity=".2"/>`),
    pressure: () => S(`<path d="M7 36a19 19 0 1 1 34 0"/><path d="M12 36h24"/><g class="ic-needle"><path d="M24 34L33 20"/><circle cx="24" cy="34" r="2.8" fill="currentColor" stroke="none"/></g><path d="M11 24l3 2M24 10v4M37 24l-3 2"/>`),
    conveyor: () => S(`<rect x="4" y="26" width="40" height="11" rx="5.5"/><g class="ic-rot"><circle cx="10" cy="31.5" r="2"/></g><g class="ic-rot"><circle cx="38" cy="31.5" r="2"/></g><g class="ic-belt"><rect x="9" y="14" width="9" height="9" rx="1.5"/><rect x="27" y="14" width="9" height="9" rx="1.5"/></g><path d="M10 41v3M38 41v3"/>`),
    flow: () => S(`<path class="ic-flow" d="M4 16c4-4 8 4 12 0s8 4 12 0 8 4 12 0M4 26c4-4 8 4 12 0s8 4 12 0 8 4 12 0M4 36c4-4 8 4 12 0s8 4 12 0 8 4 12 0"/>`),
    gauge: () => S(`<path d="M7 36a19 19 0 1 1 34 0"/><g class="ic-needle"><path d="M24 34l8-12"/><circle cx="24" cy="34" r="2.8" fill="currentColor" stroke="none"/></g>`),
    power: () => S(`<path d="M24 6v18"/><path d="M14 12a16 16 0 1 0 20 0"/>`),
    clock: () => S(`<circle cx="24" cy="24" r="19"/><path d="M24 13v11l7 5"/>`),
    bulb: () => S(`<path d="M17 33c0-3-5-5-5-12a12 12 0 0 1 24 0c0 7-5 9-5 12z"/><path d="M18 39h12M20 44h8"/><path class="ic-pulse" d="M24 12v9"/>`),
    relay: () => S(`<circle cx="10" cy="30" r="3"/><circle cx="38" cy="30" r="3"/><path d="M13 30h8M35 30h-8"/><path class="ic-sw" d="M21 30l12-12"/>`),
    di: () => S(`<rect x="6" y="6" width="36" height="36" rx="6"/><path d="M24 14v16M17 24l7 7 7-7"/><path d="M15 37h18"/>`),
    do: () => S(`<rect x="6" y="6" width="36" height="36" rx="6"/><path d="M24 34V18M17 24l7-7 7 7"/><path d="M15 11h18"/>`),
    sensor: () => S(`<circle cx="24" cy="24" r="5"/><path class="ic-pulse" d="M14 14a14 14 0 0 0 0 20M34 14a14 14 0 0 1 0 20M8 8a22 22 0 0 0 0 32M40 8a22 22 0 0 1 0 32"/>`),
    gear: () => S(`<g class="ic-rot"><circle cx="24" cy="24" r="6"/><path d="M24 4v6M24 38v6M4 24h6M38 24h6M9.9 9.9l4.2 4.2M33.9 33.9l4.2 4.2M9.9 38.1l4.2-4.2M33.9 14.1l4.2-4.2"/></g><circle cx="24" cy="24" r="13"/>`),
  };
  // khoá icon gateway/loại thiết bị → icon
  const ALIAS = { switch: 'relay', light: 'bulb', custom: 'gear', generic: 'gear', 'iot-hub': 'gear', dynamic: 'gear', temperature: 'env', thermo: 'env' };
  // khoá giá trị (key field MQTT) → icon nhỏ mô tả giá trị
  const VALUE = [
    [/^(level|lvl|muc|water)/i, 'tank'], [/^(t|temp|nhiet)/i, 'env'], [/^(h|hum|do_am)/i, 'humidity'], [/(flow|luu)/i, 'flow'],
    [/^(p|press|ap_suat)/i, 'pressure'], [/(speed|rpm|freq|^sp$|toc)/i, 'gauge'], [/(^kw|power|cong_suat|^kwh|energy|^v$|volt|^a$|amp|current)/i, 'energy'],
    [/(hours|time|gio|runtime)/i, 'clock'], [/(^run|^q_|^on$|state|start|enable|bat)/i, 'power'], [/(count|cnt|dem)/i, 'conveyor'],
  ];

  function pick(name) { const n = String(name || '').toLowerCase(); return DEVICE[n] ? n : (DEVICE[ALIAS[n]] ? ALIAS[n] : 'gear'); }
  function device(name, opt = {}) {
    const html = DEVICE[pick(name)]();
    return html.replace('class="ic ', `class="ic ${opt.on ? 'on ' : ''}`).replace('<svg ', `<svg ${opt.speed != null ? `style="--spin:${opt.speed}s" ` : ''}`);
  }
  /** Icon nhỏ cho một giá trị theo khoá field (level → giọt nước, temp → nhiệt kế…). */
  function value(key, kind) {
    const k = String(key || '');
    const hit = VALUE.find(([re]) => re.test(k));
    const name = hit ? hit[1] : (kind === 'slider' ? 'gauge' : kind === 'toggle' ? 'power' : 'sensor');
    return DEVICE[name]();
  }
  /** Quy đổi giá trị tốc độ (0–100) thành chu kỳ quay (giây): càng nhanh càng ngắn. */
  const spinSeconds = (pct) => (pct == null || !(pct > 0) ? 2.4 : Math.max(0.45, 3.2 - (Math.min(100, pct) / 100) * 2.75)).toFixed(2);

  window.PlcIcons = { device, value, pick, spinSeconds, names: Object.keys(DEVICE) };
}());

/* ===== Kiểu hiển thị: người dùng chọn (lưu trên máy này) =====
 *   3d    — đẹp: ô icon nổi khối 3D, đổ bóng, hiệu ứng chuyển động (quay, nước chảy, sóng…)
 *   line  — hiện đại: icon nét mảnh phẳng có hiệu ứng chuyển động
 *   scada — SCADA: icon tĩnh, phẳng, không chuyển động; màu xanh = chạy, xám = dừng */
(function () {
  const STYLES = [
    { id: '3d', name: 'Đẹp (3D)', desc: 'Icon nổi khối, đổ bóng, có hiệu ứng quay / nước chảy' },
    { id: 'line', name: 'Hiện đại', desc: 'Icon nét mảnh, có hiệu ứng chuyển động' },
    { id: 'scada', name: 'SCADA', desc: 'Icon tĩnh, phẳng, màu theo trạng thái chạy / dừng' },
  ];
  const KEY = 'icStyle';
  const get = () => { try { const v = localStorage.getItem(KEY); return STYLES.some((s) => s.id === v) ? v : '3d'; } catch { return '3d'; } };
  function set(id) {
    if (!STYLES.some((s) => s.id === id)) return;
    try { localStorage.setItem(KEY, id); } catch { /* */ }
    document.documentElement.dataset.icStyle = id;
    render();
  }
  function render() {
    const host = document.getElementById('ic-choices');
    if (!host || !window.PlcIcons) return;
    const cur = get();
    host.innerHTML = STYLES.map((s) => `<button type="button" class="ic-choice${s.id === cur ? ' on' : ''}" data-ic="${s.id}" aria-pressed="${s.id === cur}">
      <span class="ic-prev" data-ic-style="${s.id}"><span class="dev-ic">${window.PlcIcons.device('pump', { on: true, speed: 1.2 })}</span><span class="dev-ic">${window.PlcIcons.device('tank', { on: true })}</span><span class="dev-ic">${window.PlcIcons.device('fan', { on: true, speed: 0.9 })}</span></span>
      <b>${s.name}</b><small>${s.desc}</small></button>`).join('');
    host.querySelectorAll('.ic-choice').forEach((b) => { b.onclick = () => set(b.dataset.ic); });
  }
  document.documentElement.dataset.icStyle = get();
  document.addEventListener('DOMContentLoaded', render);
  window.PlcIcons = Object.assign(window.PlcIcons || {}, { styles: STYLES, getStyle: get, setStyle: set });
}());
