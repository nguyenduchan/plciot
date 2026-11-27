#!/usr/bin/env node
/**
 * Thử board Waveshare THẬT qua internet (chạy TRONG container plciot-app trên VPS — dùng đúng khoá server):
 *   logic  : rpc GET /api/offline → PUT chương trình thử (hẹn giờ 1 lần sau ~2 phút + maxon 40s, kèm appr) →
 *            chờ board tự bật/tắt (telemetry + /api/events logic_act) → trả lại chương trình cũ.
 *   ota    : cho phép cập nhật 15 phút (audit ota_approve + {sys:"ota_allow"} ký) → chờ board tải, cài, khởi động lại,
 *            nối lại cloud, qua kiểm tra sức khoẻ (GET /api/ota).
 *   status : chỉ đọc /api/ota, /api/offline, /api/events.
 *
 *   docker exec -w /app plciot-app node scripts/live-board-internet.js <site/device> <status|logic|ota> [--by ndhan1]
 */
import mqtt from 'mqtt';
import Database from 'better-sqlite3';
import { onRpcReply, callGateway } from '../src/remoteAdmin.js';
import { notifyGateway } from '../src/gatewayNotify.js';
import { readMcuRelease } from '../src/mcuOta.js';
import { audit } from '@plciot/security';

const [gw, mode = 'status'] = process.argv.slice(2);
const byArg = process.argv.indexOf('--by');
const BY = byArg > 0 ? process.argv[byArg + 1] : 'ndhan1';
const [site, device] = String(gw || '').split('/');
const db = new Database(`${process.env.DATA_DIR || '/app/data'}/app.db`);
const dev = db.prepare('SELECT mqtt_id FROM devices WHERE site = ? AND device = ?').get(site, device);
if (!dev?.mqtt_id) { console.error('không thấy gateway', gw); process.exit(2); }
const ID = dev.mqtt_id;
const t0 = Date.now();
const ts = () => `+${((Date.now() - t0) / 1000).toFixed(0).padStart(4)}s ${new Date(Date.now() + 7 * 3600e3).toISOString().slice(11, 19)}`;
const log = (...a) => console.log(ts(), ...a);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let pass = 0, fail = 0;
const check = (ok, what) => { ok ? pass++ : fail++; log(ok ? 'PASS' : 'FAIL', what); };

// ---- nghe board (user ingest, như server) ----
let lastMsg = 0; const seen = []; let doState = {};
const cli = mqtt.connect(process.env.MQTT_INGEST_URL || process.env.MQTT_URL, {
  username: process.env.MQTT_USER, password: process.env.MQTT_PASS, clientId: `live-test-${Math.random().toString(16).slice(2, 8)}`,
});
cli.on('connect', () => cli.subscribe(`gw/${ID}/#`));
cli.on('message', (topic, buf) => {
  const kind = topic.split('/')[2];
  lastMsg = Date.now();
  if (kind === 'rpcr') return onRpcReply(ID, buf);
  let m; try { m = JSON.parse(buf.toString()); } catch { m = null; }
  seen.push({ t: Date.now(), kind, m });
  if (kind === 'telemetry' || kind === 'state') {
    const d = m?.d || {};
    const dos = Object.fromEntries(Object.entries(d).filter(([k]) => /^do\d$|\.run$/.test(k)));
    if (JSON.stringify(dos) !== JSON.stringify(doState)) { if (Object.keys(dos).length) log(`  [${kind}] DO`, JSON.stringify(dos)); doState = dos; }
  } else if (kind === 'alert') log(`  [alert]`, m?.k, String(m?.txt || '').slice(0, 160));
  else if (kind === 'config') log(`  [config] ver=${m?.ver || m?.version || m?.fw || '?'} logic rev=${m?.logic?.rev}`);
  else if (kind !== 'cmd' && kind !== 'rpc') log(`  [${kind}]`, buf.toString().slice(0, 120));
});

const rpc = async (method, path, body, appr = '') => {
  const r = await callGateway(ID, { method, path, body: body ? JSON.stringify(body) : undefined, label: 'test-internet', mcu: true, appr });
  let b; try { b = JSON.parse(r.body); } catch { b = r.body; }
  return { st: r.status, b };
};
const otaInfo = async () => (await rpc('GET', '/api/ota')).b;
const events = async (n = 15) => {
  const r = await rpc('GET', '/api/events');
  const list = Array.isArray(r.b) ? r.b : (r.b?.Events || r.b?.events || []);
  return list.slice(-n);
};
const pe = (list) => list.forEach((e) => log('   ev', typeof e === 'string' ? e : JSON.stringify(e).slice(0, 200)));

async function waitOnline(ms) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    const r = await rpc('GET', '/api/ota');
    if (r.st === 200) return r.b;
    log('  chưa trả lời rpc:', r.st, JSON.stringify(r.b).slice(0, 80));
    await sleep(5000);
  }
  return null;
}

async function status() {
  const o = await waitOnline(60_000);
  check(Boolean(o), 'board trả lời rpc qua internet');
  if (!o) return;
  log('  /api/ota', JSON.stringify(o));
  log('  /api/offline', JSON.stringify((await rpc('GET', '/api/offline')).b));
  pe(await events(10));
}

/** Giờ địa phương board (tz phút) sau `addMin` phút: {hm, date}. */
const local = (tzMin, addMin) => {
  const d = new Date(Date.now() + addMin * 60e3 + tzMin * 60e3);
  return { hm: d.toISOString().slice(11, 16), date: d.toISOString().slice(0, 10) };
};

async function logic() {
  const o = await waitOnline(60_000);
  check(Boolean(o), 'board trả lời rpc qua internet'); if (!o) return;
  const cur = (await rpc('GET', '/api/offline')).b;
  check(cur && typeof cur.Rev === 'number', `đọc chương trình đang chạy (rev ${cur?.Rev})`);
  log('  chương trình gốc', JSON.stringify(cur));
  const tz = Number(cur.TzMin ?? 420);
  const on = local(tz, 2), off = local(tz, 4);
  const test = { TzMin: tz, Do: [{ Ch: 1, Mode: 'off', DelaySec: 60, MaxOnSec: 40, Timer: [{ On: on.hm, Off: off.hm, Date: on.date, Days: [] }] }] };
  const keep = { Rev: cur.Rev, TzMin: cur.TzMin, Do: cur.Do };

  // 1) thiếu appr → phải bị từ chối
  const noAppr = await rpc('PUT', '/api/offline', { Rev: cur.Rev, ...test });
  check(noAppr.st !== 200 || !noAppr.b?.Ok, `PUT thiếu appr bị từ chối (${noAppr.st} ${JSON.stringify(noAppr.b).slice(0, 60)})`);

  // 2) có appr → áp dụng
  const appr = `${BY}#livetest-${Date.now().toString(36)}`;
  const put = await rpc('PUT', '/api/offline', { Rev: cur.Rev, ...test }, appr);
  check(put.st === 200 && put.b?.Ok, `nạp chương trình thử qua internet → rev ${put.b?.Rev} (${put.st})`);
  if (!put.b?.Ok) return;
  audit(db, 'logic_timer', { userId: 15, ip: 'vps-test', detail: `${site}/${device} DO1: ${on.hm}→${off.hm} [1 lần ${on.date}] maxon 40s (test tự động qua internet) → rev ${put.b.Rev}` });
  const back = (await rpc('GET', '/api/offline')).b;
  check(back?.Rev === put.b.Rev && back?.Do?.[0]?.Timer?.[0]?.Date === on.date, 'đọc lại đúng chương trình vừa nạp (có Date = 1 lần)');
  log(`  chờ hẹn giờ: bật ${on.hm} (${on.date}), maxon 40s tự tắt…`);

  // 3) chờ board tự hành động
  const startT = Date.now();
  let sawOn = false, sawOff = false;
  while (Date.now() - startT < 5 * 60e3 && !(sawOn && sawOff)) {
    await sleep(10_000);
    const st = (await rpc('GET', '/api/offline')).b;
    const v = st?.Status?.Ch?.find((c) => c.Ch === 1)?.Out;
    if (v === 1 || v === true) { if (!sawOn) log('  DO1 = BẬT (theo /api/offline Status)'); sawOn = true; }
    else if (sawOn && (v === 0 || v === false)) { if (!sawOff) log('  DO1 = TẮT'); sawOff = true; }
    else if (v === undefined) log('  /api/offline Status:', JSON.stringify(st?.Status).slice(0, 200));
  }
  const ev = await events(20);
  const acts = ev.filter((e) => JSON.stringify(e).includes('logic_act'));
  pe(acts.slice(-4));
  check(sawOn, 'hẹn giờ 1 lần tự BẬT DO1 đúng giờ');
  check(sawOff, 'maxon 40s tự TẮT DO1');
  check(acts.length > 0, 'board ghi sự kiện logic_act');

  // 4) trả lại chương trình gốc
  const now = (await rpc('GET', '/api/offline')).b;
  const restore = await rpc('PUT', '/api/offline', { ...keep, Rev: now.Rev }, `${BY}#livetest-restore`);
  check(restore.st === 200 && restore.b?.Ok, `trả lại chương trình gốc → rev ${restore.b?.Rev}`);
}

async function ota() {
  const before = await waitOnline(60_000);
  check(Boolean(before), 'board trả lời rpc qua internet'); if (!before) return;
  log('  /api/ota trước', JSON.stringify(before));
  const verBefore = before.Version || before.version;
  const ch = String(verBefore).endsWith('-dev') ? 'dev' : '';
  const rel = readMcuRelease(process.env.RELEASES_DIR || '/app/releases', ch);
  if (!rel) { check(false, 'tìm thấy bản firmware trên server (kênh ' + (ch || 'chính') + ')'); return; }
  log(`  bản mới trên server: ${rel.version} (${rel.size} B)`);
  if (rel.version === verBefore) { log('  board đã chạy đúng bản này — không có gì để cập nhật'); return; }

  audit(db, 'ota_approve', { userId: 15, ip: 'vps-test', detail: `${site}/${device} ${verBefore} → ${rel.version} (15 phút) — test tự động qua internet` });
  const sentAt = Math.floor(Date.now() / 1000) - 5;
  const allowSeen = async () => (await events(40)).some((e) => e?.k === 'ota_allow' && Number(e.t) >= sentAt);
  notifyGateway(db, site, device, 'ota_allow', { ttl: 900, by: `${BY} (test)`, ver: rel.version });
  log('  đã gửi ota_allow (ký) → chờ board tải + cài…');
  await sleep(8000);
  const o1 = (await rpc('GET', '/api/ota')).b;
  log('  /api/ota sau cho phép', JSON.stringify(o1));
  // cửa sổ cho phép ĐÓNG ngay khi cài xong (board tải ~10 s) nên không xét Approved ở đây: sau khi board lên lại, xét nhật ký board có ota_allow

  // chờ board mất liên lạc (khởi động lại) rồi trở lại với bản mới
  const end = Date.now() + 10 * 60e3;
  let now = null, wentDown = false;
  while (Date.now() < end) {
    await sleep(10_000);
    const r = await rpc('GET', '/api/ota');
    if (r.st !== 200) { if (!wentDown) log('  board không trả lời (đang tải/khởi động lại?)', r.st); wentDown = true; continue; }
    now = r.b; const v = now.Version || now.version;
    if (v === rel.version) { log('  board đã lên', v, JSON.stringify(now)); break; }
    log('  vẫn', v, JSON.stringify(now).slice(0, 160));
  }
  check(await allowSeen().catch(() => false), 'board nhận lệnh cho phép (ota_allow trong nhật ký board)');
  check((now?.Version || now?.version) === rel.version, `board chạy ${rel.version} sau cập nhật qua internet`);
  if ((now?.Version || now?.version) !== rel.version) { pe(await events(20)); return; }

  // kiểm tra sức khoẻ: chờ xác nhận (≥60 s + mạng/ota/io)
  const end2 = Date.now() + 6 * 60e3;
  while (Date.now() < end2) {
    const r = (await rpc('GET', '/api/ota')).b;
    const s = JSON.stringify(r);
    log('  sức khoẻ', s.slice(0, 220));
    if (r && r.PendingVerify === false) { check(true, 'bản mới được XÁC NHẬN (qua kiểm tra sức khoẻ)'); break; }
    await sleep(20_000);
    if (Date.now() >= end2) check(false, 'bản mới được xác nhận trong 6 phút');
  }
  pe(await events(12));
}

cli.once('connect', async () => {
  try {
    log(`board ${gw} mqttId ${ID} — chế độ ${mode}`);
    if (mode === 'status') await status();
    else if (mode === 'logic') await logic();
    else if (mode === 'ota') await ota();
    else console.error('chế độ không rõ');
  } catch (e) { fail++; console.error(e); }
  log(`KẾT QUẢ: ${pass} đạt, ${fail} lỗi`);
  cli.end(); process.exit(fail ? 1 : 0);
});
