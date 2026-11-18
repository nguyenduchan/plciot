/**
 * Smoke test "đang xem": nhịp từ webapp → báo gateway gửi nhanh (tối đa mỗi LIVE_RENEW_MS một lần/gateway). DB tạm trong bộ nhớ.
 */
import Database from 'better-sqlite3';
import { markViewing, resetViewing, LIVE_RENEW_MS, LIVE_TTL_SEC } from '../src/viewing.js';

let fail = 0;
const ok = (c, m) => { if (!c) fail++; console.log(`${c ? 'OK  ' : 'FAIL'} ${m}`); };

const db = new Database(':memory:');
db.exec(`CREATE TABLE devices (id INTEGER PRIMARY KEY, tenant_id TEXT, site TEXT, device TEXT, mqtt_id TEXT, status TEXT);
         CREATE TABLE user_devices (id TEXT, user_id INTEGER, site TEXT, gateway_device TEXT, created_at INTEGER);`);
const ins = db.prepare("INSERT INTO devices (tenant_id, site, device, mqtt_id, status) VALUES ('default', ?, ?, ?, 'active')");
ins.run('s1', 'gw1', 'aaaaaaaaaaaaaaaa'); ins.run('s2', 'gw2', 'bbbbbbbbbbbbbbbb');
db.prepare("INSERT INTO user_devices VALUES ('x', 1, 's2', 'gw2', 1)").run();
const user = { id: 1, tenant_id: 'default', notify_site: 's1', notify_device: 'gw1' };
const calls = [];
const notify = (_db, site, device, sys, extra) => calls.push({ site, device, sys, extra });

resetViewing();
const t0 = 1_000_000;
let r = markViewing(db, user, { now: t0, notify });
ok(r.ok && r.gateways === 2 && r.notified === 2 && calls.length === 2, 'nhịp đầu báo cả 2 gateway của người dùng');
ok(calls.every((c) => c.sys === 'live' && c.extra.ttl === LIVE_TTL_SEC), `tín hiệu sys:live kèm ttl ${LIVE_TTL_SEC} giây`);
r = markViewing(db, user, { now: t0 + 20_000, notify });
ok(r.notified === 0 && calls.length === 2, 'nhịp sau 20 giây chưa báo lại (chống dồn)');
r = markViewing(db, user, { now: t0 + LIVE_RENEW_MS + 1, notify });
ok(r.notified === 2 && calls.length === 4, `sau ${LIVE_RENEW_MS / 1000} giây báo gia hạn`);
ok(LIVE_TTL_SEC > LIVE_RENEW_MS / 1000 + 20, 'ttl lớn hơn chu kỳ gia hạn + nhịp webapp (không bị tắt giữa chừng)');
const other = { id: 2, tenant_id: 'default', notify_site: 'zz', notify_device: 'none' };
r = markViewing(db, other, { now: t0 + 100_000, notify });
ok(r.gateways === 0 && calls.length === 4, 'người dùng không có gateway thì không báo ai (không báo nhầm gateway người khác)');
console.log(fail ? `\n${fail} lỗi` : '\nTất cả đạt');
process.exit(fail ? 1 : 0);
