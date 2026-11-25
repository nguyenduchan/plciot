'use strict';
/**
 * Icon thiết bị "thực tế": vẽ giống hình chụp thiết bị thật (bơm ly tâm + động cơ, bồn có ống thuỷ, van bi, quạt có lồng, đồng hồ áp, nhiệt kế, công tơ điện, PLC, biến tần…).
 * MỘT bản vẽ cho hai dạng:
 *   3d   — đổ khối: gradient kim loại, bóng sáng/tối, đổ bóng xuống nền
 *   flat — phẳng: cùng hình, màu đặc, không gradient / bóng
 * Thiết bị chưa có bản vẽ thực tế dùng hình 3D cũ (icons-3d*.js), dạng phẳng thì quy gradient về màu đặc.
 * Tự vẽ (không sao chép tệp của thư viện nào). Hiệu ứng quay dùng class "ic-rot" như các bộ khác.
 */
(function () {
  const FLAT = { metal: '#b9c4d2', steel: '#8d9bb0', dark: '#3b4452', blue: '#2f6fd0', red: '#d64545', green: '#2e9e5b', brass: '#d9a441', white: '#eef1f5', glass: '#d3e9fb', liq: '#3b8be8', rubber: '#262b33', lcd: '#12301f', sky: '#5aa9f2', cell: '#2a56a8' };
  // gradient đổ khối (id rl-*), khai báo một lần trong <defs> ẩn
  const stops = (a) => a.map(([o, c, op]) => `<stop offset="${o}" stop-color="${c}"${op != null ? ` stop-opacity="${op}"` : ''}/>`).join('');
  const lg = (id, horiz, a) => `<linearGradient id="rl-${id}" x1="0" y1="0" x2="${horiz ? 1 : 0}" y2="${horiz ? 0 : 1}">${stops(a)}</linearGradient>`;
  const DEFS = `<svg width="0" height="0" style="position:absolute" aria-hidden="true"><defs>
    ${lg('metal', false, [[0, '#f6f8fb'], [.5, '#c3ccd8'], [1, '#7b8899']])}
    ${lg('steel', true, [[0, '#6f7f93'], [.3, '#e6ebf2'], [.62, '#a3b0c1'], [1, '#56657a']])}
    ${lg('dark', false, [[0, '#5b6573'], [1, '#232830']])}
    ${lg('blue', true, [[0, '#17408f'], [.3, '#5b97ee'], [.6, '#2f6fd0'], [1, '#143a82']])}
    ${lg('red', false, [[0, '#ff9a9a'], [1, '#bb2b2b']])}
    ${lg('green', false, [[0, '#86e0ad'], [1, '#1f8a4c']])}
    ${lg('brass', true, [[0, '#9a6c1c'], [.35, '#f2d487'], [.65, '#d9a441'], [1, '#8a5d14']])}
    ${lg('white', false, [[0, '#ffffff'], [1, '#c9d1db']])}
    ${lg('glass', true, [[0, '#ffffff', .75], [.3, '#cfe6fa', .55], [1, '#9cc7ee', .45]])}
    ${lg('liq', false, [[0, '#8fd0ff'], [1, '#1f66c8']])}
    ${lg('rubber', false, [[0, '#4a515c'], [1, '#14171c']])}
    ${lg('sky', false, [[0, '#8ccaff'], [1, '#2f78d6']])}
    ${lg('cell', false, [[0, '#3f78d4'], [1, '#183f8c']])}
  </defs></svg>`;

  function kit(mode) {
    const g = mode === '3d';
    const f = (n) => (n === 'lcd' || !g ? FLAT[n] : `url(#rl-${n})`);
    const ST = g ? 'stroke="rgba(0,0,0,.38)" stroke-width=".9" stroke-linejoin="round"' : 'stroke="rgba(0,0,0,.2)" stroke-width=".8" stroke-linejoin="round"';
    return {
      g, f,
      R: (x, y, w, h, r, n, o = '') => `<rect x="${x}" y="${y}" width="${w}" height="${h}" rx="${r}" fill="${f(n)}" ${ST} ${o}/>`,
      C: (cx, cy, r, n, o = '') => `<circle cx="${cx}" cy="${cy}" r="${r}" fill="${f(n)}" ${ST} ${o}/>`,
      E: (cx, cy, rx, ry, n, o = '') => `<ellipse cx="${cx}" cy="${cy}" rx="${rx}" ry="${ry}" fill="${f(n)}" ${ST} ${o}/>`,
      P: (d, n, o = '') => `<path d="${d}" fill="${f(n)}" ${ST} ${o}/>`,
      L: (d, c = 'rgba(0,0,0,.28)', w = 1.1) => `<path d="${d}" fill="none" stroke="${c}" stroke-width="${w}" stroke-linecap="round"/>`,
      HL: (s) => (g ? s : ''),                                       // chỉ có ở dạng 3D: vệt sáng
      SH: (cx, cy, rx) => `<ellipse cx="${cx}" cy="${cy}" rx="${rx}" ry="2.2" fill="#000" opacity="${g ? .28 : .12}"/>`, // bóng đổ xuống nền
      dot: (x, y, c) => `<circle cx="${x}" cy="${y}" r="1.6" fill="${c}" stroke="rgba(0,0,0,.35)" stroke-width=".5"/>`,
    };
  }

  // ----------------------------------------------------------------------------------------------------------------- bản vẽ
  const DRAW = {
    // bơm ly tâm: vỏ xoắn (miệng xả lên, miệng hút bên trái) nối động cơ điện có cánh tản nhiệt, đặt trên bệ
    pump: (k) => `${k.SH(24, 44.5, 22)}${k.R(2, 40, 44, 3.5, 1, 'dark')}
      ${k.R(12, 7, 7, 15, 1, 'metal')}${k.R(9.5, 5, 12, 3.6, 1, 'steel')}
      ${k.R(0, 25, 7, 8, 1, 'metal')}${k.R(0, 23, 3, 12, 1, 'steel')}
      ${k.R(24, 18, 19, 20, 4, 'blue')}${k.L('M28 20v16M32 20v16M36 20v16M40 20v16')}${k.HL('<path d="M27 21h13" stroke="#fff" stroke-opacity=".5" stroke-width="2" stroke-linecap="round"/>')}
      ${k.R(42, 22, 4, 12, 1.5, 'dark')}${k.R(20, 26.5, 6, 7, 1, 'steel')}
      ${k.C(15.5, 29.5, 11, 'steel')}${k.HL('<path d="M8 24a9 9 0 0 1 8-6" stroke="#fff" stroke-opacity=".7" stroke-width="2" fill="none" stroke-linecap="round"/>')}
      <g class="ic-rot" style="transform-origin:15.5px 29.5px">${k.C(15.5, 29.5, 6.5, 'metal')}<path d="M15.5 29.5l0-5M15.5 29.5l4.5 2.5M15.5 29.5l-4.5 2.5" stroke="rgba(0,0,0,.4)" stroke-width="1.4" stroke-linecap="round"/></g>
      ${k.C(15.5, 29.5, 2, 'dark')}
      ${k.C(8, 33, 1, 'dark')}${k.C(23, 33, 1, 'dark')}${k.C(8, 26, 1, 'dark')}${k.C(23, 26, 1, 'dark')}`,

    // bồn chứa trụ đứng: chân đỡ, đai, ống thuỷ báo mức bên hông, ống cấp trên đỉnh
    tank: (k) => `${k.SH(22, 45, 18)}${k.R(11, 38, 3, 7, 1, 'dark')}${k.R(30, 38, 3, 7, 1, 'dark')}
      ${k.R(19, 3, 6, 6, 1, 'metal')}
      ${k.P('M10 12v26a12 3.5 0 0 0 24 0V12z', 'metal')}${k.E(22, 12, 12, 3.5, 'steel')}
      ${k.L('M10 22a12 3.5 0 0 0 24 0M10 31a12 3.5 0 0 0 24 0', 'rgba(0,0,0,.2)', 1)}
      ${k.HL('<path d="M13 15v22" stroke="#fff" stroke-opacity=".7" stroke-width="2.4" stroke-linecap="round"/>')}
      ${k.R(34, 15, 3, 1.6, .5, 'steel')}${k.R(34, 33, 3, 1.6, .5, 'steel')}
      ${k.R(37, 12, 5, 26, 2.5, 'glass')}${k.R(38.4, 24, 2.2, 13, 1.1, 'liq', 'stroke="none"')}
      ${k.R(19, 40, 6, 4, 1, 'metal')}`,

    // van bi: thân đồng, hai mặt bích, trục và cần gạt đỏ
    valve: (k) => `${k.SH(24, 44, 22)}${k.R(1, 26, 10, 9, 1, 'metal')}${k.R(0, 24, 3, 13, 1, 'steel')}${k.R(37, 26, 10, 9, 1, 'metal')}${k.R(45, 24, 3, 13, 1, 'steel')}
      ${k.R(12, 24, 24, 13, 3, 'brass')}${k.C(24, 30.5, 8.5, 'brass')}${k.HL('<path d="M17 26a8 8 0 0 1 7-3" stroke="#fff" stroke-opacity=".6" stroke-width="1.6" fill="none" stroke-linecap="round"/>')}
      ${k.R(22.5, 14, 3, 11, 1, 'steel')}${k.R(19.5, 20.5, 9, 3, 1, 'steel')}
      ${k.R(7, 10, 34, 4.6, 2.3, 'red')}${k.C(24, 12.3, 2.4, 'dark')}`,

    // động cơ điện: thân có cánh tản nhiệt, hộp đấu dây, trục, chân đế
    motor: (k) => `${k.SH(22, 44.5, 20)}${k.R(5, 36, 30, 4, 1, 'dark')}
      ${k.R(14, 9, 12, 6, 1.5, 'dark')}${k.R(3, 18, 5, 17, 2, 'steel')}
      ${k.R(6, 14, 28, 23, 5, 'blue')}${k.L('M12 15v21M16.5 15v21M21 15v21M25.5 15v21M30 15v21', 'rgba(0,0,0,.28)', 1.3)}${k.HL('<path d="M9 17h22" stroke="#fff" stroke-opacity=".5" stroke-width="2.2" stroke-linecap="round"/>')}
      ${k.R(34, 21.5, 9, 5, 1, 'metal')}<g class="ic-rot" style="transform-origin:43px 24px">${k.R(41.5, 18, 3, 12, 1, 'steel')}</g>
      ${k.C(10, 38, 1, 'dark')}${k.C(30, 38, 1, 'dark')}`,

    // quạt hướng trục: khung vuông, lồng bảo vệ, cánh quay
    fan: (k) => `${k.R(3, 3, 42, 42, 6, 'dark')}${k.C(24, 24, 19, 'rubber')}
      <g class="ic-rot" style="transform-origin:24px 24px">${[0, 72, 144, 216, 288].map((a) => `<g transform="rotate(${a} 24 24)">${k.P('M24 24c-3-7-2-14 4-15 4-.5 5 5 2 9-1.5 3-3.5 5-6 6z', 'sky')}</g>`).join('')}</g>
      ${k.C(24, 24, 4.2, 'metal')}${k.C(24, 24, 1.6, 'dark')}
      <circle cx="24" cy="24" r="18" fill="none" stroke="${k.f('metal')}" stroke-width="1.4"/><circle cx="24" cy="24" r="12" fill="none" stroke="${k.f('metal')}" stroke-width="1"/><circle cx="24" cy="24" r="6.5" fill="none" stroke="${k.f('metal')}" stroke-width="1"/>
      <path d="M24 5v38M5 24h38M10.5 10.5l27 27M37.5 10.5l-27 27" stroke="${k.f('metal')}" stroke-width=".9" opacity=".8"/>
      ${k.C(7, 7, 1.4, 'metal')}${k.C(41, 7, 1.4, 'metal')}${k.C(7, 41, 1.4, 'metal')}${k.C(41, 41, 1.4, 'metal')}`,

    // máy nén khí: bình chứa nằm ngang, cụm nén + động cơ phía trên, đồng hồ áp, bánh xe
    compressor: (k) => `${k.SH(24, 45, 22)}${k.R(5, 40, 38, 3, 1, 'dark')}
      ${k.R(6, 25, 34, 14, 7, 'red')}${k.HL('<path d="M12 28h22" stroke="#fff" stroke-opacity=".55" stroke-width="2.4" stroke-linecap="round"/>')}${k.L('M13 26v12M33 26v12', 'rgba(0,0,0,.2)', 1)}
      ${k.R(9, 12, 13, 12, 3, 'dark')}${k.R(24, 14, 11, 10, 2.5, 'blue')}${k.L('M27 15v8M30 15v8M33 15v8', 'rgba(0,0,0,.28)', 1)}${k.R(22, 17, 3, 4, 1, 'steel')}
      ${k.C(41, 20, 5, 'metal')}${k.C(41, 20, 3.4, 'white')}<path d="M41 20l2-2" stroke="#c62828" stroke-width="1"/>${k.R(40, 24, 2, 5, .5, 'steel')}
      ${k.C(10, 41.5, 2.6, 'rubber')}${k.C(38, 41.5, 2.6, 'rubber')}`,

    // đồng hồ áp suất: viền kim loại, mặt trắng chia vạch, vùng đỏ, kim, ren nối phía dưới
    pressure: (k) => `${k.SH(24, 46, 14)}${k.R(21, 39, 6, 6, 1, 'brass')}${k.R(19.5, 43.5, 9, 2.4, .8, 'steel')}
      ${k.C(24, 22, 20, 'steel')}${k.C(24, 22, 16.6, 'white')}
      <path d="M11 33a14 14 0 1 1 26 0" fill="none" stroke="#c62828" stroke-width="2.6" stroke-dasharray="0 31 11 99" stroke-linecap="butt" opacity=".9"/>
      ${k.L('M12.5 30l2.4-1.4M10.6 22.5h2.8M13 15.3l2.2 1.7M24 7v2.8M35 15.3l-2.2 1.7M37.4 22.5h-2.8M35.5 30l-2.4-1.4', '#556272', 1.3)}
      <g class="ic-needle" style="transform-origin:24px 22px"><path d="M24 22l8-9" stroke="#222" stroke-width="1.8" stroke-linecap="round"/></g>${k.C(24, 22, 2.3, 'dark')}
      ${k.HL('<path d="M12 14a14 14 0 0 1 11-8" stroke="#fff" stroke-opacity=".7" stroke-width="2" fill="none" stroke-linecap="round"/>')}`,

    // nhiệt kế/cảm biến nhiệt độ: ống thuỷ tinh có thuỷ ngân đỏ, vạch chia, bầu
    env: (k) => `${k.SH(24, 46, 10)}${k.R(19, 3, 10, 31, 5, 'glass')}${k.R(22, 12, 4, 25, 2, 'red', 'stroke="none"')}${k.C(24, 37, 8, 'glass')}${k.C(24, 37, 5.6, 'red', 'stroke="none"')}
      ${k.L('M31 9h5M31 14h3M31 19h5M31 24h3M31 29h5', '#475569', 1.3)}${k.HL('<path d="M21 8v20" stroke="#fff" stroke-opacity=".85" stroke-width="1.6" stroke-linecap="round"/><circle cx="21.8" cy="34.5" r="1.8" fill="#fff" opacity=".8"/>')}`,

    // công tơ điện: vỏ trắng, màn LCD số, đĩa/đèn xung, cụm đấu dây phía dưới
    energy: (k) => `${k.SH(24, 46, 15)}${k.R(8, 3, 32, 40, 4, 'white')}${k.R(11, 8, 26, 11, 2, 'lcd')}
      <text x="24" y="16.8" text-anchor="middle" font-family="ui-monospace,Consolas,monospace" font-size="8.4" font-weight="700" fill="#7CFFB0">01234</text>
      ${k.R(14, 22, 20, 8, 3, 'metal')}${k.C(19, 26, 2.6, 'dark')}${k.dot(30, 26, '#f59e0b')}
      ${k.L('M13 34h22', 'rgba(0,0,0,.25)', 1)}${k.R(10, 36.5, 28, 5, 1, 'dark')}${k.C(14, 39, 1.2, 'steel')}${k.C(21, 39, 1.2, 'steel')}${k.C(27, 39, 1.2, 'steel')}${k.C(34, 39, 1.2, 'steel')}`,

    // PLC dạng module trên thanh DIN: đầu nối trên/dưới, hàng LED, nhãn
    plc: (k) => `${k.R(2, 40, 44, 3, 1, 'metal')}${k.R(6, 5, 36, 36, 3, 'dark')}${k.R(8, 5, 32, 5, 1.2, 'metal')}${k.R(8, 36, 32, 5, 1.2, 'metal')}
      ${k.C(11, 7.5, 1, 'dark')}${k.C(17, 7.5, 1, 'dark')}${k.C(23, 7.5, 1, 'dark')}${k.C(29, 7.5, 1, 'dark')}${k.C(35, 7.5, 1, 'dark')}
      ${k.R(10, 13, 28, 8, 1.5, 'white')}<text x="24" y="19" text-anchor="middle" font-family="Arial,sans-serif" font-size="5.2" font-weight="700" fill="#334155">PLC</text>
      ${[11, 16, 21, 26, 31, 36].map((x, i) => k.dot(x, 26, i === 0 ? '#4ade80' : i === 1 ? '#fbbf24' : '#334155')).join('')}${[11, 16, 21, 26, 31, 36].map((x, i) => k.dot(x, 31, i < 3 ? '#4ade80' : '#334155')).join('')}
      ${k.C(11, 38.5, 1, 'dark')}${k.C(17, 38.5, 1, 'dark')}${k.C(23, 38.5, 1, 'dark')}${k.C(29, 38.5, 1, 'dark')}${k.C(35, 38.5, 1, 'dark')}`,

    // biến tần treo tường: màn hình, phím bấm, khe tản nhiệt
    vfd: (k) => `${k.SH(24, 46, 15)}${k.R(9, 3, 30, 41, 3, 'white')}${k.R(13, 7, 22, 9, 1.5, 'lcd')}
      <text x="24" y="14" text-anchor="middle" font-family="ui-monospace,Consolas,monospace" font-size="6.6" font-weight="700" fill="#7CFFB0">50.0Hz</text>
      ${k.C(17, 22, 2.2, 'green')}${k.C(24, 22, 2.2, 'red')}${k.C(31, 22, 2.2, 'metal')}${k.R(14, 26.5, 20, 3.4, 1.2, 'steel')}
      ${k.L('M13 33h22M13 35.8h22M13 38.6h22M13 41.4h22', 'rgba(0,0,0,.3)', 1.2)}`,

    // contactor / rơ-le công suất: thân đen, nút thử, vít đấu dây hai đầu
    relay: (k) => `${k.SH(24, 46, 15)}${k.R(10, 9, 28, 31, 3, 'dark')}${k.R(10, 5, 28, 5, 1.2, 'steel')}${k.R(10, 39, 28, 5, 1.2, 'steel')}
      ${k.C(15, 7.5, 1.3, 'metal')}${k.C(24, 7.5, 1.3, 'metal')}${k.C(33, 7.5, 1.3, 'metal')}${k.C(15, 41.5, 1.3, 'metal')}${k.C(24, 41.5, 1.3, 'metal')}${k.C(33, 41.5, 1.3, 'metal')}
      ${k.R(14, 13, 20, 8, 1.5, 'white')}<text x="24" y="19.2" text-anchor="middle" font-family="Arial,sans-serif" font-size="5" font-weight="700" fill="#334155">24VDC</text>
      ${k.R(18, 25, 12, 9, 2, 'green')}${k.HL('<path d="M20 27h8" stroke="#fff" stroke-opacity=".6" stroke-width="1.6" stroke-linecap="round"/>')}`,

    // đèn: bóng thuỷ tinh có tim đèn, đuôi xoáy kim loại
    bulb: (k) => `${k.SH(24, 46, 9)}${k.P('M17 34c0-4-6-6.5-6-14a13 13 0 0 1 26 0c0 7.5-6 10-6 14z', 'glass')}
      ${k.L('M20 22l2 6 2-4 2 4 2-6', '#d97706', 1.6)}${k.L('M22 28v6M26 28v6', '#6b7280', 1)}
      ${k.HL('<path d="M15 14a9 9 0 0 1 6-5" stroke="#fff" stroke-opacity=".9" stroke-width="2" fill="none" stroke-linecap="round"/>')}
      ${k.R(17, 34, 14, 3.4, 1, 'metal')}${k.R(17.5, 37.6, 13, 3.4, 1, 'steel')}${k.R(18, 41.2, 12, 3.4, 1, 'metal')}${k.R(21, 44, 6, 2.2, 1, 'dark')}`,

    // đèn báo động/còi: chao đỏ, đế đen, tia sáng
    alarm: (k) => `${k.SH(24, 46, 14)}${k.R(8, 36, 32, 8, 2, 'dark')}${k.R(11, 33, 26, 4, 1, 'steel')}
      ${k.P('M12 33v-9a12 12 0 0 1 24 0v9z', 'red')}${k.HL('<path d="M16 26a8 8 0 0 1 6-7" stroke="#fff" stroke-opacity=".75" stroke-width="2.2" fill="none" stroke-linecap="round"/>')}${k.L('M24 12v21', 'rgba(0,0,0,.18)', 1)}
      <g class="ic-pulse"><path d="M5 17l-3-2M43 17l3-2M9 8L6 5M39 8l3-3M24 4V1" stroke="#f59e0b" stroke-width="1.8" stroke-linecap="round"/></g>`,

    // tấm pin mặt trời: khung nhôm, lưới tế bào, chân đỡ
    solar: (k) => `${k.SH(24, 46, 18)}${k.R(21.5, 34, 5, 11, 1, 'steel')}${k.R(12, 43.5, 24, 2.4, 1, 'dark')}
      ${k.P('M9 9h34l-5 26H4z', 'metal')}${k.P('M10.8 11h30.4l-4.2 22H6.8z', 'cell')}
      ${k.L('M17.5 11l-4.6 22M25.5 11l-3.4 22M33.5 11l-2.2 22M8.4 18.6h32.6M7.4 25.9h31.6', 'rgba(255,255,255,.55)', .9)}${k.HL('<path d="M12 12l16-1-9 21z" fill="#fff" opacity=".14"/>')}`,

    // ắc quy / UPS: vỏ đen, nắp, hai cực đỏ/đen, nhãn
    battery: (k) => `${k.SH(24, 44, 20)}${k.R(5, 14, 38, 28, 3, 'dark')}${k.R(5, 11, 38, 5, 1.5, 'rubber')}
      ${k.R(10, 7, 6, 5, 1, 'red')}${k.R(32, 7, 6, 5, 1, 'metal')}<text x="13" y="11" text-anchor="middle" font-size="4" font-weight="700" fill="#fff" font-family="Arial">+</text><text x="35" y="11" text-anchor="middle" font-size="4" font-weight="700" fill="#222" font-family="Arial">−</text>
      ${k.R(10, 21, 28, 14, 2, 'white')}<text x="24" y="31" text-anchor="middle" font-family="Arial,sans-serif" font-size="8" font-weight="800" fill="#1e293b">12V</text>
      ${k.HL('<path d="M8 17h32" stroke="#fff" stroke-opacity=".18" stroke-width="1.6"/>')}`,

    // băng tải: khung, dải băng có hàng con lăn hai đầu, thùng hàng trên băng, chân
    conveyor: (k) => `${k.SH(24, 45.5, 22)}${k.R(6, 36, 3, 8, 1, 'steel')}${k.R(39, 36, 3, 8, 1, 'steel')}
      ${k.R(2, 28, 44, 10, 5, 'rubber')}${k.HL('<rect x="6" y="30" width="36" height="2" rx="1" fill="#fff" opacity=".22"/>')}
      <g class="ic-rot" style="transform-origin:8px 33px">${k.C(8, 33, 4, 'metal')}${k.L('M8 29.5v7M4.5 33h7', 'rgba(0,0,0,.4)', 1)}</g><g class="ic-rot" style="transform-origin:40px 33px">${k.C(40, 33, 4, 'metal')}${k.L('M40 29.5v7M36.5 33h7', 'rgba(0,0,0,.4)', 1)}</g>
      ${k.R(12, 14, 14, 14, 1.5, 'brass')}${k.L('M12 19h14M19 14v5', 'rgba(0,0,0,.28)', 1)}${k.R(30, 19, 10, 9, 1.5, 'brass')}${k.L('M30 23h10', 'rgba(0,0,0,.28)', 1)}`,

    // cảm biến tiệm cận / cảm biến chung: thân trụ ren kim loại, đầu cảm biến, đèn LED, cáp
    sensor: (k) => `${k.SH(24, 45, 16)}${k.R(5, 19, 8, 11, 1, 'rubber')}${k.L('M5 24.5c-3 0-3 8-1 8', '#222', 2)}
      ${k.R(13, 16, 24, 17, 3, 'steel')}${k.L('M17 16.5v16M20 16.5v16M23 16.5v16M26 16.5v16M29 16.5v16', 'rgba(0,0,0,.25)', 1)}${k.R(37, 18, 6, 13, 2, 'dark')}
      ${k.C(41.5, 24.5, 2.8, 'sky')}${k.dot(25, 12.5, '#4ade80')}${k.R(21, 12, 8, 4.5, 1, 'dark')}
      ${k.HL('<path d="M15 19h20" stroke="#fff" stroke-opacity=".6" stroke-width="2" stroke-linecap="round"/>')}
      <g class="ic-pulse"><path d="M45 18c2 3 2 10 0 13" stroke="#38bdf8" stroke-width="1.4" fill="none" stroke-linecap="round"/></g>`,
  };

  // ----------------------------------------------------------------------------------------------------------------- phẳng hoá bản 3D cũ
  // ---- phần 2: các thiết bị còn lại trong danh mục ----
  const TXT = (x, y, s, size, fill, w = 700) => `<text x="${x}" y="${y}" text-anchor="middle" font-family="ui-monospace,Consolas,Arial,sans-serif" font-size="${size}" font-weight="${w}" fill="${fill}">${s}</text>`;
  Object.assign(DRAW, {
    // nồi hơi đứng: thân tròn, ống khói, cửa lò có lửa, đồng hồ áp
    boiler: (k) => `${k.SH(22, 45, 18)}${k.R(18.5, 2, 7, 10, 1, 'steel')}${k.R(17, 1, 10, 3, 1, 'dark')}${k.R(7, 40, 30, 4, 1, 'dark')}
      ${k.R(9, 10, 26, 30, 11, 'steel')}${k.HL('<path d="M13 16v18" stroke="#fff" stroke-opacity=".55" stroke-width="2.6" stroke-linecap="round"/>')}${k.L('M9 24h26', 'rgba(0,0,0,.22)', 1)}
      ${k.R(14.5, 28, 15, 9, 2, 'dark')}<g class="ic-pulse"><path d="M22 36c-3.6-2-3.6-5.6-1.4-8 0 2.4 2 3 2.4 1.2 2.6 1.4 4 5-1 6.8z" fill="#fb923c"/><path d="M22.4 36c-1.6-1-1.4-3 0-4.2.2 1.2 1.2 1.4 1.6.6 1 1 1 3-1.6 3.6z" fill="#fde047"/></g>
      ${k.C(30, 17, 3.6, 'white')}<path d="M30 17l1.6-1.6" stroke="#c62828" stroke-width=".9"/>${k.R(35, 24, 8, 3.4, 1, 'metal')}${k.R(35, 31, 8, 3.4, 1, 'metal')}`,

    // silo: mái vòm, thân trụ có đai, phễu côn, chân đỡ, thang
    silo: (k) => `${k.SH(24, 46, 18)}${k.R(13, 36, 2.4, 9, .5, 'dark')}${k.R(33, 36, 2.4, 9, .5, 'dark')}${k.R(21.5, 38, 5, 8, 1, 'steel')}
      ${k.P('M10 12v19l8 9h12l8-9V12z', 'metal')}${k.L('M10 20h28M10 28h28', 'rgba(0,0,0,.2)', 1)}
      ${k.P('M10 12a14 8 0 0 1 28 0z', 'steel')}${k.R(22, 2, 4, 4, 1, 'dark')}${k.HL('<path d="M14 14v15" stroke="#fff" stroke-opacity=".6" stroke-width="2.4" stroke-linecap="round"/>')}
      ${k.R(40, 12, 2, 26, .5, 'steel')}${k.L('M40 16h2M40 20h2M40 24h2M40 28h2M40 32h2', '#334155', 1)}`,

    // máy phát điện: động cơ đỏ + đầu phát, ống xả, khung đế
    generator: (k) => `${k.SH(24, 45.5, 22)}${k.R(2, 39, 44, 4, 1, 'dark')}${k.R(7, 6, 4, 12, 1, 'steel')}${k.R(5.5, 4.5, 7, 3, 1, 'dark')}
      ${k.R(3, 16, 22, 23, 3, 'red')}${k.L('M7 20h14M7 24h14M7 28h14M7 32h14', 'rgba(0,0,0,.28)', 1.2)}${k.HL('<path d="M5 18h18" stroke="#fff" stroke-opacity=".45" stroke-width="1.8" stroke-linecap="round"/>')}
      ${k.R(25, 20, 19, 19, 5, 'steel')}${k.L('M30 21v17M34 21v17M38 21v17', 'rgba(0,0,0,.26)', 1.2)}${k.R(29, 13, 11, 7, 1.5, 'dark')}${k.dot(34.5, 16.5, '#4ade80')}
      <g class="ic-pulse"><path d="M36 25l-4 6h3.4l-2 5 5.4-7h-3.6z" fill="#facc15"/></g>`,

    // máy biến áp: thùng dầu có cánh tản nhiệt, ba sứ xuyên đầu ra
    transformer: (k) => `${k.SH(24, 45.5, 20)}${k.R(5, 41, 38, 3, 1, 'dark')}
      ${[15, 24, 33].map((x) => `${k.R(x - 1.5, 6, 3, 11, 1, 'white')}${k.E(x, 8.6, 3.6, 1.2, 'white')}${k.E(x, 11.6, 3.6, 1.2, 'white')}${k.E(x, 14.6, 3.6, 1.2, 'white')}`).join('')}
      ${k.R(6, 20, 5, 19, 1.5, 'steel')}${k.R(37, 20, 5, 19, 1.5, 'steel')}${k.L('M8.5 22v15M39.5 22v15', 'rgba(0,0,0,.35)', 1)}
      ${k.R(11, 16, 26, 25, 3, 'steel')}${k.HL('<path d="M14 19h20" stroke="#fff" stroke-opacity=".55" stroke-width="2.2" stroke-linecap="round"/>')}${k.R(19, 27, 10, 8, 1, 'white')}${TXT(24, 33.2, '10kV', 5, '#334155')}`,

    // điều hoà treo tường: dàn lạnh trắng, cánh đảo gió, đèn báo, luồng gió
    hvac: (k) => `${k.R(3, 6, 42, 20, 6, 'white')}${k.R(7, 20, 34, 4.4, 2, 'metal')}${k.L('M9 14h30M9 17h30', 'rgba(0,0,0,.16)', 1.1)}${k.dot(38, 11, '#4ade80')}${TXT(14, 12, '24°', 5, '#475569')}
      ${k.HL('<path d="M8 8h26" stroke="#fff" stroke-opacity=".9" stroke-width="2" stroke-linecap="round"/>')}
      <g class="ic-flow" fill="none" stroke="${k.g ? '#7cc4ff' : '#5aa9f2'}" stroke-width="1.8" stroke-linecap="round"><path d="M10 30c4 3 4 7 0 10M20 30c4 3 4 9 0 13M30 30c4 3 4 7 0 10M40 30c-3 3-3 7 0 10"/></g>`,

    // cụm làm lạnh (chiller / dàn nóng): vỏ máy, lưới quạt, dàn trao đổi nhiệt
    chiller: (k) => `${k.SH(24, 45.5, 22)}${k.R(3, 41, 42, 3, 1, 'dark')}${k.R(4, 12, 40, 29, 3, 'white')}
      ${k.R(29, 14, 13, 25, 2, 'steel')}${k.L('M31 15v23M33.5 15v23M36 15v23M38.5 15v23M41 15v23', 'rgba(0,0,0,.35)', 1)}
      ${k.C(16, 26.5, 10.5, 'rubber')}<g class="ic-rot" style="transform-origin:16px 26.5px">${[0, 120, 240].map((a) => `<path transform="rotate(${a} 16 26.5)" d="M16 26.5c-2-5 0-8 3-8 2 0 2 3 0 5z" fill="${k.f('sky')}"/>`).join('')}</g>${k.C(16, 26.5, 2, 'metal')}
      <circle cx="16" cy="26.5" r="9.4" fill="none" stroke="${k.f('metal')}" stroke-width="1"/><circle cx="16" cy="26.5" r="5.4" fill="none" stroke="${k.f('metal')}" stroke-width=".9"/>
      ${k.R(14, 6, 4, 6, 1, 'metal')}${k.R(24, 8, 4, 4, 1, 'metal')}`,

    // gia nhiệt điện trở: hộp đấu dây, mặt bích, thanh gia nhiệt đỏ nóng
    heater: (k) => `${k.SH(26, 45, 20)}${k.R(1, 17, 11, 20, 2.5, 'dark')}${k.dot(6.5, 22, '#4ade80')}${k.R(11, 14, 5, 26, 1.5, 'steel')}${k.C(13.5, 17, 1, 'dark')}${k.C(13.5, 37, 1, 'dark')}
      <g fill="none" stroke-linecap="round"><path d="M16 21h24a3.2 3.2 0 0 1 0 6.4H16M16 29.4h24a3.2 3.2 0 0 1 0 6.4H16" stroke="${k.f('steel')}" stroke-width="4.2"/><path class="ic-pulse" d="M16 21h24a3.2 3.2 0 0 1 0 6.4H16M16 29.4h24a3.2 3.2 0 0 1 0 6.4H16" stroke="#f97316" stroke-width="2.4"/></g>
      <g class="ic-pulse" fill="none" stroke="#fb923c" stroke-width="1.6" stroke-linecap="round"><path d="M22 5c-2 2 2 4 0 7M30 5c-2 2 2 4 0 7M38 5c-2 2 2 4 0 7"/></g>`,

    // bộ lọc: đầu lọc xanh có hai cổng, cốc lọc trong, lõi lọc, xả đáy
    filter: (k) => `${k.SH(24, 46, 14)}${k.R(3, 8, 8, 6, 1, 'metal')}${k.R(37, 8, 8, 6, 1, 'metal')}${k.R(9, 6, 30, 9, 3, 'blue')}${k.C(24, 10.5, 2.4, 'white')}
      ${k.R(13, 15, 22, 26, 5, 'glass')}${k.R(18.5, 17, 11, 22, 2.5, 'white')}${k.L('M18.5 22h11M18.5 26h11M18.5 30h11M18.5 34h11', 'rgba(0,0,0,.2)', 1)}${k.HL('<path d="M15.5 19v18" stroke="#fff" stroke-opacity=".85" stroke-width="1.8" stroke-linecap="round"/>')}
      ${k.R(20.5, 41, 7, 3.4, 1, 'metal')}${k.R(22.5, 44, 3, 2.4, .5, 'steel')}`,

    // máy khuấy: bồn kính có chất lỏng, trục + cánh khuấy, động cơ trên đỉnh
    mixer: (k) => `${k.SH(24, 46, 16)}${k.R(17, 2, 14, 9, 2, 'blue')}${k.L('M20 3.5v6M24 3.5v6M28 3.5v6', 'rgba(0,0,0,.28)', 1)}${k.R(21, 11, 6, 4, 1, 'steel')}
      ${k.R(9, 15, 30, 29, 5, 'glass')}${k.R(10.2, 26, 27.6, 17, 4, 'liq', 'stroke="none"')}${k.R(22.8, 14, 2.4, 28, 1, 'steel')}
      <g class="ic-rot" style="transform-origin:24px 38px">${k.R(13, 36.6, 22, 2.8, 1.4, 'metal')}</g>
      ${k.HL('<path d="M12 19v20" stroke="#fff" stroke-opacity=".8" stroke-width="2" stroke-linecap="round"/>')}${k.R(8, 14, 32, 3, 1.4, 'steel')}`,

    // pH / chất lượng nước: cốc có dung dịch + điện cực đo, nhãn pH
    ph: (k) => `${k.SH(26, 46, 14)}${k.P('M10 14h26v26a4 4 0 0 1-4 4H14a4 4 0 0 1-4-4z', 'glass')}${k.P('M10.6 28c4-2.5 7 2.5 12 0s9 2 12.8 0v12a4 4 0 0 1-4 4H14.6a4 4 0 0 1-4-4z', 'liq', 'stroke="none"')}
      ${k.R(30, 3, 6.4, 33, 3, 'white')}${k.R(31.4, 8, 3.6, 4, 1, 'dark')}${k.C(33.2, 36, 3.6, 'glass')}${k.R(31, 1, 4.4, 3, 1, 'dark')}
      ${TXT(20, 24, 'pH', 8, k.g ? '#0f3d7a' : '#1d4ed8', 800)}${k.HL('<path d="M13 18v22" stroke="#fff" stroke-opacity=".8" stroke-width="2" stroke-linecap="round"/>')}`,

    // lưu lượng kế điện từ: ống đo hai mặt bích, đầu hiển thị trắng có LCD
    flow: (k) => `${k.SH(24, 45, 22)}${k.R(1, 25, 7, 10, 1, 'metal')}${k.R(40, 25, 7, 10, 1, 'metal')}${k.R(8, 24, 32, 12, 3, 'steel')}${k.R(5, 22, 4, 16, 1, 'metal')}${k.R(39, 22, 4, 16, 1, 'metal')}
      ${k.HL('<path d="M12 27h24" stroke="#fff" stroke-opacity=".6" stroke-width="2" stroke-linecap="round"/>')}
      ${k.R(20.5, 20, 7, 5, 1, 'dark')}${k.R(13, 5, 22, 16, 3, 'white')}${k.R(16, 8, 16, 8, 1.5, 'lcd')}${TXT(24, 14.4, '12.4', 6, '#7CFFB0')}${k.dot(32, 18.4, '#4ade80')}
      <g class="ic-flow" fill="none" stroke="${k.g ? '#38bdf8' : '#0ea5e9'}" stroke-width="1.6" stroke-linecap="round"><path d="M14 41h20M30 38.6l3 2.4-3 2.4"/></g>`,

    // cảm biến độ ẩm: hộp trắng, LCD %RH, khe thông gió, giọt nước
    humidity: (k) => `${k.SH(24, 46, 13)}${k.R(10, 4, 28, 38, 5, 'white')}${k.R(14, 8, 20, 11, 2, 'lcd')}${TXT(24, 16.4, '65%', 7.4, '#7CFFB0')}
      ${k.L('M15 24h18M15 27h18M15 30h18', 'rgba(0,0,0,.28)', 1.5)}${k.P('M24 32.5c-3.2 3.8-5 6.2-5 8.6a5 5 0 0 0 10 0c0-2.4-1.8-4.8-5-8.6z', 'sky')}${k.HL('<path d="M22 37.5a2.6 2.6 0 0 0-1 2.4" stroke="#fff" stroke-opacity=".9" stroke-width="1.2" fill="none" stroke-linecap="round"/>')}`,

    // aptomat 2 cực: vỏ trắng, hai cần gạt nối thanh, đầu vít, nhãn dòng định mức
    breaker: (k) => `${k.SH(24, 46, 16)}${k.R(8, 3, 32, 41, 2.5, 'white')}${k.R(8, 3, 32, 6, 1.5, 'metal')}${k.R(8, 38, 32, 6, 1.5, 'metal')}
      ${k.C(15, 6, 1.5, 'dark')}${k.C(33, 6, 1.5, 'dark')}${k.C(15, 41, 1.5, 'dark')}${k.C(33, 41, 1.5, 'dark')}
      ${k.R(12, 13, 10, 13, 2, 'dark')}${k.R(26, 13, 10, 13, 2, 'dark')}${k.R(12, 17.4, 24, 4.2, 1.5, 'dark')}${k.HL('<path d="M14 15h6M28 15h6" stroke="#fff" stroke-opacity=".35" stroke-width="1.4" stroke-linecap="round"/>')}
      ${k.R(12, 29, 24, 7, 1, 'white')}${TXT(24, 34.4, 'C32', 5.4, '#334155')}`,

    // đầu dò khí / khói: hộp vàng, đầu cảm biến lưới tròn, đèn LED, ống luồn dây
    gas: (k) => `${k.SH(24, 46, 13)}${k.R(21, 38, 6, 7, 1, 'metal')}${k.R(9, 5, 30, 34, 5, 'brass')}${k.C(24, 21, 10, 'rubber')}${k.C(24, 21, 7.4, 'dark')}
      <path d="M17.5 21h13M18.6 17h10.8M18.6 25h10.8M20.6 13.6h6.8M20.6 28.4h6.8" stroke="${k.f('metal')}" stroke-width="1"/>${k.dot(14, 9.6, '#4ade80')}${k.dot(34, 9.6, '#ef4444')}${TXT(24, 36.8, 'GAS', 4.6, '#3b2a05', 800)}
      <g class="ic-pulse" fill="none" stroke="#94a3b8" stroke-width="1.3" stroke-linecap="round" opacity=".9"><path d="M3 12c3-2-2-5 1-7M45 12c-3-2 2-5-1-7"/></g>`,

    // cảm biến rung: thân trụ thép, đai ốc lục giác, chân vít, đầu nối cáp, sóng rung
    vibration: (k) => `${k.SH(24, 46, 14)}${k.R(20, 39, 8, 6, 1, 'steel')}${k.L('M20 41h8M20 43h8', 'rgba(0,0,0,.4)', .9)}${k.P('M12 33l3-5h18l3 5v5H12z', 'metal')}
      ${k.R(14, 11, 20, 20, 4, 'steel')}${k.L('M14 18h20M14 24h20', 'rgba(0,0,0,.25)', 1)}${k.HL('<path d="M17 13h14" stroke="#fff" stroke-opacity=".6" stroke-width="1.8" stroke-linecap="round"/>')}
      ${k.R(20.5, 4, 7, 8, 2, 'dark')}${k.R(22, 1.5, 4, 3, 1, 'metal')}
      <g class="ic-pulse" fill="none" stroke="#38bdf8" stroke-width="1.6" stroke-linecap="round"><path d="M6 18c-2 3-2 8 0 11M42 18c2 3 2 8 0 11M2 16c-3 5-3 14 0 19M46 16c3 5 3 14 0 19"/></g>`,

    // cân bàn: mặt cân thép, cột đỡ, đầu hiển thị LCD, vật nặng
    scale: (k) => `${k.SH(22, 46, 20)}${k.R(5, 41, 4, 4, 1, 'dark')}${k.R(31, 41, 4, 4, 1, 'dark')}${k.R(4, 36, 32, 6, 2, 'dark')}${k.P('M3 36l4-5h26l4 5z', 'steel')}${k.R(8, 17, 14, 14, 1.5, 'brass')}${k.L('M8 22h14M15 17v5', 'rgba(0,0,0,.28)', 1)}
      ${k.R(36, 14, 4, 26, 1, 'metal')}${k.R(28, 3, 18, 12, 3, 'dark')}${k.R(30, 5, 14, 7, 1.2, 'lcd')}${TXT(37, 10.6, '5.2', 5.4, '#7CFFB0')}${k.HL('<path d="M8 33h24" stroke="#fff" stroke-opacity=".55" stroke-width="1.6" stroke-linecap="round"/>')}`,

    // đồng hồ tốc độ / đo: viền đen, mặt đen vạch trắng, kim cam
    gauge: (k) => `${k.SH(24, 46, 13)}${k.C(24, 23, 20, 'metal')}${k.C(24, 23, 17.4, 'dark')}${k.C(24, 23, 15.6, 'rubber')}
      ${k.L('M11.6 33.6l2.6-2M9 25h3.4M11.8 15.4l2.8 1.8M19 8l1.2 3M29 8l-1.2 3M36.2 15.4l-2.8 1.8M39 25h-3.4M36.4 33.6l-2.6-2', '#e5e7eb', 1.4)}
      <path d="M33.8 12.2a15.6 15.6 0 0 1 3.8 6.4" fill="none" stroke="#ef4444" stroke-width="2.4" stroke-linecap="round"/>${TXT(24, 36, 'RPM', 4.8, '#cbd5e1')}
      <g class="ic-needle" style="transform-origin:24px 23px"><path d="M24 23l-8-8" stroke="#fb923c" stroke-width="1.9" stroke-linecap="round"/></g>${k.C(24, 23, 2.4, 'metal')}
      ${k.HL('<path d="M11 14a15 15 0 0 1 11-7" stroke="#fff" stroke-opacity=".5" stroke-width="2" fill="none" stroke-linecap="round"/>')}`,

    // bộ đếm / sản lượng: mặt nạ đen, màn LCD số, ba nút, nhãn
    counter: (k) => `${k.SH(24, 44, 17)}${k.R(5, 9, 38, 30, 3, 'dark')}${k.R(8, 12, 32, 13, 2, 'lcd')}${TXT(24, 22.6, '00128', 9, '#7CFFB0')}
      ${k.R(9, 29, 8, 5.6, 1.4, 'metal')}${k.R(20, 29, 8, 5.6, 1.4, 'metal')}${k.R(31, 29, 8, 5.6, 1.4, 'metal')}${k.dot(36, 15, '#f59e0b')}${k.HL('<path d="M9 13.5h30" stroke="#fff" stroke-opacity=".12" stroke-width="1.4"/>')}`,

    // đầu vào số: nút nhấn công nghiệp xanh có vành kim loại + thân lắp tủ
    di: (k) => `${k.SH(24, 45, 15)}${k.R(15, 35, 18, 9, 2, 'dark')}${k.E(24, 33, 17, 5.4, 'steel')}${k.R(10, 27, 28, 7, 2, 'metal')}
      ${k.P('M12 27a12 12 0 0 1 24 0z', 'green')}${k.HL('<path d="M16 22a8 8 0 0 1 6-5" stroke="#fff" stroke-opacity=".75" stroke-width="2" fill="none" stroke-linecap="round"/>')}
      <path d="M24 5v8M20 9l4 4 4-4" fill="none" stroke="${k.g ? '#4ade80' : '#2e9e5b'}" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="ic-pulse"/>`,

    // đầu ra số: đèn báo tủ điện đỏ có vành kim loại, toả sáng
    do: (k) => `${k.SH(24, 45, 15)}${k.R(15, 35, 18, 9, 2, 'dark')}${k.E(24, 33, 17, 5.4, 'steel')}${k.R(10, 27, 28, 7, 2, 'metal')}
      ${k.P('M12 27a12 12 0 0 1 24 0z', 'red')}${k.HL('<path d="M16 22a8 8 0 0 1 6-5" stroke="#fff" stroke-opacity=".8" stroke-width="2" fill="none" stroke-linecap="round"/>')}
      <path d="M24 5v-2M12 8l-2-2M36 8l2-2M6 16H4M42 16h2" stroke="#fbbf24" stroke-width="1.8" stroke-linecap="round" class="ic-pulse"/>`,

    // nút nguồn chạy/dừng: nút tròn xanh có ký hiệu nguồn, viền đen
    power: (k) => `${k.SH(24, 46, 15)}${k.C(24, 24, 20, 'dark')}${k.C(24, 24, 16.4, 'steel')}${k.C(24, 24, 14, 'green')}
      <path d="M24 14v10" stroke="#fff" stroke-width="3.2" stroke-linecap="round"/><path d="M17.6 18a9 9 0 1 0 12.8 0" fill="none" stroke="#fff" stroke-width="3.2" stroke-linecap="round"/>${k.HL('<path d="M13 17a13 13 0 0 1 9-6" stroke="#fff" stroke-opacity=".55" stroke-width="2.2" fill="none" stroke-linecap="round"/>')}`,

    // đồng hồ treo tường: viền đen, mặt trắng chia vạch, kim giờ/phút/giây
    clock: (k) => `${k.SH(24, 46, 14)}${k.C(24, 24, 21, 'dark')}${k.C(24, 24, 18, 'white')}
      ${k.L('M24 8v2.6M24 37.4V40M8 24h2.6M37.4 24H40M12.7 12.7l1.8 1.8M33.5 33.5l1.8 1.8M35.3 12.7l-1.8 1.8M14.5 33.5l-1.8 1.8', '#475569', 1.5)}
      ${k.L('M24 24V13.5', '#1e293b', 2.4)}${k.L('M24 24l7 4', '#1e293b', 2)}<g class="ic-rot" style="transform-origin:24px 24px"><path d="M24 27V10" stroke="#dc2626" stroke-width="1" stroke-linecap="round"/></g>${k.C(24, 24, 1.8, 'dark')}
      ${k.HL('<path d="M11 17a14 14 0 0 1 10-8" stroke="#fff" stroke-opacity=".9" stroke-width="2" fill="none" stroke-linecap="round"/>')}`,

    // cửa cuốn: khung, các thanh lá thép, hộp trục cuốn phía trên, tay nắm
    door: (k) => `${k.SH(24, 46, 18)}${k.R(5, 3, 38, 41, 2, 'dark')}${k.R(8, 10, 32, 31, 1, 'metal')}${k.R(4, 3, 40, 8, 3, 'steel')}
      ${k.L('M8 15h32M8 20h32M8 25h32M8 30h32M8 35h32', 'rgba(0,0,0,.28)', 1.3)}${k.HL('<path d="M11 12v28" stroke="#fff" stroke-opacity=".45" stroke-width="2" stroke-linecap="round"/>')}
      ${k.R(19, 37, 10, 2.6, 1, 'dark')}${k.R(8, 40, 32, 2.4, .6, 'dark')}`,

    // cầu trục: hai dầm ngang vàng, chân đỡ, xe con, cáp và móc có tải
    crane: (k) => `${k.SH(24, 46, 21)}${k.R(3, 40, 8, 4, 1, 'dark')}${k.R(37, 40, 8, 4, 1, 'dark')}${k.R(5, 10, 4, 31, 1, 'steel')}${k.R(39, 10, 4, 31, 1, 'steel')}
      ${k.R(2, 5, 44, 7, 2, 'brass')}${k.L('M4 8.5h40', 'rgba(0,0,0,.25)', 1)}${k.R(17, 12, 14, 6, 1.5, 'dark')}${k.C(20.5, 19, 1.6, 'steel')}${k.C(27.5, 19, 1.6, 'steel')}
      ${k.L('M24 18v13', '#475569', 1.6)}${k.R(21, 30, 6, 5, 1.2, 'red')}<path d="M24 35v3a3 3 0 1 1-3 3" fill="none" stroke="${k.f('steel')}" stroke-width="1.8" stroke-linecap="round"/>${k.R(16, 41, 16, 3, 1, 'brass')}`,
  });

  const G3 = { metal: '#b9c4d2', steel: '#9aa9bb', dark: '#3d4651', glass: '#d3e9fb', liq: '#3b8be8', red: '#d64545', ball: '#c8d2de' };
  const flatten = (svg) => svg
    .replace(/url\(#g3-(\w+)\)/g, (_, n) => G3[n] || '#9aa9bb')
    .replace(/stroke="rgba\(0,0,0,\.38\)"/g, 'stroke="rgba(0,0,0,.2)"')
    .replace(/fill-opacity="\.\d+"/g, 'fill-opacity=".5"');

  const S = (inner) => `<svg class="ic icr" viewBox="0 0 48 48" aria-hidden="true">${inner}</svg>`;
  function build(mode) {
    const k = kit(mode);
    const out = {};
    for (const id of Object.keys(DRAW)) out[id] = () => S(DRAW[id](k));
    const old = window.PlcIcons3D || {};
    for (const id of Object.keys(old)) if (!out[id]) out[id] = mode === '3d' ? old[id] : () => flatten(old[id]()).replace('class="ic ic3"', 'class="ic ic3 icr"');
    return out;
  }
  // dựng muộn một lần (icons-3d*.js nạp trước file này; vẫn chịu được thứ tự khác)
  let cache = null;
  const get = () => cache || (cache = { '3d': build('3d'), flat: build('flat') });
  window.PlcIconsReal = { get: (shape, id) => get()[shape]?.[id], ids: () => Object.keys(get()['3d']) };

  function mountDefs() {
    if (document.getElementById('rl-defs')) return;
    const d = document.createElement('div'); d.id = 'rl-defs'; d.innerHTML = DEFS; document.body.appendChild(d);
  }
  if (document.body) mountDefs(); else document.addEventListener('DOMContentLoaded', mountDefs);
}());
