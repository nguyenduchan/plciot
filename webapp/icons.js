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
    // ---- bổ sung: thiết bị công nghiệp ----
    silo: () => S(`<path d="M12 8h24v22l-12 10-12-10z"/><path d="M12 8c0-3 24-3 24 0"/><path d="M20 40v4h8v-4"/><path class="ic-flow" d="M24 14v16"/>`),
    boiler: () => S(`<rect x="8" y="8" width="26" height="32" rx="8"/><path d="M34 16h7M34 30h7M14 14h12"/><path class="ic-pulse" d="M21 36c-5-3-5-8-1-12 0 4 3 5 4 2 3 2 5 7-3 10z" fill="currentColor" fill-opacity=".3"/>`),
    compressor: () => S(`<rect x="6" y="24" width="30" height="14" rx="7"/><circle cx="14" cy="14" r="5"/><g class="ic-rot"><path d="M14 10v8M10 14h8"/></g><path d="M14 19v5M36 31h8"/><path class="ic-flow" d="M36 31h7"/><path d="M10 41v3M32 41v3"/>`),
    filter: () => S(`<path d="M6 8h36L28 26v14l-8-4V26z"/><path class="ic-flow" d="M24 30v6"/>`),
    vfd: () => S(`<rect x="6" y="8" width="36" height="32" rx="5"/><path d="M12 15h6M30 15h6"/><path class="ic-flow" d="M10 28c3-8 6-8 7 0s4 8 7 0 6-8 7 0 4 6 7 0"/>`),
    mixer: () => S(`<path d="M10 14v20c0 4 5 6 14 6s14-2 14-6V14"/><path d="M10 14h28M24 4v22"/><g class="ic-rot"><path d="M14 31h20M24 27v8"/></g>`),
    heater: () => S(`<path d="M10 38c0-6 6-6 6-12s-6-6-6-12M22 38c0-6 6-6 6-12s-6-6-6-12M34 38c0-6 6-6 6-12s-6-6-6-12"/><path class="ic-pulse" d="M7 43h36"/>`),
    hvac: () => S(`<rect x="5" y="10" width="38" height="16" rx="4"/><path d="M10 21h28"/><path class="ic-flow" d="M14 31v9M24 31v11M34 31v9"/>`),
    chiller: () => S(`<g class="ic-rot"><path d="M24 5v38M8 14l32 20M8 34l32-20"/></g><path d="M20 8l4 3 4-3M20 40l4-3 4 3"/>`),
    generator: () => S(`<circle cx="24" cy="24" r="18"/><g class="ic-rot"><path d="M24 10v5M24 33v5M10 24h5M33 24h5"/></g><path class="ic-pulse" d="M26 17l-5 8h5l-3 7 8-10h-6z" fill="currentColor" fill-opacity=".3"/>`),
    battery: () => S(`<rect x="5" y="14" width="34" height="20" rx="4"/><path d="M39 21h4v6h-4"/><g class="ic-pulse"><path d="M11 20v8M17 20v8M23 20v8"/></g>`),
    solar: () => S(`<path d="M9 20h30l4 18H5z"/><path d="M17 20l-2 18M26 20l-1 18M33 20l3 18M7 29h34"/><g class="ic-rot"><circle cx="38" cy="8" r="4"/><path d="M38 1v2M38 13v2M31 8h2M43 8h2"/></g>`),
    transformer: () => S(`<circle cx="18" cy="24" r="10"/><circle cx="30" cy="24" r="10"/><path d="M4 24h4M40 24h4"/><path class="ic-pulse" d="M24 9v30"/>`),
    breaker: () => S(`<rect x="12" y="6" width="24" height="36" rx="4"/><path d="M18 16h12M18 33h12"/><path class="ic-pulse" d="M24 21v8"/>`),
    scale: () => S(`<rect x="8" y="33" width="32" height="8" rx="2"/><path d="M12 33l4-16h16l4 16"/><path class="ic-needle" d="M24 29l5-9"/>`),
    ph: () => S(`<path d="M19 6h10M21 6v12L10 38a4 4 0 0 0 4 6h20a4 4 0 0 0 4-6L27 18V6"/><path class="ic-wave" d="M13 33c4-3 7 3 11 0s7 3 11 0"/>`),
    gas: () => S(`<path d="M14 35a8 8 0 0 1-1-16 10 10 0 0 1 19-3 8 8 0 0 1 2 19z"/><path class="ic-flow" d="M17 41h14"/>`),
    vibration: () => S(`<path class="ic-pulse" d="M4 24h6l4-11 6 22 6-17 4 6h14"/>`),
    alarm: () => S(`<path d="M12 36V26a12 12 0 0 1 24 0v10z"/><path d="M8 41h32M24 6v4"/><g class="ic-pulse"><path d="M6 21l-3-2M42 21l3-2M10 11L7 8M38 11l3-3"/></g>`),
    door: () => S(`<rect x="12" y="5" width="24" height="38" rx="2"/><circle cx="30" cy="25" r="1.8" fill="currentColor" stroke="none"/><path class="ic-sw" d="M12 5l14 4v32l-14 2"/>`),
    crane: () => S(`<path d="M10 44V10M10 10h30M10 10l30 6"/><path class="ic-pulse" d="M34 16v14"/><path d="M30 30h8v7h-8zM6 44h10"/>`),
    counter: () => S(`<rect x="6" y="14" width="36" height="20" rx="4"/><g class="ic-pulse"><path d="M15 20v8M24 20v8M33 20v8"/></g>`),
    plc: () => S(`<rect x="8" y="6" width="32" height="36" rx="4"/><circle cx="16" cy="14" r="2"/><circle class="ic-pulse" cx="24" cy="14" r="2"/><circle cx="32" cy="14" r="2"/><path d="M14 24h20M14 31h20M14 38h12"/>`),
  };

  /**
   * DANH MỤC CHUẨN thiết bị công nghiệp → icon. Mã icon = id (cũng là mã `icon` gateway gửi, ≤16 ký tự a-z0-9_).
   * aliases: tên khác (Anh/Việt/mã loại của server) dùng để nhận ra thiết bị khi chỉ có tên hoặc loại.
   * anim: hiệu ứng khi chạy.
   */
  const CATALOG = [
    // Bơm – bồn – đường ống
    { id: 'pump', vi: 'Bơm', group: 'Chất lỏng', aliases: ['bom', 'pump', 'bơm', 'booster', 'submersible', 'bom chim', 'bơm chìm', 'bơm tăng áp', 'dosing', 'bơm định lượng'], anim: 'quay + nước chảy' },
    { id: 'tank', vi: 'Bồn / bể / mức nước', group: 'Chất lỏng', aliases: ['bon', 'bồn', 'be', 'bể', 'tank', 'level', 'muc nuoc', 'mức nước', 'reservoir', 'thung', 'thùng'], anim: 'sóng nước' },
    { id: 'silo', vi: 'Silo / phễu chứa', group: 'Chất lỏng', aliases: ['silo', 'hopper', 'phễu', 'bunker'], anim: 'dòng vật liệu' },
    { id: 'valve', vi: 'Van', group: 'Chất lỏng', aliases: ['van', 'valve', 'solenoid', 'van điện', 'van tu', 'actuator'], anim: 'dòng chảy khi mở' },
    { id: 'flow', vi: 'Lưu lượng kế', group: 'Chất lỏng', aliases: ['flow', 'flowmeter', 'luu luong', 'lưu lượng'], anim: 'sóng chảy' },
    { id: 'pressure', vi: 'Áp suất', group: 'Chất lỏng', aliases: ['pressure', 'ap suat', 'áp suất', 'psi', 'bar', 'transmitter'], anim: 'kim dao động' },
    { id: 'filter', vi: 'Bộ lọc', group: 'Chất lỏng', aliases: ['filter', 'loc', 'lọc', 'ro', 'strainer'], anim: 'dòng qua lọc' },
    { id: 'mixer', vi: 'Máy khuấy / trộn', group: 'Chất lỏng', aliases: ['mixer', 'agitator', 'khuay', 'khuấy', 'tron', 'trộn'], anim: 'cánh khuấy quay' },
    { id: 'ph', vi: 'pH / chất lượng nước', group: 'Chất lỏng', aliases: ['ph', 'orp', 'chlorine', 'clo', 'turbidity', 'do duc', 'độ đục', 'chat luong nuoc', 'chất lượng nước'], anim: 'sóng dung dịch' },
    // Chuyển động
    { id: 'motor', vi: 'Động cơ', group: 'Chuyển động', aliases: ['motor', 'dong co', 'động cơ', 'engine', 'servo', 'spindle'], anim: 'trục quay' },
    { id: 'vfd', vi: 'Biến tần', group: 'Chuyển động', aliases: ['vfd', 'inverter', 'bien tan', 'biến tần', 'drive', 'softstarter', 'khởi động mềm'], anim: 'sóng sin chạy' },
    { id: 'fan', vi: 'Quạt / quạt thông gió', group: 'Chuyển động', aliases: ['fan', 'quat', 'quạt', 'blower', 'exhaust', 'thông gió', 'hút gió'], anim: 'cánh quay' },
    { id: 'compressor', vi: 'Máy nén khí', group: 'Chuyển động', aliases: ['compressor', 'may nen', 'máy nén', 'nén khí', 'air', 'vacuum', 'bơm chân không'], anim: 'quay + khí ra' },
    { id: 'conveyor', vi: 'Băng tải', group: 'Chuyển động', aliases: ['conveyor', 'bang tai', 'băng tải', 'belt', 'roller', 'con lăn'], anim: 'băng chạy' },
    { id: 'crane', vi: 'Cầu trục / palăng', group: 'Chuyển động', aliases: ['crane', 'cau truc', 'cầu trục', 'hoist', 'palang', 'palăng', 'lift', 'thang máy', 'elevator'], anim: 'móc nhấp nháy' },
    { id: 'door', vi: 'Cửa / cổng', group: 'Chuyển động', aliases: ['door', 'gate', 'cua', 'cửa', 'cong', 'cổng', 'barrier', 'shutter', 'cửa cuốn'], anim: 'cửa mở' },
    // Nhiệt – điều hoà
    { id: 'boiler', vi: 'Nồi hơi / lò hơi', group: 'Nhiệt', aliases: ['boiler', 'noi hoi', 'nồi hơi', 'lò hơi', 'steam', 'furnace', 'lò', 'oven'], anim: 'lửa nhấp nháy' },
    { id: 'heater', vi: 'Gia nhiệt / điện trở', group: 'Nhiệt', aliases: ['heater', 'gia nhiet', 'gia nhiệt', 'dien tro', 'điện trở', 'heating'], anim: 'nhiệt nhấp nháy' },
    { id: 'hvac', vi: 'Điều hoà / HVAC', group: 'Nhiệt', aliases: ['hvac', 'ac', 'dieu hoa', 'điều hoà', 'điều hòa', 'air conditioner', 'ahu', 'fcu'], anim: 'gió thổi' },
    { id: 'chiller', vi: 'Chiller / làm lạnh', group: 'Nhiệt', aliases: ['chiller', 'cooling', 'lam lanh', 'làm lạnh', 'lạnh', 'refrigeration', 'tháp giải nhiệt'], anim: 'bông tuyết quay' },
    { id: 'env', vi: 'Nhiệt độ', group: 'Nhiệt', aliases: ['env', 'temp', 'temperature', 'nhiet do', 'nhiệt độ', 'thermo', 'thermocouple', 'pt100', 'môi trường'], anim: 'nhấp nháy' },
    { id: 'humidity', vi: 'Độ ẩm', group: 'Nhiệt', aliases: ['humidity', 'do am', 'độ ẩm', 'hum'], anim: 'nhấp nháy' },
    // Điện
    { id: 'energy', vi: 'Đồng hồ điện năng', group: 'Điện', aliases: ['energy', 'meter', 'dien nang', 'điện năng', 'power', 'cong suat', 'công suất', 'kwh', 'electric', 'điện'], anim: 'tia điện' },
    { id: 'generator', vi: 'Máy phát điện', group: 'Điện', aliases: ['generator', 'may phat', 'máy phát', 'genset', 'alternator'], anim: 'quay + điện' },
    { id: 'battery', vi: 'Ắc quy / UPS', group: 'Điện', aliases: ['battery', 'ups', 'ac quy', 'ắc quy', 'pin', 'accu'], anim: 'sạc nhấp nháy' },
    { id: 'solar', vi: 'Điện mặt trời', group: 'Điện', aliases: ['solar', 'pv', 'mat troi', 'mặt trời', 'inverter solar', 'điện mặt trời'], anim: 'mặt trời quay' },
    { id: 'transformer', vi: 'Máy biến áp', group: 'Điện', aliases: ['transformer', 'bien ap', 'biến áp', 'mba'], anim: 'từ thông nhấp nháy' },
    { id: 'breaker', vi: 'Aptomat / tủ điện', group: 'Điện', aliases: ['breaker', 'aptomat', 'mccb', 'mcb', 'cb', 'tu dien', 'tủ điện', 'contactor', 'khởi động từ'], anim: 'tiếp điểm nhấp nháy' },
    { id: 'relay', vi: 'Rơ-le / công tắc', group: 'Điện', aliases: ['relay', 'switch', 'rơ le', 'rờ le', 'cong tac', 'công tắc', 'role'], anim: 'tiếp điểm đóng' },
    { id: 'bulb', vi: 'Đèn chiếu sáng', group: 'Điện', aliases: ['light', 'bulb', 'lamp', 'den', 'đèn', 'chieu sang', 'chiếu sáng'], anim: 'sáng nhấp nháy' },
    // Cảm biến – đo lường – an toàn
    { id: 'sensor', vi: 'Cảm biến chung', group: 'Cảm biến', aliases: ['sensor', 'cam bien', 'cảm biến', 'proximity', 'tiệm cận', 'detector', 'radar'], anim: 'sóng lan' },
    { id: 'gas', vi: 'Khí / khói / CO₂', group: 'Cảm biến', aliases: ['gas', 'co2', 'co', 'smoke', 'khoi', 'khói', 'khí', 'lpg', 'air quality', 'voc'], anim: 'khí nhấp nháy' },
    { id: 'vibration', vi: 'Rung động', group: 'Cảm biến', aliases: ['vibration', 'rung', 'rung động', 'accelerometer'], anim: 'sóng rung' },
    { id: 'scale', vi: 'Cân / loadcell', group: 'Cảm biến', aliases: ['scale', 'weight', 'loadcell', 'can', 'cân', 'khoi luong', 'khối lượng'], anim: 'kim cân' },
    { id: 'gauge', vi: 'Đồng hồ đo', group: 'Cảm biến', aliases: ['gauge', 'dong ho', 'đồng hồ', 'speed', 'rpm', 'tốc độ'], anim: 'kim dao động' },
    { id: 'alarm', vi: 'Cảnh báo / còi', group: 'An toàn', aliases: ['alarm', 'siren', 'coi', 'còi', 'canh bao', 'cảnh báo', 'estop', 'dừng khẩn', 'horn', 'beacon'], anim: 'nhấp nháy cảnh báo' },
    // Điều khiển – tín hiệu
    { id: 'plc', vi: 'PLC / bộ điều khiển', group: 'Điều khiển', aliases: ['plc', 'controller', 'bo dieu khien', 'bộ điều khiển', 'hmi', 'rtu', 'dcs'], anim: 'đèn trạng thái' },
    { id: 'counter', vi: 'Bộ đếm / sản lượng', group: 'Điều khiển', aliases: ['counter', 'count', 'dem', 'đếm', 'san luong', 'sản lượng', 'encoder'], anim: 'số nhấp nháy' },
    { id: 'di', vi: 'Đầu vào số', group: 'Điều khiển', aliases: ['di', 'input', 'dau vao', 'đầu vào', 'button', 'nut nhan', 'nút nhấn', 'limit'], anim: 'tĩnh' },
    { id: 'do', vi: 'Đầu ra số', group: 'Điều khiển', aliases: ['do', 'output', 'dau ra', 'đầu ra'], anim: 'tĩnh' },
    { id: 'power', vi: 'Nguồn / chạy-dừng', group: 'Điều khiển', aliases: ['run', 'start', 'enable', 'chay', 'chạy', 'bat', 'bật'], anim: 'tĩnh' },
    { id: 'clock', vi: 'Giờ chạy / thời gian', group: 'Điều khiển', aliases: ['hours', 'time', 'timer', 'gio chay', 'giờ chạy', 'runtime'], anim: 'tĩnh' },
    { id: 'gear', vi: 'Thiết bị chung / gateway', group: 'Điều khiển', aliases: ['gear', 'generic', 'custom', 'dynamic', 'iot-hub', 'gateway', 'device', 'thiết bị'], anim: 'bánh răng quay' },
  ];
  // khoá icon gateway/loại thiết bị → icon
  // ---- Nhận diện icon: mã icon → (khớp đúng id/alias) → (từ khoá trong tên/mã thiết bị) → icon chung ----
  const norm = (s) => String(s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/đ/g, 'd').replace(/[^a-z0-9]+/g, ' ').trim();
  const INDEX = new Map();                                   // alias đã chuẩn hoá → id icon
  for (const c of CATALOG) { INDEX.set(c.id, c.id); for (const a of c.aliases) { const k = norm(a); if (k && !INDEX.has(k)) INDEX.set(k, c.id); } }
  Object.entries({ switch: 'relay', temperature: 'env', 'conveyor v1': 'conveyor', 'conveyor-v1': 'conveyor' }).forEach(([a, id]) => INDEX.set(norm(a), id));
  // từ khoá dài (≥4 ký tự) tìm trong tên; ưu tiên theo thứ tự danh mục, alias dài trước
  const KEYWORDS = CATALOG.flatMap((c) => [c.id, ...c.aliases].map((a) => [norm(a), c.id])).filter(([k]) => k.length >= 4).sort((a, b) => b[0].length - a[0].length);
  function resolveOne(hint) {
    const n = norm(hint); if (!n) return null;
    if (INDEX.has(n)) return INDEX.get(n);
    // 1) cụm từ / từ khoá dài trước ("máy nén khí" thắng "khí"), 2) từng từ đơn (bỏ số đuôi: pump1 → pump)
    const hit = KEYWORDS.find(([k]) => n.includes(k));
    if (hit) return hit[1];
    for (const w of n.split(' ')) {
      const b = w.replace(/\d+$/, '');
      if (INDEX.has(w) && w.length >= 3) return INDEX.get(w);
      if (b.length >= 2 && INDEX.has(b)) return INDEX.get(b);
    }
    return null;
  }
  /** Chọn icon theo thứ tự ưu tiên: resolve('pump') hoặc resolve(['pump','Bơm tăng áp','pump1']). */
  function pick(...hints) {
    for (const h of hints.flat()) { const r = resolveOne(h); if (r && DEVICE[r]) return r; }
    return 'gear';
  }
  // khoá giá trị (key field MQTT) → icon nhỏ mô tả giá trị
  const VALUE = [
    [/^(level|lvl|muc|water)/i, 'tank'], [/^(t|temp|nhiet|tmp)\d*$|^(temp|nhiet)/i, 'env'], [/^(h|hum|do_am)\d*$|^(hum|do_am)/i, 'humidity'], [/(flow|luu)/i, 'flow'],
    [/^(p|press|ap_suat)\d*$|^(press|ap_suat)/i, 'pressure'], [/(speed|rpm|freq|^sp$|toc)/i, 'gauge'], [/(^kw|power|cong_suat|^kwh|energy|^v$|volt|^a$|amp|current|^i\d?$)/i, 'energy'],
    [/(hours|time|gio|runtime)/i, 'clock'], [/(^run|^q_|^on$|state|start|enable|bat|status)/i, 'power'], [/(count|cnt|dem|total)/i, 'counter'],
    [/(^ph|orp|chlor|clo)/i, 'ph'], [/(gas|co2|smoke|khoi|voc)/i, 'gas'], [/(vib|rung)/i, 'vibration'], [/(weight|mass|kg|can$)/i, 'scale'],
    [/(alarm|alm|fault|err|trip|canh_bao)/i, 'alarm'], [/(door|cua|gate)/i, 'door'], [/(batt|pin|soc|ups)/i, 'battery'], [/(heat|gia_nhiet|set_?t)/i, 'heater'],
  ];

  // kiểu chuyển động cả icon (spin = quay, bob = trôi nhẹ, sway = đung đưa, pulse = thở)
  const ANIM_KIND = { fan: 'spin', gear: 'spin', mixer: 'spin', chiller: 'spin', crane: 'sway', pump: 'bob', valve: 'bob', flow: 'bob', filter: 'bob', silo: 'bob', tank: 'bob', conveyor: 'bob', compressor: 'bob' };
  const NO_PARTS = new Set(['di', 'do', 'power', 'clock']);
  function device(name, opt = {}) {
    const id = Array.isArray(name) ? pick(name) : pick(name);
    // bộ hình "P&ID chuẩn" (icons-pid.js, mặc định) hoặc "Minh hoạ" — chọn riêng, không phụ thuộc kiểu nền 3D/hiện đại/SCADA
    // hình vẽ theo kiểu nền: SCADA = ký hiệu P&ID đơn sắc; Đẹp (3D) = hình thiết bị đổ khối (icons-3d.js); Hiện đại = nét mảnh
    const st = document.documentElement.dataset.icStyle;
    // Grafana / ThingsBoard / Material / Carbon: mỗi phong cách dùng bộ icon thật của hệ đó (icons-sets.js, giấy phép mở)
    // hiệu ứng cho bộ icon KHÔNG có bộ phận rời (Tabler/Material/Carbon/P&ID): chuyển động cả icon theo loại thiết bị
    const anim = ANIM_KIND[id] || 'pulse';
    const set = window.PlcIconSets?.[st]?.[id];
    if (set) {
      const attrs = st === 'grafana' ? 'fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"' : 'fill="currentColor"';
      return `<svg ${opt.speed != null ? `style="--spin:${opt.speed}s" ` : ''}class="ic icx ${opt.on ? 'on ' : ''}" data-anim="${anim}" viewBox="${set[0]}" ${attrs} aria-hidden="true">${set[1]}</svg>`;
    }
    const alt = st === 'scada' ? window.PlcIconsPID?.[id] : st === '3d' ? window.PlcIcons3D?.[id] : null;
    let html = alt ? alt() : DEVICE[id]();
    if ((st === 'scada' && alt) || (!alt && NO_PARTS.has(id))) html = html.replace('<svg ', `<svg data-anim="${anim}" `);   // icon nét mảnh không có bộ phận rời → chuyển động cả icon
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

  window.PlcIcons = { device, value, pick, spinSeconds, catalog: CATALOG, names: Object.keys(DEVICE) };
}());

/* ===== Kiểu hiển thị: người dùng chọn (lưu trên máy này) =====
 *   3d    — đẹp: ô icon nổi khối 3D, đổ bóng, hiệu ứng chuyển động (quay, nước chảy, sóng…)
 *   line  — hiện đại: icon nét mảnh phẳng có hiệu ứng chuyển động
 *   scada — SCADA: icon tĩnh, phẳng, không chuyển động; màu xanh = chạy, xám = dừng */
(function () {
  const STYLES = [
    { id: '3d', name: 'Đẹp (3D)', desc: 'Thiết bị đổ khối 3D, đồng hồ tròn, bồn kính' },
    { id: 'grafana', name: 'Grafana', desc: 'Panel tối, đồng hồ cung mảnh, ngưỡng xanh / vàng / đỏ, thanh bar gauge' },
    { id: 'thingsboard', name: 'ThingsBoard', desc: 'Thẻ sáng, đồng hồ tròn dày, icon tròn màu chàm' },
    { id: 'material', name: 'Material', desc: 'Thẻ nổi bo tròn, icon hai tông, đồng hồ cung dày' },
    { id: 'carbon', name: 'Carbon', desc: 'Phẳng vuông vức kiểu IBM, nét mảnh, thanh tiến trình' },
    { id: 'line', name: 'Hiện đại', desc: 'Icon nét mảnh gọn, đồng hồ tròn' },
    { id: 'scada', name: 'SCADA', desc: 'Ký hiệu P&ID phẳng, tĩnh, màu theo trạng thái chạy / dừng' },
  ];
  const KEY = 'icStyle';
  const get = () => { try { const v = localStorage.getItem(KEY); return STYLES.some((s) => s.id === v) ? v : '3d'; } catch { return '3d'; } };
  function set(id) {
    if (!STYLES.some((s) => s.id === id)) return;
    try { localStorage.setItem(KEY, id); } catch { /* */ }
    document.documentElement.dataset.icStyle = id;
    render(); document.dispatchEvent(new Event('plc-icstyle'));
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

/* ===== Màu sắc + chuyển động (lưu trên máy này) =====
 *  Màu: "auto" = màu riêng theo nhóm thiết bị (chất lỏng xanh dương, chuyển động xanh lá, nhiệt cam, điện vàng, cảm biến ngọc, an toàn đỏ, điều khiển tím)
 *       hoặc một bảng màu cố định cho mọi thẻ.
 *  Chuyển động: MẶC ĐỊNH TẮT (đỡ nóng máy, đỡ lag). Bật thì icon quay / nước chảy khi thiết bị chạy. */
(function () {
  const I = window.PlcIcons; if (!I) return;
  const COLORS = [
    { id: 'auto', name: 'Tự động' }, { id: 'blue', name: 'Xanh dương', sw: '#3b82f6' }, { id: 'green', name: 'Xanh lá', sw: '#22c55e' },
    { id: 'orange', name: 'Cam', sw: '#f97316' }, { id: 'purple', name: 'Tím', sw: '#a855f7' }, { id: 'rose', name: 'Hồng', sw: '#f43f5e' },
    { id: 'teal', name: 'Ngọc', sw: '#14b8a6' }, { id: 'gold', name: 'Vàng', sw: '#eab308' }, { id: 'mono', name: 'Xám bạc', sw: '#94a3b8' },
  ];
  const CAT = { 'Chất lỏng': 'fluid', 'Chuyển động': 'motion', 'Nhiệt': 'thermal', 'Điện': 'electric', 'Cảm biến': 'sensor', 'An toàn': 'safety', 'Điều khiển': 'ctrl' };
  const lsGet = (k, d) => { try { return localStorage.getItem(k) ?? d; } catch { return d; } };
  const lsSet = (k, v) => { try { localStorage.setItem(k, v); } catch { /* */ } };
  const getColor = () => { const v = lsGet('icColor', 'auto'); return COLORS.some((c) => c.id === v) ? v : 'auto'; };
  const getMotion = () => lsGet('icMotion', 'off') === 'on';
  /** Nhóm màu của một icon (fluid/motion/thermal/electric/sensor/safety/ctrl). */
  const category = (id) => CAT[(I.catalog.find((c) => c.id === id) || {}).group] || 'ctrl';
  function apply() { document.documentElement.dataset.icColor = getColor(); document.documentElement.dataset.icMotion = getMotion() ? 'on' : 'off'; }
  function setColor(id) { if (COLORS.some((c) => c.id === id)) { lsSet('icColor', id); apply(); render(); document.dispatchEvent(new Event('plc-icstyle')); } }
  const getShape = () => (lsGet('icShape', 'pid') === 'illust' ? 'illust' : 'pid');
  function setShape(s) { lsSet('icShape', s === 'illust' ? 'illust' : 'pid'); render(); document.dispatchEvent(new Event('plc-icstyle')); }
  function setMotion(on) { lsSet('icMotion', on ? 'on' : 'off'); apply(); render(); document.dispatchEvent(new Event('plc-icstyle')); }
  function render() {
    const host = document.getElementById('ic-colors');
    if (host) {
      const cur = getColor();
      host.innerHTML = COLORS.map((c) => `<button type="button" class="ic-swatch${c.id === 'auto' ? ' auto' : ''}${c.id === cur ? ' on' : ''}" data-c="${c.id}" aria-pressed="${c.id === cur}" style="--sw:${c.sw || 'transparent'}"><i></i>${c.name}</button>`).join('');
      host.querySelectorAll('.ic-swatch').forEach((b) => { b.onclick = () => setColor(b.dataset.c); });
    }
    const sh = document.getElementById('ic-shape');
    if (sh) {
      const cur = getShape();
      sh.innerHTML = [['pid', 'P&ID chuẩn', 'Ký hiệu công nghệ: bơm, van, bồn, M, G, bong bóng đo'], ['illust', 'Minh hoạ', 'Hình khối nét mảnh dễ nhìn']].map(([id, n, d]) => `<button type="button" class="ic-choice${id === cur ? ' on' : ''}" data-sh="${id}"><b>${n}</b><small>${d}</small></button>`).join('');
      sh.querySelectorAll('[data-sh]').forEach((b) => { b.onclick = () => setShape(b.dataset.sh); });
    }
    const m = document.getElementById('ic-motion');
    if (m) {
      m.innerHTML = `<label class="ic-motion"><input type="checkbox" id="ic-motion-cb" ${getMotion() ? 'checked' : ''}><span>Hiệu ứng chuyển động <small>(quay, nước chảy — tốn pin, dễ nóng máy; mặc định tắt)</small></span></label>`;
      m.querySelector('input').onchange = (e) => setMotion(e.target.checked);
    }
  }
  apply();
  document.addEventListener('DOMContentLoaded', render);
  Object.assign(I, { colors: COLORS, getColor, setColor, getMotion, setMotion, category, getShape, setShape });
}());
