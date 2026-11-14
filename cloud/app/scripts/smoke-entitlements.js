#!/usr/bin/env node
import fs from 'fs';
import os from 'os';
import path from 'path';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'plc-ent-'));
process.env.MQTT_CONFIG_DIR = path.join(tmp, 'cfg');
process.env.APP_JWT_SECRET = 'x'.repeat(32);
process.env.CONTROL_FROM_INTERNET = 'true';

const { openDb, upsertUser } = await import('../src/db.js');
const { hashPassword } = await import('../src/auth.js');
const {
  grantPlan, mayRemoteControl, subscriptionInfo, setRemoteControl, PLAN_CATALOG,
} = await import('../src/entitlements.js');

const db = openDb(tmp);
let fails = 0;
const ok = (c, l) => { if (!c) { fails++; console.error('FAIL', l); } else console.log('ok  ', l); };

process.env.SUBSCRIBE_REQUIRE_ACTIVATION = 'true';
const u = upsertUser(db, {
  username: 'ent_user', passwordHash: hashPassword('x'), folderPath: 's', version: '1',
});
ok(mayRemoteControl(u, { ip: '1.2.3.4' }).ok, 'chưa gán gói = gói miễn phí: có điều khiển');
ok(subscriptionInfo(u).plan === 'free' && subscriptionInfo(u).widgetLimit === 5, 'gói miễn phí giới hạn 5 widget');
const { applyWidgetLimit } = await import('../src/uiContract.js');
const fakeNodes = Array.from({ length: 4 }, (_, i) => ({ id: String(i), widgets: [{ id: 'a' + i }, { id: 'b' + i }] }));
const lim = applyWidgetLimit(fakeNodes, 5);
ok(lim.total === 8 && lim.locked === 3, 'vượt 5 widget: 3 widget cuối bị khoá');
ok(lim.nodes[2].widgets[0].locked !== true && lim.nodes[2].widgets[1].locked === true && lim.nodes[3].widgets.every((w) => w.locked), 'khoá đúng thứ tự (widget thứ 6 trở đi)');
ok(applyWidgetLimit(fakeNodes, null).locked === 0, 'không giới hạn thì không khoá');

ok(grantPlan(db, u.id, 'monitor').ok, 'grant monitor');
let fresh = db.prepare('SELECT * FROM users WHERE id = ?').get(u.id);
ok(subscriptionInfo(fresh).remoteControl === true, 'mọi gói đều có điều khiển (monitor)');
ok(mayRemoteControl(fresh, { ip: '1.2.3.4' }).ok, 'monitor: điều khiển được');
ok(subscriptionInfo(fresh).widgetLimit === 30, 'Cơ bản: tối đa 30 widget');

ok(grantPlan(db, u.id, 'pro', { expiresAt: '2099-01-01' }).ok, 'grant pro');
fresh = db.prepare('SELECT * FROM users WHERE id = ?').get(u.id);
ok(mayRemoteControl(fresh, { ip: '8.8.8.8' }).ok, 'pro: control ok');
ok(fresh.retention_days === PLAN_CATALOG.pro.retention, 'pro retention 30');

ok(grantPlan(db, u.id, 'pro', { expiresAt: '2020-01-01' }).ok, 'expired plan');
fresh = db.prepare('SELECT * FROM users WHERE id = ?').get(u.id);
ok(mayRemoteControl(fresh, { ip: '8.8.8.8' }).reason === 'plan_expired', 'expired blocked');

grantPlan(db, u.id, 'pro', { expiresAt: 'never' });
setRemoteControl(db, u.id, false);
fresh = db.prepare('SELECT * FROM users WHERE id = ?').get(u.id);
ok(mayRemoteControl(fresh, { ip: '8.8.8.8' }).reason === 'remote_control_off', 'revoke-control');

process.env.CONTROL_FROM_INTERNET = 'false';
process.env.CONTROL_LAN_CIDRS = '203.0.113.0/24';
setRemoteControl(db, u.id, true);
fresh = db.prepare('SELECT * FROM users WHERE id = ?').get(u.id);
ok(mayRemoteControl(fresh, { ip: '1.2.3.4' }).reason === 'control_lan_only', 'internet blocked');
ok(mayRemoteControl(fresh, { ip: '203.0.113.10' }).ok, 'factory IP allowed');

console.log(fails ? `FAILED ${fails}` : 'smoke-entitlements OK');
process.exit(fails ? 1 : 0);
