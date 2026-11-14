// Giá theo số ngày lưu (mặc định: VPS 260k, 15 GB, K=3, phí 4.000đ/widget).
import { priceByDays, pricesByDays } from '../src/pricing.js';
let fails = 0;
const ok = (c, m) => { if (!c) fails++; console.log(`${c ? 'ok  ' : 'FAIL'} ${m}`); };

let q = priceByDays('monitor', 11, 7);
ok(q.eligible && q.kind === 'monthly' && q.perWidget === 5000 && q.total === 99000, `Cơ bản 11 widget 7 ngày: ${q.perWidget}đ/widget → ${q.total} (tối thiểu 99.000)`);
q = priceByDays('monitor', 30, 30);
ok(q.eligible && q.perWidget === 8000 && q.total === 240000, `Cơ bản 30 widget 30 ngày: ${q.total}`);
q = priceByDays('monitor', 11, 90);
ok(!q.eligible && /tối đa 30 ngày/.test(q.reason), 'Cơ bản không cho lưu 90 ngày');
q = priceByDays('monitor', 31, 7);
ok(!q.eligible && /tối đa 30 widget/.test(q.reason), 'Cơ bản không quá 30 widget');
q = priceByDays('pro', 11, 30);
ok(q.eligible && q.total === 199000, `Nâng cao 11 widget 30 ngày: tối thiểu 199.000 (${q.total})`);
q = priceByDays('pro', 100, 365);
ok(q.eligible && q.perWidget === 43000 && q.total === 4300000, `Nâng cao 100 widget 365 ngày: ${q.total}`);
q = priceByDays('pro', 100, 730);
ok(!q.eligible, 'Nâng cao không lưu quá 365 ngày');
q = priceByDays('factory', 11, 7);
ok(q.eligible && q.kind === 'one_time' && q.total === 21010000 && q.days === null, `Nhà máy 11 widget: ${q.total} một lần, không phụ thuộc số ngày`);
q = priceByDays('free', 3, 365);
ok(q.total === 0 && q.days === 1, 'Miễn phí: 0đ, 1 ngày');
ok(Object.keys(pricesByDays(11, 30)).length === 4, 'pricesByDays trả đủ 4 gói');
console.log(fails ? `${fails} lỗi` : 'smoke-pricing OK');
process.exit(fails ? 1 : 0);
