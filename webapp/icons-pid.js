'use strict';
/**
 * Bộ ký hiệu "P&ID / SCADA" cho kiểu hiển thị SCADA: hình học đơn giản, đơn sắc, theo THÔNG LỆ phổ biến của sơ đồ công nghệ
 * (ISA-5.1 / ISO 14617 / ISO 10628 / IEC 60617): bơm = vòng tròn + tam giác chiều chảy, van = hai tam giác chụm đỉnh (van điều khiển
 * có màng actuator), động cơ = vòng tròn "M", máy phát = "G", máy biến áp = hai vòng giao nhau, băng tải = hai con lăn + dây băng,
 * thiết bị đo = "bong bóng" ISA (vòng tròn + chữ cái đo: T nhiệt độ, P áp suất, F lưu lượng, L mức, A phân tích…).
 * Tự vẽ từng nét (không sao chép tệp/đường vẽ của thư viện nào). Đối chiếu lại với bảng ký hiệu (legend) của dự án trước khi in bản vẽ chính thức.
 */
(function () {
  const S = (inner) => `<svg class="ic pid" viewBox="0 0 48 48" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${inner}</svg>`;
  const T = (txt, size = 17, y = 30) => `<text x="24" y="${y}" text-anchor="middle" font-size="${size}" font-weight="700" font-family="Arial,Helvetica,sans-serif" fill="currentColor" stroke="none">${txt}</text>`;
  const bubble = (txt, size) => S(`<circle cx="24" cy="24" r="17"/>${T(txt, size ?? (txt.length > 1 ? 14 : 18), txt.length > 1 ? 29 : 30)}`);
  const PID = {
    pump: () => S(`<circle cx="24" cy="26" r="13"/><path d="M4 26h7M37 26h7M24 13V7h10"/><path d="M19 19l12 7-12 7z"/>`),
    valve: () => S(`<path d="M6 22l18 10-18 10zM42 22L24 32 6 42"/><path d="M42 22v20L24 32z"/><path d="M24 32V18"/><path d="M14 18a10 8 0 0 1 20 0z"/>`),
    tank: () => S(`<path d="M12 12a12 5 0 0 1 24 0v24a12 5 0 0 1-24 0z"/><path d="M12 12a12 5 0 0 0 24 0"/><path d="M4 22h8M36 34h8"/>`),
    silo: () => S(`<path d="M12 8h24v20l-8 12h-8l-8-12z"/><path d="M12 8c0-3 24-3 24 0"/>`),
    motor: () => S(`<circle cx="24" cy="24" r="16"/>${T('M', 20, 31)}<path d="M40 24h5"/>`),
    generator: () => S(`<circle cx="24" cy="24" r="16"/>${T('G', 20, 31)}`),
    vfd: () => S(`<rect x="6" y="9" width="36" height="30" rx="2"/><path d="M12 24c3-8 6-8 7 0s4 8 7 0 5-8 7 0"/>`),
    fan: () => S(`<circle cx="24" cy="24" r="16"/><path d="M24 24l10-8M24 24l0 12M24 24L14 16"/><circle cx="24" cy="24" r="2" fill="currentColor"/>`),
    compressor: () => S(`<circle cx="24" cy="24" r="16"/><path d="M13 15l22 7M13 33l22-7"/>`),
    conveyor: () => S(`<circle cx="12" cy="27" r="6"/><circle cx="36" cy="27" r="6"/><path d="M12 21h24M12 33h24"/>`),
    mixer: () => S(`<path d="M12 12h24v20a12 6 0 0 1-24 0z"/><path d="M24 4v22M16 28h16"/>`),
    filter: () => S(`<rect x="8" y="12" width="32" height="24" rx="1"/><path d="M8 36L40 12" stroke-dasharray="5 4"/>`),
    boiler: () => S(`<rect x="7" y="10" width="34" height="28" rx="3"/><path d="M12 31l4-12 5 12 5-12 4 12 3-8"/>`),
    heater: () => S(`<rect x="7" y="12" width="34" height="24" rx="1"/><path d="M11 24h4l2-7 4 14 4-14 4 14 2-7h4"/>`),
    hvac: () => S(`<rect x="6" y="9" width="36" height="30" rx="2"/><circle cx="24" cy="24" r="9"/><path d="M24 24l6-5M24 24v9M24 24l-6-5"/>`),
    chiller: () => S(`<rect x="6" y="9" width="36" height="30" rx="2"/><path d="M24 14v20M15 19l18 10M15 29l18-10"/>`),
    energy: () => bubble('E'),
    generatorSet: () => '',
    battery: () => S(`<path d="M8 24h10M30 24h10"/><path d="M18 12v24M30 17v14"/><path d="M13 14v5M10.5 16.5h5"/>`),
    solar: () => S(`<path d="M8 18h32l4 20H4z"/><path d="M19 18l-2 20M29 18l2 20M6 28h36"/>`),
    transformer: () => S(`<circle cx="18" cy="24" r="10"/><circle cx="30" cy="24" r="10"/><path d="M3 24h5M40 24h5"/>`),
    breaker: () => S(`<path d="M24 6v12M24 18l-9 16M24 30v12"/><path d="M19 25l10 6M29 25l-10 6"/>`),
    relay: () => S(`<path d="M6 30h12M30 30h12"/><circle cx="18" cy="30" r="2.5" fill="currentColor"/><circle cx="30" cy="30" r="2.5" fill="currentColor"/><path d="M18 30l10-12"/>`),
    bulb: () => S(`<circle cx="24" cy="24" r="14"/><path d="M14 14l20 20M34 14L14 34"/>`),
    env: () => bubble('T'),
    humidity: () => bubble('M'),
    pressure: () => bubble('P'),
    flow: () => bubble('F'),
    tankLevel: () => '',
    ph: () => bubble('pH', 14),
    gas: () => bubble('AT', 14),
    sensor: () => bubble('S'),
    scale: () => bubble('W'),
    vibration: () => bubble('V'),
    gauge: () => bubble('I'),
    alarm: () => S(`<circle cx="24" cy="24" r="17"/>${T('A', 18, 30)}<path d="M24 4v3M42 12l-3 2M6 12l3 2"/>`),
    door: () => S(`<rect x="12" y="5" width="24" height="38" rx="1"/><path d="M12 5l14 5v30l-14 3"/>`),
    crane: () => S(`<path d="M8 42V8h32M8 8l32 8"/><path d="M34 16v14M30 30h8v8h-8z"/>`),
    plc: () => S(`<rect x="6" y="12" width="36" height="24" rx="2"/>${T('PLC', 14, 29)}`),
    counter: () => S(`<rect x="6" y="14" width="36" height="20" rx="2"/>${T('Σ', 18, 29)}`),
    di: () => S(`<rect x="8" y="8" width="32" height="32" rx="2"/><path d="M24 14v16M17 24l7 8 7-8"/>`),
    do: () => S(`<rect x="8" y="8" width="32" height="32" rx="2"/><path d="M24 34V18M17 24l7-8 7 8"/>`),
    power: () => S(`<path d="M24 6v18"/><path d="M14 12a16 16 0 1 0 20 0"/>`),
    clock: () => S(`<circle cx="24" cy="24" r="17"/><path d="M24 13v11l7 5"/>`),
    tank_: () => '',
  };
  delete PID.generatorSet; delete PID.tankLevel; delete PID.tank_;
  PID.level = PID.tank;
  window.PlcIconsPID = PID;
}());
