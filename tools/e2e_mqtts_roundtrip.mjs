/**
 * E2E: PC mqtts (vai trò C# gw) ↔ VPS ↔ webapp ingest + control (ctl).
 *   cd cloud/app && node ../../tools/e2e_mqtts_roundtrip.mjs
 */
import { createRequire } from 'module';
import { execFileSync } from 'child_process';
import { fileURLToPath } from 'url';
import path from 'path';

const require = createRequire(path.join(path.dirname(fileURLToPath(import.meta.url)), '../cloud/app/package.json'));
const mqtt = require('mqtt');

const HOST = process.env.MQTT_HOST || '14.225.224.218';
const MQTTS_PORT = Number(process.env.MQTTS_PORT || 48263);
const SITE = process.env.SITE || 'factory1';       // chỉ để tra DB phía server theo site/device
const DEVICE = process.env.DEVICE || 'plc01';
// topic = gw/<mqttId>: id MQTT ngẫu nhiên server cấp cho gateway (devices.mqtt_id)
const MQTT_ID = process.env.MQTT_ID || '';
if (!/^[0-9a-f]{16}$/.test(MQTT_ID)) { console.error('Đặt MQTT_ID=<16 hex> của gateway thử'); process.exit(2); }
const BASE = `gw/${MQTT_ID}`;
const GW_USER = process.env.MQTT_GW_USER || 'gw';
const GW_PASS = process.env.MQTT_GW_PASS || 'GwTest@2026Plc';
const MARK = `e2e-${Date.now()}`;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function ssh(remoteCmd) {
  return execFileSync('ssh', ['-o', 'BatchMode=yes', 'plciot-vps', remoteCmd], { encoding: 'utf8' });
}

function connectMqtts(opts) {
  return mqtt.connect(`mqtts://${HOST}:${MQTTS_PORT}`, {
    rejectUnauthorized: false,
    protocolVersion: 4,
    clean: true,
    connectTimeout: 15000,
    ...opts,
  });
}

function waitConnect(client, label) {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`${label} connect timeout`)), 15000);
    client.once('connect', () => { clearTimeout(t); console.log(`OK  ${label} connected`); resolve(); });
    client.once('error', (e) => { clearTimeout(t); reject(e); });
  });
}

function publish(client, topic, payload, retain = false) {
  return new Promise((resolve, reject) => {
    client.publish(topic, payload, { retain, qos: 0 }, (err) => (err ? reject(err) : resolve()));
  });
}

async function main() {
  const results = [];
  const ok = (c, msg) => { results.push([!!c, msg]); console.log(c ? 'OK ' : 'FAIL', msg); };

  const gw = connectMqtts({
    clientId: `scada-e2e-${Math.random().toString(16).slice(2, 8)}`,
    username: GW_USER,
    password: GW_PASS,
  });
  await waitConnect(gw, 'C#(gw) mqtts');

  // Subscribe cmd trước khi publish (như CloudBridge)
  const cmdGot = new Promise((resolve) => {
    gw.on('message', (topic, buf) => {
      if (topic === `${BASE}/cmd`) resolve(buf.toString());
    });
  });
  await new Promise((resolve, reject) => {
    gw.subscribe(`${BASE}/cmd`, { qos: 0 }, (err) => (err ? reject(err) : resolve()));
  });

  const regs = Array.from({ length: 40 }, (_, i) => (i === 6 ? 1 : i === 7 ? 42 : i === 14 ? 7 : 0));
  const tele = JSON.stringify({ schema: 1, r: regs, mark: MARK });
  await publish(gw, `${BASE}/status`, 'online', true);
  await publish(gw, `${BASE}/telemetry`, tele, true);
  console.log(`OK  C# published ${BASE}/telemetry mark=${MARK}`);

  await sleep(2000);

  // Webapp ingest (SQLite) — nguồn GET /api/history/*
  let lastPayload = '';
  try {
    lastPayload = ssh(`docker exec plciot-app node --input-type=module -e "import { openDb } from './src/db.js'; import { queryLastTelemetry, queryLastEvent } from './src/historyStore.js'; const db=openDb(process.env.DATA_DIR||'/app/data'); const t=queryLastTelemetry(db,{site:'${SITE}',device:'${DEVICE}'}); const s=queryLastEvent(db,{site:'${SITE}',device:'${DEVICE}',kind:'status'}); console.log(JSON.stringify({tele:t&&t.payload, status:s&&s.payload, ts:t&&t.t}));"`);
  } catch (e) {
    lastPayload = String(e.stdout || e.message || e);
  }
  ok(lastPayload.includes(MARK), `webapp ingest telemetry: ${lastPayload.slice(0, 200)}`);
  ok(lastPayload.includes('online'), `webapp ingest status online: ${lastPayload.slice(0, 120)}`);

  // Retained trên broker (webapp live MQTT cùng topic)
  let retained = '';
  try {
    retained = ssh(`bash -lc 'P=$(grep ^MQTT_NOTIFY_PASS= /root/plciot/cloud/.env | cut -d= -f2-); docker exec plciot-mqtt mosquitto_sub -h localhost -p 1884 -i e2e-ret -u ingest -P \"$P\" -t ${BASE}/telemetry -C 1 -W 5'`);
  } catch (e) {
    retained = String(e.stdout || e.message || e);
  }
  ok(retained.includes(MARK), `broker/webapp live retained: ${retained.slice(0, 140)}`);

  // Control: đường ctl giống sau POST /api/control/cmd
  const cmdPayload = JSON.stringify({ schema: 1, id: MARK, a: 6, v: 0 });
  try {
    ssh(`bash -lc 'P=$(grep ^MQTT_CONTROL_PASS= /root/plciot/cloud/.env | cut -d= -f2-); docker exec plciot-mqtt mosquitto_pub -h localhost -p 1884 -i e2e-ctl -u ctl -P \"$P\" -t ${BASE}/cmd -m '\\''${cmdPayload}'\\'''`);
    console.log('OK  webapp/ctl published cmd', cmdPayload);
  } catch (e) {
    ok(false, `ctl publish: ${e.message}`);
  }

  const cmdMsg = await Promise.race([cmdGot, sleep(10000).then(() => null)]);
  ok(!!(cmdMsg && cmdMsg.includes(MARK) && cmdMsg.includes('"a":6')), `C# nhận cmd từ webapp: ${cmdMsg}`);

  if (cmdMsg) {
    await publish(gw, `${BASE}/ack`, JSON.stringify({ id: MARK, ok: true }));
    console.log('OK  C# published ack');
  }

  gw.end(true);

  console.log('\n=== KẾT QUẢ ===');
  for (const [c, m] of results) console.log(c ? 'PASS' : 'FAIL', m);
  process.exit(results.some((x) => !x[0]) ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
