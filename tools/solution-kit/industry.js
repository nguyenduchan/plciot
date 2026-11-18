'use strict';
/* Engine giao diện "giải pháp ngành" (lớp phủ lên webapp cơ bản). Đọc cấu hình window.INDUSTRY (file spec.js của giải pháp):
 *   - Tổng quan: khối giao diện theo ngành chèn lên đầu tab Thiết bị (thẻ thiết bị + điều khiển của bản cơ bản vẫn nằm bên dưới)
 *   - Thêm tab theo ngành, tab Thiết bị, tab Cảnh báo (ngưỡng theo từng chỉ số)
 * Dùng đúng luồng số liệu của bản cơ bản (DevicesUi.onTelemetry, d.<thiết bị>.<field>, schema 2). Đăng nhập, quét QR, cài đặt, chat, gói… là mã bản cơ bản.
 * Mã này giống hệt ở mọi giải pháp (tools/solution-kit/industry.js → solutions/<id>/webapp/industry.js bằng tools/solution-kit/gen.mjs). */
window.IndustryEngine = (function () {
const STORE = {};   // trạng thái cảnh báo theo gateway: giữ nguyên khi chuyển tab gateway (gắn/gỡ giao diện)
function mount(S, opts) {   // mount(spec, { base }): base = topic gateway (gw/<id>) — chỉ nhận số liệu + thiết bị của gateway đó; unmount() dọn sạch để gắn giải pháp khác
  const GW = (opts && opts.base) || '';
  const HL = !!(opts && opts.headless);   // chạy ngầm (không hiện): chỉ để theo dõi cảnh báo của gateway không đang mở
  const ROOT = HL ? document.createElement('div') : document;
  let dead = false;
  const dash = HL ? document.createElement('div') : document.getElementById('tab-dash');
  const nav = HL ? document.createElement('div') : document.getElementById('nav');
  const main = HL ? document.createElement('div') : document.querySelector('main');
  if (HL) ROOT.append(dash, nav, main);
  if (!S || !dash || !nav || !main) return null;
  if (!HL) document.documentElement.dataset.ind = S.style || 'soft';

  const $ = (s, r = ROOT) => r.querySelector(s);
  const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
  const num = (x) => { const n = Number(x); return x != null && x !== '' && typeof x !== 'boolean' && Number.isFinite(n) ? n : null; };
  const fmt = (v, d) => (v == null ? '—' : (d == null ? (Math.abs(v) >= 100 ? v.toFixed(0) : Math.abs(v) >= 10 ? v.toFixed(1) : v.toFixed(2)) : v.toFixed(d)).replace(/\.0+$/, ''));
  const STALE_MS = 30000;

  /* ------------------------------------------------------------------ chỉ số (metric) */
  const M = {};
  for (const m of S.metrics || []) M[m.id] = { agg: 'last', ...m };
  const keyList = (m) => (m.keys || [m.id]).map((k) => (Array.isArray(k) ? [k[0].toLowerCase(), k[1]] : [String(k).toLowerCase(), 1]));
  const devs = new Map();            // childId → { v: {field: giá trị}, ts }
  let lastTs = 0;

  let depth = 0;   // chống công thức tham chiếu vòng
  // Chỉ số suy diễn (expr): tính ngay tại webapp từ số cảm biến, KHÔNG gửi qua server. Tên trong công thức: chỉ số khác, field thô, hoặc "thiết_bị.field".
  const calc = (m, getMetric, getRaw) => {
    if (depth > 6) return null;
    depth++;
    try {
      return IndExpr.eval(m.expr, (name) => {
        const k = name.toLowerCase(), id = M[name] ? name : (M[k] ? k : null);
        if (id && id !== m.id) return getMetric(M[id]);
        if (k.includes('.')) { const [d, f] = k.split('.'); const r = [...devs].find(([i]) => i.toLowerCase() === d)?.[1]; return r ? num(r.v[f]) : null; }
        return getRaw(k);
      });
    } finally { depth--; }
  };
  const own = (rec, m) => {
    if (m.expr) return calc(m, (x) => own(rec, x), (k) => num(rec.v[k]));
    for (const [k, mul] of keyList(m)) { const n = num(rec.v[k]); if (n != null) return n * mul; } return null;
  };
  // Khối liệt kê THEO THIẾT BỊ chỉ gồm thiết bị có field GẮN vào khối đó (tên field trùng khoá chỉ số) — thiết bị khác của gateway
  // (vd. động cơ phụ trong giải pháp thủy sản) không chen vào danh sách ao, nó hiện thành widget riêng ở khung thiết bị
  const hasAny = (id, ms) => { const r = devs.get(id); return !!r && ms.some((m) => m && (m.expr ? own(r, m) != null : keyList(m).some(([k]) => k in r.v))); };
  const idsFor = (b, ms) => [...devs.keys()].filter((id) => (!b.only || b.only.includes(id)) && (!ms.filter(Boolean).length || hasAny(id, ms)));
  function value(m, recs) {
    if (m.expr) return calc(m, (x) => value(x, recs), (k) => { let v = null; for (const r of recs) { const n = num(r.v[k]); if (n != null) v = n; } return v; });
    const xs = [];
    for (const r of recs) { const n = own(r, m); if (n != null) xs.push(n); }
    if (!xs.length) return null;
    switch (m.agg) {
      case 'sum': return xs.reduce((a, b) => a + b, 0);
      case 'avg': return xs.reduce((a, b) => a + b, 0) / xs.length;
      case 'max': return Math.max(...xs);
      case 'min': return Math.min(...xs);
      case 'count': return xs.filter((x) => x > 0).length;
      default: return xs[xs.length - 1];
    }
  }
  const live = () => [...devs.values()].filter((r) => Date.now() - r.ts < STALE_MS * 4);
  const val = (id) => (M[id] ? value(M[id], live()) : null);

  // trạng thái theo ngưỡng: ok | warn | bad
  function level(m, v) {
    if (v == null || !m.th) return '';
    const t = m.th;
    if ((t.hiHi != null && v >= t.hiHi) || (t.loLo != null && v <= t.loLo)) return 'bad';
    if ((t.hi != null && v >= t.hi) || (t.lo != null && v <= t.lo)) return 'warn';
    return 'ok';
  }
  const stateText = (m, v) => {
    if (v == null) return '—';
    if (m.map) return m.map[String(Math.round(v))] ?? String(v);
    return fmt(v, m.dec);
  };
  const stateLevel = (m, v) => (m.lv ? m.lv[String(Math.round(v))] || '' : level(m, v));

  /* ------------------------------------------------------------------ lịch sử ngắn (xu hướng) */
  const HIST = {}, HMAX = 90;
  const pushHist = (id, v) => { if (v == null) return; const a = HIST[id] || (HIST[id] = []); a.push(v); if (a.length > HMAX) a.shift(); };
  let lastHist = 0;
  function sample(now) {
    if (now - lastHist < 2000) return;
    lastHist = now;
    for (const id of Object.keys(M)) pushHist(id, val(id));
  }

  /* ------------------------------------------------------------------ cảnh báo (nhật ký trong bộ nhớ) */
  const ST = STORE[GW] || (STORE[GW] = { ALM: [], prevLv: {}, unseen: 0 });
  const ALM = ST.ALM, prevLv = ST.prevLv;   // ALM: { ts, id, level, text }
  const announce = () => document.dispatchEvent(new CustomEvent('plc-ind-unseen', { detail: { base: GW, n: ST.unseen } }));
  function drawBadge() {
    const b = btns.alm; if (!b) return;
    let t = b.querySelector('.ind-badge');
    if (!ST.unseen) { t?.remove(); return; }
    if (!t) { t = document.createElement('i'); t.className = 'ind-badge'; b.appendChild(t); }
    t.textContent = ST.unseen > 99 ? '99+' : String(ST.unseen);
  }
  function alarmScan(now) {
    for (const m of Object.values(M)) {
      if (!m.th && !m.lv) continue;
      const v = val(m.id), lv = m.lv ? stateLevel(m, v) : level(m, v);
      const was = prevLv[m.id] || 'ok';
      if (v != null && lv !== (was || 'ok') && (lv === 'warn' || lv === 'bad' || was === 'warn' || was === 'bad')) {
        ALM.unshift({ ts: now, id: m.id, level: lv === 'ok' || lv === '' ? 'ok' : lv, text: `${m.label}: ${stateText(m, v)}${m.unit ? ' ' + m.unit : ''}` });
        if (ALM.length > 60) ALM.pop();
        if ((lv === 'warn' || lv === 'bad') && !(MINE.alm && !MINE.alm.hidden)) { ST.unseen++; drawBadge(); announce(); }   // cảnh báo mới chưa xem
      }
      if (v != null) prevLv[m.id] = lv || 'ok';
    }
  }
  const active = () => Object.values(M).map((m) => ({ m, v: val(m.id) })).map((x) => ({ ...x, lv: x.m.lv ? stateLevel(x.m, x.v) : level(x.m, x.v) })).filter((x) => x.lv === 'warn' || x.lv === 'bad');

  /* ------------------------------------------------------------------ khối giao diện */
  const unitOf = (m) => (m.unit ? `<small>${esc(m.unit)}</small>` : '');
  const mget = (id) => M[id] || { id, label: id };
  // icon ĐẠI LƯỢNG ĐO (cùng luật với gateway C#, xem metric-icons.js): nhiệt kế cho °C, đồng hồ áp cho bar, giọt nước cho độ ẩm…
  const QI = window.PlcQIcons;
  const icOf = (m) => (m._ic ||= (m.icon && QI?.has(m.icon) ? m.icon : QI ? QI.forMetric(m) : 'chart'));
  const qi = (m, cls) => (QI ? QI.svg(icOf(m), cls) : '');
  const svgI = (n) => (QI ? QI.svg(QI.has(n) ? n : 'chart') : '');
  // icon THIẾT BỊ (bộ icon nét của webapp, giống GatewayApp) cho danh sách thiết bị; không có bộ icon thì dùng icon giải pháp
  const devIcon = (meta, id) => (window.PlcIcons?.device ? window.PlcIcons.device(window.PlcIcons.pick(meta?.icon, meta?.type, meta?.title, titleOf(id), id), { style: 'line' }) : svgI(S.icon));

  function bKpis(b) {
    return `<div class="ik-grid c${b.cols || 0}">` + b.items.map((id) => {
      const m = mget(id), v = val(id), lv = level(m, v);
      return `<div class="ik ${lv}"><i class="ik-ic">${qi(m)}</i><span>${esc(m.label)}</span><b>${esc(stateText(m, v))}</b> ${unitOf(m)}</div>`;
    }).join('') + '</div>';
  }

  function arc(cx, cy, r, a0, a1) {
    const p = (a) => [cx + r * Math.cos(a), cy + r * Math.sin(a)];
    const [x0, y0] = p(a0), [x1, y1] = p(a1);
    return `M${x0.toFixed(1)} ${y0.toFixed(1)}A${r} ${r} 0 ${a1 - a0 > Math.PI ? 1 : 0} 1 ${x1.toFixed(1)} ${y1.toFixed(1)}`;
  }
  function gaugeSvg(m, v, mini) {
    const min = m.min ?? 0, max = m.max ?? 100, f = v == null ? 0 : Math.max(0, Math.min(1, (v - min) / (max - min || 1)));
    const lv = level(m, v), A0 = Math.PI * 0.8, A1 = Math.PI * 2.2, a = A0 + (A1 - A0) * f;
    return `<svg viewBox="0 0 120 100" class="ig ${lv}"><path class="trk" d="${arc(60, 58, 44, A0, A1)}"/>`
      + (v == null ? '' : `<path class="val" d="${arc(60, 58, 44, A0, Math.max(A0 + 0.01, a))}"/>`)
      + `<text class="n" x="60" y="${mini ? 62 : 60}" text-anchor="middle">${esc(stateText(m, v))}</text><text class="u" x="60" y="76" text-anchor="middle">${esc(m.unit || '')}</text></svg>`;
  }
  function bGauges(b) {
    return `<div class="ig-grid c${Math.min(4, b.items.length)}">` + b.items.map((id) => {
      const m = mget(id);
      return `<div class="igw">${gaugeSvg(m, val(id))}<span>${qi(m, 'qi-in')}${esc(m.label)}</span></div>`;
    }).join('') + '</div>';
  }

  function tankSvg(m, v, label) {
    const min = m.min ?? 0, max = m.max ?? 100, f = v == null ? 0 : Math.max(0, Math.min(1, (v - min) / (max - min || 1)));
    const lv = level(m, v), H = 92, y = 8 + H * (1 - f);
    return `<div class="itk ${lv}"><svg viewBox="0 0 80 110"><rect class="body" x="10" y="8" width="60" height="${H}" rx="8"/>`
      + `<clipPath id="c${esc(m.id)}${esc(label || '')}"><rect x="10" y="8" width="60" height="${H}" rx="8"/></clipPath>`
      + `<g clip-path="url(#c${esc(m.id)}${esc(label || '')})"><rect class="fill" x="10" y="${y.toFixed(1)}" width="60" height="${(H * f + 2).toFixed(1)}"/>`
      + `<path class="wave" d="M10 ${y.toFixed(1)} q10 -5 20 0 t20 0 t20 0 t20 0 v4 h-80z"/></g>`
      + `<text class="n" x="40" y="62" text-anchor="middle">${esc(stateText(m, v))}</text><text class="u" x="40" y="76" text-anchor="middle">${esc(m.unit || '')}</text></svg>`
      + `<span>${esc(label || m.label)}</span></div>`;
  }
  function bTank(b) {
    return `<div class="itk-grid">` + b.items.map((id) => tankSvg(mget(id), val(id))).join('') + '</div>';
  }

  // mỗi thiết bị một bồn (bồn xăng dầu, bể nước…)
  function bTanks(b) {
    const m = mget(b.main);
    const ids = idsFor(b, [m]);
    return `<div class="itk-grid">` + ids.map((id) => tankSvg(m, own(devs.get(id), m), titleOf(id))).join('') + '</div>';
  }

  function bState(b) {
    return `<div class="ist">` + b.items.map((id) => {
      const m = mget(id), v = val(id), lv = v == null ? '' : (m.lv ? stateLevel(m, v) : (num(v) > 0 ? 'ok' : 'off'));
      return `<span class="ichip ${lv}">${qi(m, 'qi-st')}${esc(m.label)}: <b>${esc(stateText(m, v))}</b></span>`;
    }).join('') + '</div>';
  }

  function bBars(b) {
    return `<div class="ib">` + b.items.map((id) => {
      const m = mget(id), v = val(id), min = m.min ?? 0, max = m.max ?? 100, f = v == null ? 0 : Math.max(0, Math.min(1, (v - min) / (max - min || 1)));
      return `<div class="ib-r ${level(m, v)}"><span>${qi(m, 'qi-in')}${esc(m.label)}</span><div class="ib-t"><div style="width:${(f * 100).toFixed(1)}%"></div></div><div class="ib-v"><b>${esc(stateText(m, v))}</b> ${unitOf(m)}</div></div>`;
    }).join('') + '</div>';
  }

  function bTrend(b) {
    const m = mget(b.metric), a = HIST[b.metric] || [];
    const W = 300, H = 70;
    let path = '', area = '', lo = null, hi = null;
    if (a.length > 1) {
      lo = Math.min(...a); hi = Math.max(...a);
      const span = hi - lo || 1;
      const pts = a.map((v, i) => [(i / (HMAX - 1)) * W + (W - ((a.length - 1) / (HMAX - 1)) * W), H - 6 - ((v - lo) / span) * (H - 14)]);
      path = 'M' + pts.map((p) => p[0].toFixed(1) + ' ' + p[1].toFixed(1)).join('L');
      area = path + `L${pts[pts.length - 1][0].toFixed(1)} ${H}L${pts[0][0].toFixed(1)} ${H}z`;
    }
    return `<div class="itr"><div class="itr-h"><b>${qi(m, 'qi-in')}${esc(b.title || m.label)}</b><span>${esc(stateText(m, val(b.metric)))} ${esc(m.unit || '')}</span></div>`
      + `<svg viewBox="0 0 ${W} ${H}" preserveAspectRatio="none"><path class="ar" d="${area}"/><path class="ln" d="${path}"/></svg>`
      + `<div class="itr-f"><span>${lo == null ? '' : 'min ' + fmt(lo, m.dec)}</span><span>${hi == null ? 'Chờ dữ liệu…' : 'max ' + fmt(hi, m.dec)}</span></div></div>`;
  }

  // thẻ theo từng thiết bị (vùng, phòng lạnh, trụ sạc, bồn…): chỉ số chính to + chỉ số phụ, màu theo ngưỡng của chỉ số chính
  function titleOf(id) {
    try { const d = (window.DevicesUi?.getDashboard?.()?.devices || []).find((x) => x.childId === id); if (d?.title) return d.title; } catch { /* */ }
    return (S.demo?.devices?.[id]?.title) || id;
  }
  function bTiles(b) {
    const main = mget(b.main), subs = (b.subs || []).map(mget);
    const ids = idsFor(b, [main, ...subs]);
    if (!ids.length) return '<p class="muted">Chưa có thiết bị. Thêm thiết bị bằng mã QR ở tab Thiết bị.</p>';
    return `<div class="it-grid">` + ids.map((id) => {
      const r = devs.get(id), v = own(r, main), lv = main.lv ? stateLevel(main, v) : level(main, v);
      const off = Date.now() - r.ts > STALE_MS;
      return `<div class="it ${off ? 'offl' : lv}"><div class="it-h"><b>${esc(titleOf(id))}</b><i></i></div>`
        + `<div class="it-v">${qi(main, 'it-ic')}${esc(stateText(main, v))} ${unitOf(main)}</div><div class="it-l">${esc(main.label)}</div>`
        // chỉ số phụ: icon nói lên đại lượng (nhãn đầy đủ khi rê chuột) + số — gọn trên điện thoại, giống GatewayApp
        + (subs.length ? '<div class="it-s">' + subs.map((s) => { const sv = own(r, s); return `<span class="${level(s, sv)}" title="${esc(s.label)}">${qi(s, 'qi-in')}<b>${esc(stateText(s, sv))}</b>${s.unit ? ' ' + esc(s.unit) : ''}</span>`; }).join('') + '</div>' : '')
        + '</div>';
    }).join('') + '</div>';
  }

  // dây chuyền: các trạm nối tiếp bằng mũi tên chạy, màu theo trạng thái
  function bLine(b) {
    const st = mget(b.state), ids = idsFor(b, [st]);
    if (!ids.length) return '';
    return `<div class="il">` + ids.map((id, i) => {
      const r = devs.get(id), v = own(r, st), lv = stateLevel(st, v) || 'off';
      return (i ? `<div class="il-a ${lv === 'ok' ? 'run' : ''}"><i></i></div>` : '')
        + `<div class="il-s ${lv}"><b>${esc(titleOf(id))}</b><span>${esc(stateText(st, v))}</span>${b.sub ? `<em>${esc(fmt(own(r, mget(b.sub)), mget(b.sub).dec))} ${esc(mget(b.sub).unit || '')}</em>` : ''}</div>`;
    }).join('') + '</div>';
  }

  // vòng lớn (OEE…) + các vòng phụ
  function bRing(b) {
    const m = mget(b.main);
    return `<div class="irg"><div class="irg-m">${gaugeSvg(m, val(b.main))}<span>${qi(m, 'qi-in')}${esc(m.label)}</span></div>`
      + `<div class="irg-s">` + (b.subs || []).map((id) => `<div>${gaugeSvg(mget(id), val(id), true)}<span>${qi(mget(id), 'qi-in')}${esc(mget(id).label)}</span></div>`).join('') + '</div></div>';
  }

  function bAlarms() {
    const act = active();
    if (!act.length) return `<div class="ial ok">${svgI('check')}Mọi chỉ số trong giới hạn an toàn.</div>`;
    return '<div class="ial-l">' + act.map((x) => `<div class="ial ${x.lv}">${x.lv === 'bad' ? svgI('warn') : qi(x.m)}<b>${esc(x.m.label)}</b> ${esc(stateText(x.m, x.v))} ${esc(x.m.unit || '')}<small>${x.lv === 'bad' ? 'Nguy hiểm' : 'Cảnh báo'}</small></div>`).join('') + '</div>';
  }


  /* ---------------- mặt bằng: các phòng/khu vực + điểm cảm biến đặt đúng vị trí, màu theo ngưỡng */
  function bPlan(b) {
    const W = b.w || 100, H = b.h || 60, main = mget(b.main);
    const rooms = (b.rooms || []).map((r) => `<rect class="pl-room" x="${r.x}" y="${r.y}" width="${r.w}" height="${r.h}" rx="1.2"/><text class="pl-lbl" x="${r.x + 1.6}" y="${r.y + 3.6}">${esc(r.label)}</text>`).join('');
    const marks = (b.markers || []).map((k) => {
      const rec = devs.get(k.dev), v = rec ? own(rec, main) : null, lv = main.lv ? stateLevel(main, v) : level(main, v);
      const off = !rec || (Date.now() - rec.ts > STALE_MS);
      return `<g class="pl-m ${off ? 'offl' : lv}"><circle cx="${k.x}" cy="${k.y}" r="3.4"/><text class="pl-v" x="${k.x}" y="${k.y + 1.1}" text-anchor="middle">${esc(stateText(main, v))}</text>`
        + `<text class="pl-t" x="${k.x}" y="${k.y + 7}" text-anchor="middle">${esc(k.label || titleOf(k.dev))}</text></g>`;
    }).join('');
    return `<svg class="plan" viewBox="0 0 ${W} ${H}" role="img" aria-label="Mặt bằng"><rect class="pl-bg" x="0" y="0" width="${W}" height="${H}" rx="2"/>${rooms}${marks}</svg>`;
  }

  /* ---------------- P&ID: bồn – bơm – van – bình phản ứng nối bằng đường ống; ống chảy khi chỉ số nguồn > 0 */
  function bPid(b) {
    const W = b.w || 120, H = b.h || 70, g = (id) => (id ? val(id) : null);
    /* Khách có thể không đủ cảm biến: 'na' = chưa gán chỉ số này (không giám sát), 'nd' = có gán nhưng chưa/mất dữ liệu. Không bao giờ vẽ thành "dừng"/"đóng". */
    const st = (id) => (!id ? '' : !M[id] ? 'na' : g(id) == null ? 'nd' : '');
    const stTip = { na: 'Không giám sát (chưa gán cảm biến)', nd: 'Mất tín hiệu / chưa có dữ liệu' };
    const pipes = (b.pipes || []).map((p) => {
      const on = p.on ? num(g(p.on)) > 0 : true, d = 'M' + p.pts.map((q) => q.join(' ')).join('L');
      return `<path class="pd-pipe${p.on && st(p.on) ? ' unk' : ''}" d="${d}"/>` + (on ? `<path class="pd-flow" d="${d}" style="stroke:${p.color || 'var(--acc)'}"/>` : '');
    }).join('');
    const nodes = (b.nodes || []).map((n) => {
      const m = n.metric ? mget(n.metric) : null, v = n.metric ? g(n.metric) : null, lv = m ? (m.lv ? stateLevel(m, v) : level(m, v)) : '', ns = st(n.metric);
      const tip = ns ? `<title>${esc((n.label || '') + ': ' + stTip[ns])}</title>` : '';
      const lbl = `<text class="pd-t" x="${n.x}" y="${(n.y || 0) + (n.kind === 'tank' || n.kind === 'vessel' ? (n.h || 20) + 4 : 9)}" text-anchor="middle">${esc(n.label || '')}</text>`;
      if (n.kind === 'tank' || n.kind === 'vessel') {
        const w = n.w || 16, h = n.h || 20, f = n.kind === 'tank' ? (v == null ? 0 : Math.max(0, Math.min(1, (v - (m.min ?? 0)) / ((m.max ?? 100) - (m.min ?? 0) || 1)))) : 0.55;
        const x0 = n.x - w / 2;
        return `<g class="pd-n ${ns || lv}">${tip}<rect class="pd-body" x="${x0}" y="${n.y}" width="${w}" height="${h}" rx="${n.kind === 'tank' ? 2 : 6}"/>`
          + `<rect class="pd-fill" x="${x0 + 0.6}" y="${(n.y + h * (1 - f)).toFixed(1)}" width="${w - 1.2}" height="${(h * f).toFixed(1)}" rx="1.5"/>`
          + (m ? `<text class="pd-v" x="${n.x}" y="${n.y + h / 2 + 1.5}" text-anchor="middle">${ns === 'na' ? '' : esc(stateText(m, v))}${m.unit && !ns ? ' ' + esc(m.unit) : ''}</text>` : '') + lbl + '</g>';
      }
      if (n.kind === 'pump') {
        const run = !ns && num(v) > 0;
        return `<g class="pd-n ${ns || (run ? 'ok' : 'off')}">${tip}<circle class="pd-body" cx="${n.x}" cy="${n.y}" r="5.4"/><g class="${run ? 'pd-spin' : ''}" style="transform-origin:${n.x}px ${n.y}px"><path class="pd-imp" d="M${n.x} ${n.y - 3.6}L${n.x + 3.2} ${n.y + 1.8}L${n.x - 3.2} ${n.y + 1.8}z"/></g>${lbl}</g>`;
      }
      if (n.kind === 'valve') {
        const open = !ns && num(v) > 0;
        return `<g class="pd-n ${ns || (open ? 'ok' : 'bad')}">${tip}<path class="pd-valve" d="M${n.x - 4} ${n.y - 3.4}L${n.x + 4} ${n.y + 3.4}V${n.y - 3.4}L${n.x - 4} ${n.y + 3.4}z"/>${lbl}</g>`;
      }
      return `<g class="pd-n ${ns || lv}">${tip}<rect class="pd-body" x="${n.x - 8}" y="${n.y - 4}" width="16" height="8" rx="2"/><text class="pd-v" x="${n.x}" y="${n.y + 1.4}" text-anchor="middle">${ns === 'na' ? '' : esc(stateText(m || {}, v))}${m && m.unit && !ns ? ' ' + esc(m.unit) : ''}</text>${lbl}</g>`;
    }).join('');
    return `<svg class="pid" viewBox="0 0 ${W} ${H}" role="img" aria-label="Sơ đồ quy trình">${pipes}${nodes}</svg>`;
  }

  /* ---------------- lịch vận hành theo tuần (bật/tắt theo giờ) + trạng thái hiện tại */
  const hm = (t) => { const [h, m2] = String(t).split(':').map(Number); return h * 60 + (m2 || 0); };
  function bSchedule(b) {
    const now = new Date(), dow = ((now.getDay() + 6) % 7) + 1, min = now.getHours() * 60 + now.getMinutes();
    const DN = ['T2', 'T3', 'T4', 'T5', 'T6', 'T7', 'CN'];
    return `<div class="isc"><div class="isc-h"><span></span><div class="isc-d">${DN.map((d, i) => `<em class="${i + 1 === dow ? 'today' : ''}">${d}</em>`).join('')}</div><span></span></div>` + (b.rows || []).map((r) => {
      const days = r.days || [1, 2, 3, 4, 5, 6, 7], a = hm(r.on), z = hm(r.off);
      const inWin = days.includes(dow) && (a <= z ? min >= a && min < z : min >= a || min < z);
      const live = r.metric ? val(r.metric) : null, on = live != null ? num(live) > 0 : inWin;
      const cells = DN.map((_, i) => {
        const d = i + 1, act = days.includes(d);
        const bar = act ? `<i style="left:${(a / 14.4).toFixed(1)}%;width:${(Math.max(1, (z > a ? z - a : 1440 - a + z)) / 14.4).toFixed(1)}%"></i>` : '';
        return `<div class="isc-c ${d === dow ? 'today' : ''}">${bar}${d === dow ? `<u style="left:${(min / 14.4).toFixed(1)}%"></u>` : ''}</div>`;
      }).join('');
      return `<div class="isc-r"><span>${esc(r.label)}<small>${esc(r.on)}–${esc(r.off)}</small></span><div class="isc-d">${cells}</div><b class="ichip ${on ? 'ok' : ''}"><i></i>${on ? 'BẬT' : 'Tắt'}</b></div>`;
    }).join('') + '</div>';
  }

  /* ---------------- thang máy: giếng thang, cabin theo tầng, chiều đi, cửa, tải */
  function bElevator(b) {
    const N = b.floors || 10, fm = b.floor || 'floor', ids = idsFor(b, [{ id: fm }]);
    if (!ids.length) return '<p class="muted">Chưa có thang máy nào gửi dữ liệu.</p>';
    const ruler = Array.from({ length: N }, (_, i) => `<span style="bottom:calc((100% - 30px) * ${(i / (N - 1)).toFixed(3)} + 15px)">${i + 1}</span>`).join('');   // cùng công thức với tâm cabin
    return `<div class="iel"><div class="iel-r"><div class="iel-shaft">${ruler}</div></div>` + ids.map((id) => {
      const r = devs.get(id), f = num(r.v[fm]) ?? 1, prev = r.pf ?? f; r.pf = f;
      if (Math.abs(f - prev) > 0.01) { r.dir = f > prev ? 1 : -1; r.dirT = Date.now(); } else if (r.dirT == null || Date.now() - r.dirT > 4000) r.dir = 0;
      const door = num(r.v[b.door || 'door']) > 0, load = num(r.v[b.load || 'load']), fault = num(r.v[b.fault || 'fault']) > 0;
      const pos = ((Math.max(1, Math.min(N, f)) - 1) / (N - 1)) * 100;
      return `<div class="iel-c ${fault ? 'bad' : ''}"><div class="iel-shaft"><div class="iel-cab ${door ? 'open' : ''}" style="bottom:calc((100% - 30px) * ${(pos / 100).toFixed(3)})"></div></div>`
        + `<b>${esc(titleOf(id))}</b><div class="iel-s"><span class="iel-f">${Math.round(f)}</span><span>${fault ? '▲ Lỗi' : r.dir > 0 ? '▲ Lên' : r.dir < 0 ? '▼ Xuống' : '■ Đứng'}</span></div>`
        + `<small>Cửa: ${door ? 'Mở' : 'Đóng'}${load != null ? ' · Tải ' + Math.round(load) + '%' : ''}</small></div>`;
    }).join('') + '</div>';
  }

  /* ---------------- bản đồ phương tiện (không cần nền bản đồ trực tuyến): vị trí, vệt đường đi, màu theo trạng thái */
  const trail = (rec, la, lo) => {
    const a = num(rec.v[la]), o = num(rec.v[lo]); if (a == null || o == null) return;
    const t = rec.trail || (rec.trail = []), l = t[t.length - 1];
    if (!l || l[0] !== a || l[1] !== o) { t.push([a, o]); if (t.length > 60) t.shift(); }
  };
  function bMap(b) {
    const la = b.lat || 'lat', lo = b.lon || 'lon', st = b.state ? mget(b.state) : null, sp = b.speed ? mget(b.speed) : null;
    const ids = [...devs.keys()].filter((id) => num(devs.get(id).v[la]) != null && num(devs.get(id).v[lo]) != null);
    if (!ids.length) return '<p class="muted">Chưa có xe nào gửi vị trí (field lat, lon).</p>';
    for (const id of ids) trail(devs.get(id), la, lo);
    const pts = ids.flatMap((id) => devs.get(id).trail || []);
    let a0 = Math.min(...pts.map((p) => p[0])), a1 = Math.max(...pts.map((p) => p[0])), o0 = Math.min(...pts.map((p) => p[1])), o1 = Math.max(...pts.map((p) => p[1]));
    const pa = Math.max(0.002, (a1 - a0) * 0.18), po = Math.max(0.002, (o1 - o0) * 0.18); a0 -= pa; a1 += pa; o0 -= po; o1 += po;
    const W = 300, H = 190, k = Math.cos(((a0 + a1) / 2) * Math.PI / 180), sx = (o1 - o0) * k, sy = a1 - a0, sc = Math.min(W / sx, H / sy);
    const ox = (W - sx * sc) / 2, oy = (H - sy * sc) / 2;
    const X = (o) => (ox + (o - o0) * k * sc).toFixed(1), Y = (a) => (oy + (a1 - a) * sc).toFixed(1);
    let grid = ''; for (let i = 1; i < 6; i++) grid += `<path class="mp-g" d="M${(W / 6) * i} 0V${H}M0 ${(H / 6) * i}H${W}"/>`;
    const cars = ids.map((id) => {
      const r = devs.get(id), p = r.trail[r.trail.length - 1], sv = st ? own(r, st) : null, lv = st ? stateLevel(st, sv) : 'ok', spd = sp ? own(r, sp) : null;
      const line = r.trail.length > 1 ? `<path class="mp-tr ${lv}" d="M${r.trail.map((q) => X(q[1]) + ' ' + Y(q[0])).join('L')}"/>` : '';
      return line + `<g class="mp-c ${lv}"><circle cx="${X(p[1])}" cy="${Y(p[0])}" r="5"/><text class="mp-n" x="${X(p[1])}" y="${(+Y(p[0]) - 8).toFixed(1)}" text-anchor="middle">${esc(titleOf(id))}${spd != null ? ' · ' + Math.round(spd) + ' km/h' : ''}</text></g>`;
    }).join('');
    return `<svg class="map" viewBox="0 0 ${W} ${H}" role="img" aria-label="Bản đồ"><rect class="mp-bg" width="${W}" height="${H}" rx="6"/>${grid}${cars}<text class="mp-north" x="${W - 14}" y="16" text-anchor="middle">B ↑</text></svg>`;
  }



  /* ---------------- bảng Andon: ô lớn theo trạng thái từng máy/chuyền (nhìn từ xa), nhấp nháy khi lỗi */
  function bAndon(b) {
    const st = mget(b.state), vm = b.value ? mget(b.value) : null;
    const ids = idsFor(b, [st, vm]);
    if (!ids.length) return '<p class="muted">Chưa có máy nào gửi dữ liệu.</p>';
    return `<div class="iad">` + ids.map((id) => {
      const r = devs.get(id), v = own(r, st), lv = stateLevel(st, v) || 'off', off = Date.now() - r.ts > STALE_MS;
      return `<div class="iad-t ${off ? '' : lv}"><b>${esc(titleOf(id))}</b><span>${off ? 'Mất liên lạc' : esc(stateText(st, v))}</span>${vm ? `<em>${esc(stateText(vm, own(r, vm)))}<small> ${esc(vm.unit || '')}</small></em>` : ''}</div>`;
    }).join('') + '</div>';
  }

  /* ---------------- kế hoạch so với thực tế (thanh tiến độ có vạch mục tiêu) */
  function bProgress(b) {
    return `<div class="ipg">` + (b.items || []).map((it) => {
      const a = mget(it.actual), v = val(it.actual), t = it.target ? (M[it.target] ? val(it.target) : num(it.target)) : null;
      const f = v != null && t ? Math.min(1.5, v / t) : 0, cls = f >= 1 ? 'ok' : f >= 0.6 ? '' : 'warn';
      return `<div class="ipg-r ${cls}"><div class="ipg-h"><span>${esc(it.label || a.label)}</span><b>${esc(stateText(a, v))}${t ? ' / ' + esc(fmt(t, a.dec)) : ''} ${esc(a.unit || '')}</b></div>`
        + `<div class="ipg-t"><div style="width:${Math.min(100, f * 100).toFixed(1)}%"></div><u style="left:${Math.min(100, 100 / Math.max(1.0001, 1.0001)).toFixed(0)}%"></u></div><small>${t ? (f * 100).toFixed(0) + '% kế hoạch' : ''}</small></div>`;
    }).join('') + '</div>';
  }

  /* ---------------- la bàn hướng gió + tốc độ */
  function bWind(b) {
    const d = val(b.dir), s = b.speed ? val(b.speed) : null, sm = b.speed ? mget(b.speed) : null, ang = d == null ? 0 : d;
    const ticks = ['B', 'Đ', 'N', 'T'].map((t, i) => `<text x="${[50, 92, 50, 8][i]}" y="${[12, 54, 96, 54][i]}" text-anchor="middle">${t}</text>`).join('');
    return `<div class="iwd"><svg viewBox="0 0 100 100"><circle class="iwd-c" cx="50" cy="50" r="38"/>${ticks}<g style="transform:rotate(${ang}deg);transform-origin:50px 50px"><path class="iwd-a" d="M50 18L58 54L50 48L42 54z"/></g></svg>`
      + `<div><b>${s == null ? '—' : esc(fmt(s, sm.dec))}</b> <small>${esc(sm?.unit || '')}</small><span>Hướng ${d == null ? '—' : Math.round(d) + '°'}</span></div></div>`;
  }


  const BLOCK = { kpis: bKpis, gauges: bGauges, tank: bTank, tanks: bTanks, state: bState, bars: bBars, trend: bTrend, tiles: bTiles, line: bLine, ring: bRing, alarms: bAlarms, plan: bPlan, pid: bPid, schedule: bSchedule, elevator: bElevator, map: bMap, andon: bAndon, progress: bProgress, wind: bWind };
  const renderBlocks = (blocks) => (blocks || []).map((b) => {
    let h = ''; try { h = BLOCK[b.type] ? BLOCK[b.type](b) : ''; } catch (e) { console.warn('industry', b.type, e); }
    return `<section class="ib-blk b-${esc(b.type)}${b.span ? ' span' : ''}">${b.title ? `<h3>${esc(b.title)}</h3>` : ''}${h}</section>`;
  }).join('');


  /* ------------------------------------------------------------------ yêu cầu bắt buộc của gateway cho giải pháp này */
  function missingReq() {
    const out = [];
    for (const r of S.required || []) {
      if (r.startsWith('key:')) {
        const k = r.slice(4).toLowerCase();
        if (![...devs.values()].some((d) => num(d.v[k]) != null)) out.push({ id: r, label: k, key: k });
      } else if (M[r] && val(r) == null) out.push({ id: r, label: M[r].label, key: keyList(M[r]).map((x) => x[0]).join(' / ') });
    }
    return out;
  }
  function reqBox() {
    if (!(S.required || []).length || !devs.size) return '';
    const miss = missingReq();
    if (!miss.length) return '';
    return `<div class="ireq"><b>▲ Chưa nhận được đủ dữ liệu để theo dõi an toàn</b><p>Chưa có số liệu của:</p><ul>${miss.map((x) => `<li>${esc(x.label)} <code>${esc(x.key)}</code></li>`).join('')}</ul>`
      + `<small>${esc(S.why || '')} Bạn cần <b>thêm thiết bị đo tương ứng</b> vào gateway (mục <b>Thiết bị</b>) và đặt đúng tên như trong ngoặc. Cần hỗ trợ cài đặt thì liên hệ nhà cung cấp.</small></div>`;
  }
  function reqList() {
    const req = S.required || [];
    if (!req.length) return '';
    const miss = new Set(missingReq().map((x) => x.id));
    return `<h3 class="ib-sub">Field gateway bắt buộc cho giao diện này</h3><div class="ireq-l">${req.map((r) => {
      const label = r.startsWith('key:') ? r.slice(4) : (M[r]?.label || r), key = r.startsWith('key:') ? r.slice(4) : keyList(M[r] || { id: r }).map((x) => x[0]).join(' / ');
      const ok = devs.size && !miss.has(r);
      return `<span class="ichip ${ok ? 'ok' : devs.size ? 'bad' : ''}"><i></i>${esc(label)} <code>${esc(key)}</code></span>`;
    }).join('')}</div><p class="muted">${esc(S.why || '')}</p>`;
  }

  /* ------------------------------------------------------------------ tổng quan */

  const card = document.createElement('div');
  card.id = 'ind-card';
  card.innerHTML = `<h2><span class="ind-ic">${svgI(S.icon)}</span>${esc(S.heading || S.title)}<span class="st" id="ind-st">Chờ dữ liệu…</span></h2><div id="ind-body"></div>`;
  dash.insertBefore(card, (!HL && document.getElementById('gw-tabs')?.nextSibling) || dash.firstChild);   // dưới thanh tab gateway (nếu có)

  function drawOverview() {
    // MỘT gateway = MỘT giao diện, GỘP trong một mục (giống GatewayApp): mọi tab của giải pháp vẽ liền dưới phần tổng quan, không tách tab riêng
    // khối trùng khi gộp (cảnh báo ở cả tổng quan lẫn tab An toàn, hai trend cùng một chỉ số…) chỉ vẽ một lần — giống GatewayApp
    const seen = new Set();
    const uniq = (bl) => (bl || []).filter((b) => { const k = b.type === 'alarms' ? 'alarms' : b.type === 'trend' ? 'trend:' + b.metric : JSON.stringify(b); return !seen.has(k) && seen.add(k); });
    $('#ind-body').innerHTML = reqBox() + renderBlocks(uniq(S.overview))
      + (S.tabs || []).map((t) => { const bl = uniq(t.blocks); return bl.length ? `<h3 class="ib-sub" style="margin-top:18px">${svgI(t.icon)}${esc(t.title || t.label)}</h3>${renderBlocks(bl)}` : ''; }).join('');
    const st = $('#ind-st'), fresh = lastTs && Date.now() - lastTs < STALE_MS * 2, n = active().length;
    st.textContent = !lastTs ? 'Chờ dữ liệu…' : !fresh ? '▲ Mất liên lạc' : n ? `▲ ${n} cảnh báo` : '● Trực tuyến';
    st.className = 'st ' + (!lastTs ? '' : !fresh ? 'stale' : n ? 'warn' : 'live');
  }

  /* ------------------------------------------------------------------ tab theo ngành + Thiết bị + Cảnh báo */
  const MINE = {};
  const mkTab = (id, html) => { const s = document.createElement('section'); s.id = 'tab-' + id; s.className = 'tab ind-tab'; s.hidden = true; s.innerHTML = html; main.appendChild(s); MINE[id] = s; return s; };
  const setBtn = nav.querySelector('button[data-tab="set"]');
  const btns = {};
  const mkBtn = (id, label, icon) => {
    const b = document.createElement('button');
    b.dataset.tab = id; b.innerHTML = `${svgI(icon)}<span>${esc(label)}</span>`;
    nav.insertBefore(b, setBtn); btns[id] = b;
    b.onclick = () => showMine(id);
  };
  mkTab('devs', '<div class="panel"><div class="row" style="justify-content:space-between;align-items:center"><h2 style="margin:0">Thiết bị</h2><button id="dv-add" class="primary fit">＋ Thêm thiết bị</button></div><div id="dv-sum" class="ik-grid c3"></div><div id="dv-list" class="dv-list"></div><div id="dv-req"></div></div>');
  mkBtn('devs', 'Thiết bị', 'device');
  mkTab('alm', '<div class="panel"><h2>Cảnh báo</h2><div id="alm-act"></div><h3 class="ib-sub">Nhật ký (phiên này)</h3><div id="alm-log"></div></div>');
  mkBtn('alm', 'Cảnh báo', 'bell');
  drawBadge(); announce();
  $('#dv-add').onclick = () => { if (window.DevicesUi?.openModal) window.DevicesUi.openModal(); };

  const LABEL = {}; for (const m of Object.values(M)) for (const [k] of keyList(m)) LABEL[k] = m;
  function drawDevices() {
    const listed = new Map();
    for (const d of (window.DevicesUi?.getDashboard?.()?.devices || [])) if (!GW || d.gw?.base === GW) listed.set(d.childId, d);
    const ids = new Set([...listed.keys(), ...devs.keys()]), now = Date.now();
    let online = 0, bad = 0;
    const rows = [...ids].map((id) => {
      const rec = devs.get(id), meta = listed.get(id), v = rec?.v || {};
      const on = !!rec && (now - rec.ts < STALE_MS);
      const faults = Object.entries(v).some(([k, x]) => /^(fault|alarm|err|error)/i.test(k) && Number(x) > 0);
      const lvBad = Object.keys(v).some((k) => LABEL[k] && level(LABEL[k], own(rec, LABEL[k])) === 'bad');
      if (on) online++; if (faults || lvBad) bad++;
      const items = Object.entries(v).filter(([k, x]) => num(x) != null && !/^(fault|alarm|err|error)/i.test(k)).slice(0, 6).map(([k, x]) => {
        const m = LABEL[k]; const n = num(x) * (m ? keyList(m).find(([kk]) => kk === k)[1] : 1);
        return `<div class="ik ${m ? level(m, n) : ''}"><span>${esc(m?.label || k)}</span><b>${esc(m ? stateText(m, n) : fmt(n))}</b> ${m ? unitOf(m) : ''}</div>`;
      }).join('');
      return `<div class="dv${faults || lvBad ? ' bad' : ''}"><div class="dv-h"><span class="dv-i">${devIcon(meta, id)}</span><div><b>${esc(meta?.title || titleOf(id))}</b><small><code>${esc(id)}</code></small></div>`
        + `<span class="dv-s ${faults || lvBad ? 'bad' : on ? 'on' : 'off'}">${faults || lvBad ? '▲ Cảnh báo' : on ? '● Trực tuyến' : '■ Chưa có dữ liệu'}</span></div>${items ? `<div class="ik-grid">${items}</div>` : ''}</div>`;
    });
    $('#dv-sum').innerHTML = `<div class="ik"><span>Thiết bị</span><b>${ids.size}</b></div><div class="ik ok"><span>Trực tuyến</span><b>${online}</b></div><div class="ik ${bad ? 'bad' : ''}"><span>Cảnh báo</span><b>${bad}</b></div>`;
    $('#dv-req').innerHTML = reqList();
    $('#dv-list').innerHTML = rows.join('') || '<p class="muted">Chưa có thiết bị. Bấm “＋ Thêm thiết bị” rồi quét mã QR trên tem của gateway.</p>';
  }
  function drawAlarms() {
    $('#alm-act').innerHTML = bAlarms();
    const t = (ts) => new Date(ts).toLocaleTimeString('vi-VN');
    $('#alm-log').innerHTML = ALM.length ? ALM.map((a) => `<div class="ial ${a.level}"><i></i><b>${esc(a.text)}</b><small>${t(a.ts)}${a.level === 'ok' ? ' · hết cảnh báo' : ''}</small></div>`).join('') : '<p class="muted">Chưa có sự kiện nào trong phiên này.</p>';
  }
  const drawTab = (id) => {
    if (id === 'devs') return drawDevices();
    if (id === 'alm') return drawAlarms();
    const t = (S.tabs || []).find((x) => x.id === id);
    if (t) $('#ind-t-' + id).innerHTML = renderBlocks(t.blocks);
  };

  function showMine(t) {
    main.querySelectorAll(':scope > .tab').forEach((s) => { s.hidden = true; });
    MINE[t].hidden = false;
    if (t === 'alm' && ST.unseen) { ST.unseen = 0; drawBadge(); announce(); }   // mở tab Cảnh báo = đã xem
    nav.querySelectorAll('button').forEach((b) => b.classList.toggle('on', b.dataset.tab === t));
    const title = $('#title'); if (title) title.textContent = $('span', btns[t]).textContent;
    drawTab(t);
  }
  const hideMine = () => Object.values(MINE).forEach((s) => { s.hidden = true; });
  if (!HL) window.__indHide = hideMine;
  if (!HL && typeof window.showTab === 'function' && !window.showTab.__ind) {
    const orig = window.showTab;
    window.showTab = function indShowTab(t) { try { window.__indHide?.(); } catch { /* */ } return orig.apply(this, arguments); };
    window.showTab.__ind = true;
  }
  // ẩn các tab của bản cơ bản không dùng trong giải pháp này (CSS đã ẩn nút; ở đây ẩn thêm theo spec)
  const hidden = [];
  for (const t of S.hide || []) { const b = nav.querySelector(`button[data-tab="${t}"]`); if (b) { b.style.display = 'none'; hidden.push(b); } }
  // MỘT gateway = MỘT giao diện trong MỘT mục (giống GatewayApp): mục trang chính mang tên giải pháp, không còn "Thiết bị"/"Tổng quan" trùng với tab Thiết bị
  const dashSpan = HL ? null : nav.querySelector('button[data-tab="dash"] span');
  const dashOrig = dashSpan?.textContent || '';
  const solLabel = S.short || S.heading || S.title || '';
  // Field đã có ô trong sơ đồ (tên trùng khoá của chỉ số đọc trực tiếp) → khung thiết bị không lặp lại thành widget (giống GatewayApp)
  if (!HL) {
    window.__indKeys = new Set((S.metrics || []).filter((m) => !m.expr).flatMap((m) => keyList(m).map(([k]) => k)));
    document.dispatchEvent(new Event('plc-ind-keys'));
  }
  if (dashSpan && solLabel) {
    window.__indDashLabel = solLabel; dashSpan.textContent = solLabel;
    const tt = document.getElementById('title'); if (tt && nav.querySelector('button[data-tab="dash"]')?.classList.contains('on')) tt.textContent = solLabel;
  }

  /* ------------------------------------------------------------------ nạp số liệu + chế độ chạy thử */
  function ingest(p) {
    const d = p && (p.d || p.data);
    if (!d || typeof d !== 'object') return;
    const now = Date.now();
    for (const [id, o] of Object.entries(d)) {
      if (!o || typeof o !== 'object') continue;
      const rec = devs.get(id) || { v: {}, ts: 0 };
      for (const [k, v] of Object.entries(o)) rec.v[k.toLowerCase()] = v;
      rec.ts = now; devs.set(id, rec);
    }
    lastTs = now;
  }
  function redraw() {
    drawOverview();
    for (const id of Object.keys(MINE)) if (!MINE[id].hidden) drawTab(id);
  }
  const handler = (p, b) => {
    if (GW && b && b !== GW) return;   // số liệu của gateway khác không thuộc giao diện này
    ingest(p); sample(Date.now()); alarmScan(Date.now()); redraw();
  };
  function hook() {
    const ui = window.DevicesUi;
    if (!ui || dead) return !!ui;
    if (!ui.__ind || !ui.__ind.set) {
      const orig = ui.onTelemetry, st = { set: new Set() };
      ui.onTelemetry = (p, b) => { for (const h of st.set) { try { h(p, b); } catch (e) { console.warn('industry', e); } } return orig(p, b); };
      ui.__ind = st;
    }
    ui.__ind.set.add(handler);
    return true;
  }
  if (!hook()) document.addEventListener('DOMContentLoaded', hook);

  const timer = setInterval(() => {
    sample(Date.now()); alarmScan(Date.now()); redraw();
  }, 1500);
  drawOverview();

  function unmount() {
    dead = true;
    clearInterval(timer);
    const ui = window.DevicesUi;
    ui?.__ind?.set?.delete(handler);
    if (!HL && window.__indHide === hideMine) window.__indHide = null;
    card.remove();
    Object.values(MINE).forEach((e) => e.remove());
    Object.values(btns).forEach((e) => e.remove());
    hidden.forEach((e) => { e.style.display = ''; });
    if (dashSpan) { window.__indDashLabel = null; dashSpan.textContent = dashOrig; }
    if (!HL) { window.__indKeys = null; document.dispatchEvent(new Event('plc-ind-keys')); }
    if (!HL) delete document.documentElement.dataset.ind;
    document.dispatchEvent(new CustomEvent('plc-ind-unseen', { detail: { base: GW, n: ST.unseen } }));
  }
  return { unmount };
}
return { mount };
})();
if (!window.PLCIOT_MULTI && window.INDUSTRY) window.IndustryEngine.mount(window.INDUSTRY);   // bản một giải pháp (cũ): tự chạy; bản nhiều gateway: sol-multi.js gắn theo tab

