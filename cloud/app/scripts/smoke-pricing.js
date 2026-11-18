// Giá theo bảng gói DK10/DK20/DK30/DK100/DK300: gói theo tháng là TRỌN GÓI cố định (PLAN_CATALOG.priceVndMonth), gói DK300 trả một lần 10 năm theo widget.
import { priceByDays, pricesByDays, quoteForPlan } from '../src/pricing.js';
let fails = 0;
const ok = (c, m) => { if (!c) fails++; console.log(`${c ? 'ok  ' : 'FAIL'} ${m}`); };

let q = priceByDays('monitor', 11, 30);
ok(q.eligible && q.kind === 'monthly' && q.total === 199000 && q.code === 'DK30', `DK30 trọn gói ${q.total}đ/tháng`);
q = priceByDays('monitor', 30, 90);
ok(q.eligible && q.total === 199000, 'DK30: giá không đổi theo số widget, lưu tới 120 ngày');
q = priceByDays('monitor', 11, 365);
ok(!q.eligible && /tối đa 120 ngày/.test(q.reason), 'DK30 không cho lưu 365 ngày');
q = priceByDays('monitor', 100, 30);
ok(!q.eligible && /tối đa 90 widget/.test(q.reason), 'DK30 không quá 90 widget');
q = priceByDays('plus', 15, 90);
ok(q.eligible && q.total === 99000 && q.code === 'DK20', 'DK20: 99.000đ/tháng, lưu 90 ngày');
q = priceByDays('pro', 100, 365);
ok(q.eligible && q.total === 799000 && q.perYear === 7990000, 'DK100: 799.000đ/tháng, trả cả năm 10 tháng');
q = priceByDays('pro', 100, 730);
ok(!q.eligible, 'DK100 không lưu quá 365 ngày');
q = priceByDays('factory', 11, 7);
ok(q.eligible && q.kind === 'one_time' && q.days === null && q.total > 0, `DK300: ${q.total} một lần, không phụ thuộc số ngày`);
q = priceByDays('free', 3, 365);
ok(q.total === 0 && q.days === 30 && q.code === 'DK10', 'DK10: 0đ, lưu 30 ngày');
ok(quoteForPlan('monitor', 5).perYear === 199000 * 10, 'trả cả năm giảm 2 tháng');
ok(Object.keys(pricesByDays(11, 30)).length === 7, 'pricesByDays trả đủ 7 gói');
console.log(fails ? `${fails} lỗi` : 'smoke-pricing OK');
process.exit(fails ? 1 : 0);
