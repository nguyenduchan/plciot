// Kiểm thử end-to-end luồng Node-RED do gen_flows.py sinh (cần Node-RED + node-red-contrib-modbus, broker MQTT thử như `aedes`, PLC giả):
//   python tools/modbus_tcp_sim.py --port 5020 --hour 60
//   python tools/gen_flows.py --protocol modbus --plc-host 127.0.0.1 --plc-port 5020 --mqtt mqtt://127.0.0.1:21884 --serve modbus --modbus-server-port 21502 --no-influx --out <userDir>
//   SCADA_USERS='operator:operator:op-pass-1;viewer:viewer:view-pass-2' SCADA_ALLOW_REMOTE=false node-red --userDir <userDir> -s settings.js   (uiPort 21998, httpNodeMiddleware = edge/data/scada-auth.js)
//   node tools/edge_e2e.js            (EXPECT_REMOTE=true nếu chạy Node-RED với SCADA_ALLOW_REMOTE=true)
const mqtt = require('mqtt'); const net = require('net'); const http = require('http');
const BASE = 'plc/factory1/plc01'; const UI = 21998; const MBS = 21502;
const wait = (ms) => new Promise(r => setTimeout(r, ms));
let fails = 0; const ok = (c, l, x) => { if (!c) { fails++; console.log('FAIL', l, x === undefined ? '' : JSON.stringify(x)); } else console.log('ok  ', l); };
const ALLOW = process.env.EXPECT_REMOTE === 'true';

function req(method, path, user, pass, body, extra = {}) {
  return new Promise((resolve) => {
    const headers = { ...extra };
    if (user) headers.Authorization = 'Basic ' + Buffer.from(user + ':' + pass).toString('base64');
    let data; if (body) { data = JSON.stringify(body); headers['Content-Type'] = 'application/json'; headers['Content-Length'] = Buffer.byteLength(data); }
    const r = http.request({ host: '127.0.0.1', port: UI, path, method, headers }, (res) => { let b = ''; res.on('data', d => b += d); res.on('end', () => resolve({ s: res.statusCode, b })); });
    r.on('error', e => resolve({ s: 0, b: String(e) })); if (data) r.write(data); r.end();
  });
}
function mbReq(pdu) {
  return new Promise((resolve) => {
    const s = net.connect(MBS, '127.0.0.1'); const hdr = Buffer.alloc(7); hdr.writeUInt16BE(1, 0); hdr.writeUInt16BE(pdu.length + 1, 4); hdr[6] = 1;
    s.on('connect', () => s.write(Buffer.concat([hdr, pdu]))); s.on('data', d => { resolve(d); s.destroy(); }); s.on('error', () => resolve(null)); setTimeout(() => { resolve(null); s.destroy(); }, 3000);
  });
}

(async () => {
  const c = mqtt.connect('mqtt://127.0.0.1:21884', { username: 'x', password: 'x' });
  const seen = []; let tele = null; let status = null;
  c.on('message', (t, p) => { const k = t.slice(BASE.length + 1); seen.push([k, p.toString()]); if (k === 'telemetry') tele = JSON.parse(p.toString()).r; if (k === 'status') status = p.toString(); });
  await new Promise(r => c.on('connect', r)); c.subscribe(BASE + '/#');
  for (let i = 0; i < 40 && !tele; i++) await wait(500);
  ok(Array.isArray(tele) && tele.length === 40, 'telemetry 40 thanh ghi lên MQTT');
  ok(status === 'online', 'status online', status);
  for (let i = 0; i < 30 && !seen.some(m => m[0] === 'history'); i++) await wait(500);
  ok(seen.some(m => m[0] === 'history'), 'history lên MQTT');

  // --- lệnh từ MQTT (điện thoại/cloud) phải qua cổng điều khiển từ xa
  const acks = () => seen.filter(m => m[0] === 'ack').map(m => JSON.parse(m[1]));
  c.publish(BASE + '/cmd', JSON.stringify({ id: 'r1', a: 7, v: 33 })); await wait(1500);
  const a1 = acks().find(a => a.id === 'r1');
  if (ALLOW) { ok(a1 && a1.ok === true, 'remote bật: ghi D7 được chấp nhận', a1); await wait(2500); ok(tele && tele[7] === 33, 'PLC nhận D7=33 qua telemetry', tele && tele[7]); }
  else { ok(a1 && a1.ok === false && a1.err === 'remote_disabled', 'remote tắt: ghi bị từ chối remote_disabled', a1); ok(tele && tele[7] !== 33, 'PLC không đổi D7'); }
  c.publish(BASE + '/cmd', JSON.stringify({ id: 'r2', op: 'read', a: 100, n: 2 })); await wait(1500);
  const a2 = acks().find(a => a.id === 'r2'); ok(a2 && a2.ok === true && Array.isArray(a2.v), 'đọc từ xa luôn được phép', a2);
  c.publish(BASE + '/cmd', JSON.stringify({ id: 'r3', a: 0, v: 1 })); await wait(1200);
  const a3 = acks().find(a => a.id === 'r3'); ok(a3 && a3.ok === false, 'ghi D0 (ngoài whitelist) bị từ chối', a3);

  // --- /scada web
  ok((await req('GET', '/scada')).s === 401, '/scada không đăng nhập: 401');
  ok((await req('GET', '/scada', 'operator', 'sai')).s === 401, 'sai mật khẩu: 401');
  const pg = await req('GET', '/scada', 'viewer', 'view-pass-2'); ok(pg.s === 200 && pg.b.includes('SCADA'), 'viewer mở được trang', pg.s);
  const js = await req('GET', '/scada/app.js', 'viewer', 'view-pass-2'); ok(js.s === 200 && js.b.includes('/scada/api/state'), 'app.js phục vụ đúng');
  const st = await req('GET', '/scada/api/state', 'viewer', 'view-pass-2'); const sj = JSON.parse(st.b);
  ok(st.s === 200 && sj.role === 'viewer' && sj.status === 'online' && sj.regs.length === 40, 'state hiển thị dữ liệu PLC, role viewer', { s: st.s, role: sj.role, status: sj.status });
  ok((await req('POST', '/scada/api/cmd', 'viewer', 'view-pass-2', { a: 6, v: 1 }, { 'X-Requested-With': 'scada' })).s === 403, 'viewer không điều khiển được (403)');
  ok((await req('POST', '/scada/api/cmd', 'operator', 'op-pass-1', { a: 6, v: 1 })).s === 400, 'thiếu header CSRF: 400');
  ok((await req('POST', '/scada/api/cmd', 'operator', 'op-pass-1', { a: 0, v: 1 }, { 'X-Requested-With': 'scada' })).s === 400, 'operator ghi D0: 400 not_writable');
  const w = await req('POST', '/scada/api/cmd', 'operator', 'op-pass-1', { a: 6, v: 1 }, { 'X-Requested-With': 'scada' }); ok(w.s === 200, 'operator điều khiển được', w);
  let ran = false; for (let i = 0; i < 12 && !ran; i++) { await wait(500); ran = tele && tele[6] === 1; } ok(ran, 'PLC nhận lệnh chạy (D6=1) từ web cục bộ');
  const lg = await req('GET', '/scada/api/log', 'viewer', 'view-pass-2'); ok(lg.s === 200 && lg.b.includes('operator') && lg.b.includes('D6 = 1'), 'nhật ký ghi tên người điều khiển');

  // --- Modbus TCP server (chỉ đọc)
  const r = await mbReq(Buffer.from([3, 0, 0, 0, 40])); ok(r && r[7] === 3 && r[8] === 80, 'Modbus server trả 40 thanh ghi', r && r.length);
  if (r && r.length >= 89 && tele) { let same = 0; for (let i = 0; i < 40; i++) if (r.readUInt16BE(9 + i * 2) === tele[i] || i === 10 || i === 11 || (i >= 20 && i <= 35)) same++; ok(same >= 38, 'giá trị server khớp telemetry', same); }
  const w6 = await mbReq(Buffer.from([6, 0, 6, 0, 0])); ok(w6 && w6[7] === 0x86 && w6[8] === 1, 'Modbus server từ chối ghi (illegal function)', w6 && [...w6]);
  const big = await mbReq(Buffer.from([3, 1, 0, 0, 125])); ok(big && big[7] === 0x83 && big[8] === 2, 'đọc ngoài 0..299: illegal address', big && [...big]);
  const h = await mbReq(Buffer.from([3, 0, 100, 0, 10])); ok(h && h[7] === 3, 'đọc vùng lịch sử D100.. được');
  console.log(fails ? `\n${fails} test hỏng` : '\nTất cả đạt'); c.end(); process.exit(fails ? 1 : 0);
})();
