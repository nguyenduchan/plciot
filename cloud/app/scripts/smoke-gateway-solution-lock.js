#!/usr/bin/env node
/** Smoke: giải pháp (kiểu UI) của gateway do ADMIN gán và khoá — gateway báo `solution` kèm cấu hình thì server BỎ QUA. */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const shellDir = path.resolve(here, '../../../webapp');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'plciot-sollock-'));
process.env.SOLUTIONS_DIR = path.resolve(shellDir, '..', 'solutions');
process.env.SOLUTIONS_REGISTRY = path.join(tmp, 'solutions.json');
process.env.APP_JWT_SECRET = crypto.randomBytes(32).toString('hex');
process.env.MQTT_CONFIG_DIR = path.join(tmp, 'mqtt');
process.env.BUNDLE_AUTOSYNC = 'false';

const { openDb } = await import('../src/db.js');
const { setGatewaySolution, gatewaySolution } = await import('../src/gatewaySolution.js');
const { applyGatewayConfig } = await import('../src/gatewayConfig.js');
const { migrateUserDevices } = await import('../src/userDevices.js');

let fails = 0;
const ok = (c, l) => { if (!c) { fails++; console.error('FAIL', l); } else console.log('ok  ', l); };
const db = openDb(path.join(tmp, 'data'));
migrateUserDevices(db);
const cfg = (solution) => ({ gw: 'gwa', ...(solution === undefined ? {} : { solution }), devices: [{ id: 'b1', name: 'Lò hơi 1', fields: [{ key: 'temp_c', lbl: 'Nhiệt độ', widget: 'gauge' }] }] });

// gateway mới báo giải pháp lúc đầu: bị bỏ qua (chưa ai gán → cơ bản)
let r = applyGatewayConfig(db, { site: 's1', device: 'gwa', payload: cfg('boiler') });
ok(!r.error && gatewaySolution(db, 's1', 'gwa') === '', 'gateway tự báo "boiler" lúc đầu → bị bỏ qua');

// admin gán
const set = setGatewaySolution(db, 's1', 'gwa', 'boiler');
ok(set.ok && gatewaySolution(db, 's1', 'gwa') === 'boiler', 'admin gán "boiler" → có hiệu lực');

// gateway cố đổi sang giải pháp khác hoặc về cơ bản: không đổi
applyGatewayConfig(db, { site: 's1', device: 'gwa', payload: cfg('water') });
ok(gatewaySolution(db, 's1', 'gwa') === 'boiler', 'gateway báo "water" → giữ nguyên "boiler"');
applyGatewayConfig(db, { site: 's1', device: 'gwa', payload: cfg('') });
ok(gatewaySolution(db, 's1', 'gwa') === 'boiler', 'gateway báo rỗng (về cơ bản) → giữ nguyên "boiler"');

// admin đổi lại được
setGatewaySolution(db, 's1', 'gwa', 'water');
ok(gatewaySolution(db, 's1', 'gwa') === 'water', 'admin đổi sang "water" → được');
console.log(fails ? `${fails} FAIL` : 'all ok');
process.exit(fails ? 1 : 0);
