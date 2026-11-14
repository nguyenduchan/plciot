/**
 * Đo sức chứa widget của VPS: mỗi widget gửi 1 tin/giây (docs/CHAT-COMPLIANCE.md → báo giá).
 * CÔ LẬP khỏi hệ thống thật: dùng broker mosquitto riêng (BENCH_MQTT_URL) và DB SQLite tạm (không đụng app.db).
 *
 *   node scripts/bench-capacity.js sub <widgets> <seconds>    # giống đường ingest: nhận tin → parse → ghi lô SQLite (mqtt_events)
 *   node scripts/bench-capacity.js pub <widgets> <seconds>    # phát <widgets> tin mỗi giây (mỗi widget 1 tin/giây)
 *
 * sub in một dòng JSON: tốc độ nhận thực, CPU (% một nhân), byte/dòng trong DB, RSS.
 * Chưa gồm: policy/tra cứu thiết bị của server thật (cộng thêm hệ số an toàn khi đặt PRICING_CAPACITY_WIDGETS).
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import mqtt from 'mqtt';
import { openDb } from '../src/db.js';
import { insertEvent } from '../src/historyStore.js';

const [role, wArg, sArg] = process.argv.slice(2);
const widgets = Math.max(1, Number(wArg) || 100);
const seconds = Math.max(5, Number(sArg) || 20);
const url = process.env.BENCH_MQTT_URL || 'mqtt://bench-mqtt:1883';
const GW = 20;   // số gateway giả (mỗi gateway chứa nhiều widget)
const mqttId = (g) => (g.toString(16).padStart(16, '0'));

if (role === 'pub') {
  const c = mqtt.connect(url, { clientId: 'bench-pub' });
  c.on('connect', () => {
    let sent = 0; const t0 = Date.now();
    const tick = () => {
      const now = Date.now();
      if (now - t0 > seconds * 1000) { console.log(JSON.stringify({ role: 'pub', widgets, sent, seconds })); c.end(true, () => process.exit(0)); return; }
      for (let i = 0; i < widgets; i++) {
        const g = i % GW;
        // 1 widget = 1 tin/giây, dạng schema 2 + d (như gateway thật) — khoảng 120–150 byte
        c.publish(`gw/${mqttId(g)}/telemetry`, JSON.stringify({ schema: 2, ts: now, d: { [`w${i}`]: { level: 62.1 + (i % 7), flow: 48, run: 1 } } }), { qos: 0 });
        sent++;
      }
    };
    setInterval(tick, 1000);
  });
} else if (role === 'sub') {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bench-'));
  const db = openDb(dir);
  const c = mqtt.connect(url, { clientId: 'bench-sub', clean: true });
  let rows = []; let flushing = false; let received = 0; let stored = 0;
  const insertMany = db.transaction((r) => { for (const x of r) insertEvent(db, x); });
  const flush = () => { flushing = false; if (!rows.length) return; const r = rows; rows = []; insertMany(r); stored += r.length; };
  c.on('connect', () => c.subscribe('gw/+/telemetry', { qos: 0 }));
  let started = null; let cpu0 = null; let t0 = 0;
  c.on('message', (topic, buf) => {
    if (!started) { started = true; cpu0 = process.cpuUsage(); t0 = Date.now(); }
    received++;
    const j = JSON.parse(buf.toString());   // như đường ingest: parse + lấy site/device
    const mid = topic.split('/')[1];
    rows.push({ ts: Date.now(), site: 'bench', device: mid, kind: 'telemetry', payload: buf.toString(), o: null, i: null, a: null, c: null, s: null });
    if (!flushing) { flushing = true; setImmediate(flush); }
    void j;
  });
  setTimeout(() => {
    flush();
    const el = (Date.now() - t0) / 1000;
    const cpu = process.cpuUsage(cpu0);
    db.pragma('wal_checkpoint(TRUNCATE)');
    const size = fs.statSync(path.join(dir, 'app.db')).size;
    const baseRows = db.prepare('SELECT COUNT(*) AS n FROM mqtt_events').get().n;
    console.log(JSON.stringify({
      role: 'sub', widgets, seconds: Math.round(el), received, stored, rate: Math.round(received / el),
      cpuPctOneCore: Math.round(((cpu.user + cpu.system) / 1e6 / el) * 100),
      bytesPerRowDb: baseRows ? Math.round(size / baseRows) : null, rssMb: Math.round(process.memoryUsage().rss / 1048576),
    }));
    c.end(true, () => { fs.rmSync(dir, { recursive: true, force: true }); process.exit(0); });
  }, (seconds + 3) * 1000);
} else {
  console.error('usage: bench-capacity.js sub|pub <widgets> <seconds>');
  process.exit(2);
}
