#!/usr/bin/env node
/**
 * E2E gateway GIẢ (không cần phần cứng) cho quy trình: admin tạo mã → gateway ghép cặp → có QR → user quét →
 * gateway gửi số liệu solar → user giám sát + điều khiển (gateway nhận lệnh, trả ack).
 * Chạy TRONG container app (127.0.0.1:3080 + broker nội bộ), vd:
 *   docker cp cloud/app/scripts/e2e-solar-gateway.js plciot-app:/app/scripts/
 *   docker exec -w /app plciot-app node scripts/e2e-solar-gateway.js [site] [phút]
 * In QR ra /tmp/e2e-solar-qr.txt rồi chạy tới khi hết phút (mặc định 20) hoặc bị Ctrl+C.
 */
import fs from 'node:fs';
import mqtt from 'mqtt';
import { makeGateway } from './gw-identity.js';

const BASE = process.env.E2E_BASE || 'http://127.0.0.1:3080';
const site = process.argv[2] || 'e2esolar';
const minutes = Number(process.argv[3] || 20);
const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);

const j = async (path, opt = {}) => {
  const r = await fetch(BASE + path, { ...opt, headers: { 'Content-Type': 'application/json', ...(opt.headers || {}) } });
  const body = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(`${path} → ${r.status} ${JSON.stringify(body)}`);
  return body;
};

const ls = await j('/api/admin/local-session');
const auth = { Authorization: `Bearer ${ls.token}` };
const made = await j('/api/admin/pairings', { method: 'POST', headers: auth, body: JSON.stringify({ site, label: 'E2E solar', auto: true }) });
log('mã ghép cặp', made.code, 'site', made.site);

const gw = makeGateway();
const config = {
  gw: 'GWSOLAR',
  devices: [{
    id: 'inv1', name: 'Inverter 1', icon: 'sun', color: 'amber',
    fields: [
      { key: 'pv_kw', lbl: 'Công suất PV', unit: 'kW', widget: 'gauge', min: 0, max: 10 },
      { key: 'load_kw', lbl: 'Tải', unit: 'kW', widget: 'gauge', min: 0, max: 10 },
      { key: 'grid_kw', lbl: 'Lưới', unit: 'kW', widget: 'gauge', min: -10, max: 10 },
      { key: 'batt_kw', lbl: 'Pin', unit: 'kW', widget: 'gauge', min: -10, max: 10 },
      { key: 'batt_soc', lbl: 'SOC', unit: '%', widget: 'tank', min: 0, max: 100 },
      { key: 'e_today', lbl: 'Hôm nay', unit: 'kWh', widget: 'gauge', min: 0, max: 100 },
      { key: 'e_total', lbl: 'Tổng', unit: 'kWh', widget: 'gauge', min: 0, max: 100000 },
      { key: 'run', lbl: 'Chạy inverter', widget: 'switch', writable: true, on: 'Đang chạy', off: 'Dừng' },
    ],
  }],
};
const pair = await j('/api/v1/gateway/pair', { method: 'POST', body: JSON.stringify(gw.pairBody(made.code, { config })) });
const mask = JSON.parse(JSON.stringify(pair, (k, v) => (/pass|secret|key/i.test(k) && typeof v === 'string' ? '***' : v)));
log('pair →', JSON.stringify(mask).slice(0, 1500));
if (!pair.approved) throw new Error('chưa tự duyệt: ' + JSON.stringify(pair));

const kit = pair.kit || pair;
const qr = pair.qr || kit.qr;
fs.writeFileSync('/tmp/e2e-solar-qr.txt', String(qr));
log('QR ghi /tmp/e2e-solar-qr.txt (', String(qr).length, 'ký tự )');
const m = kit.mqtt || {};
const topics = kit.topics || {};
// như gateway thật: nối MQTTS công khai theo kit (đúng cổng của nhóm broker được cấp); test không kiểm chứng chỉ vân tay TLS
const MQTT_URL = process.env.E2E_MQTT || `mqtts://${process.env.E2E_MQTT_HOST || m.host}:${m.port}`;
const cli = mqtt.connect(MQTT_URL, { rejectUnauthorized: false, username: m.username, password: m.password, clientId: `gw-sim-${Date.now() % 1e6}`, reconnectPeriod: 2000 });
let sending = false;
let run = 1;
const t0 = Date.now();
const val = (k) => {
  const t = (Date.now() - t0) / 1000; const sun = 0.6 + 0.4 * Math.sin(t / 8);
  const pv = run ? +(4.2 * sun).toFixed(2) : 0; const load = +(1.1 + 0.3 * Math.sin(t / 5)).toFixed(2);
  const batt = +Math.max(-1.5, Math.min(1.5, (pv - load) * 0.6)).toFixed(2);
  return { pv_kw: pv, load_kw: load, batt_kw: batt, grid_kw: +(load - pv + batt).toFixed(2), batt_soc: 62, e_today: 12.4, e_total: 18420, run }[k];
};
const publishData = () => {
  if (!sending) return;
  const d = { inv1: Object.fromEntries(['pv_kw', 'load_kw', 'grid_kw', 'batt_kw', 'batt_soc', 'e_today', 'e_total', 'run'].map((k) => [k, val(k)])) };
  cli.publish(topics.telemetry, JSON.stringify({ schema: 2, ts: Date.now(), d }), { qos: 0 });
};
cli.on('connect', () => {
  log('MQTT nối', MQTT_URL, 'as', m.username);
  cli.subscribe(topics.cmd, { qos: 1 });
  cli.publish(topics.status, 'online', { retain: true });
  cli.publish(topics.config, JSON.stringify(config), { retain: true });
});
cli.on('error', (e) => log('MQTT lỗi', e.message));
cli.on('message', (t, buf) => {
  const s = buf.toString(); log('CMD', t, s);
  let p = {}; try { p = JSON.parse(s); } catch { /* */ }
  if (p.sys === 'claimed') { sending = true; log('đã được user quét QR → bắt đầu gửi số liệu'); publishData(); return; }
  const key = p.field || p.key || Object.keys(p).find((k) => k === 'run');
  if (key === 'run' || p.run !== undefined) run = Number(p.v ?? p.value ?? p.run ?? 0) ? 1 : 0;
  cli.publish(topics.ack, JSON.stringify({ id: p.id, ok: true, cmd: p, run, ts: Date.now() }), { qos: 1 });
  publishData();
});
const iv = setInterval(publishData, 2000);
setTimeout(() => { clearInterval(iv); cli.end(); log('hết giờ'); process.exit(0); }, minutes * 60_000);
