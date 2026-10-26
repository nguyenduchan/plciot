// Bộ đo hiệu năng dùng chung cho SCADA C# (Plciot.Scada.Host) và Node-RED (edge). Chạy trong thư mục có node_modules chứa `aedes` và `mqtt`.
//
//   node perf_bench.js harness [--tls-cert c.pem --tls-key k.pem]   PLC Modbus giả :5030 + broker MQTT :21884 (+ TLS :8884) — chạy nền
//   node perf_bench.js web    --url http://127.0.0.1:PORT/PATH [--basic user:pass | --login-url URL --login-body JSON] --conc 10 --secs 8
//   node perf_bench.js mbs    --port 11502 --conc 10 --secs 8            Modbus TCP server của SCADA: FC03 40 thanh ghi
//   node perf_bench.js lat    --base plc/factory1/plc01 --n 40 [--mqtt mqtt://127.0.0.1:21884]   độ trễ lệnh MQTT→PLC và PLC→telemetry
//
// Harness còn nghe điều khiển ở :5031 ("writes" / "counter" / "reset") để `lat` đọc nhật ký ghi của PLC giả.
const net = require('net'), http = require('http'), tls = require('tls'), fs = require('fs');
const CRLF = '\r\n';
const arg = (n, d) => { const i = process.argv.indexOf('--' + n); return i > 0 ? process.argv[i + 1] : d; };
const mode = process.argv[2];
const pct = (a, p) => { if (!a.length) return NaN; const s = [...a].sort((x, y) => x - y); return s[Math.min(s.length - 1, Math.floor(p / 100 * s.length))]; };
const fmt = (a) => `p50 ${pct(a, 50).toFixed(1)} ms  p95 ${pct(a, 95).toFixed(1)} ms  p99 ${pct(a, 99).toFixed(1)} ms  max ${Math.max(...a).toFixed(1)} ms`;

if (mode === 'harness') {
  const aedes = require('aedes')();
  net.createServer(aedes.handle).listen(21884, () => console.log('mqtt plain :21884'));
  if (arg('tls-cert')) tls.createServer({ cert: fs.readFileSync(arg('tls-cert')), key: fs.readFileSync(arg('tls-key')) }, aedes.handle).listen(8884, () => console.log('mqtt tls :8884'));
  // PLC Modbus giả: D14/D15 là bộ đếm tăng mỗi 100 ms; ghi vào D3,D4,D6,D7,D9 được nhật ký lại kèm thời điểm
  const R = new Uint16Array(300); R[0] = 5; R[8] = 1; for (let i = 100; i < 150; i++) R[i] = i; for (let i = 199; i < 249; i++) R[i] = i;
  const writes = []; let counter = 0;
  setInterval(() => { counter++; R[14] = counter & 0xFFFF; R[15] = counter >>> 16; R[16] = R[14]; R[17] = R[15]; R[10] = (Date.now() / 1000) & 0xFFFF; }, 100);
  net.createServer((s) => {
    let buf = Buffer.alloc(0);
    s.setNoDelay(true);
    s.on('data', (d) => {
      buf = Buffer.concat([buf, d]);
      while (buf.length >= 12) {
        const len = buf.readUInt16BE(4); if (buf.length < 6 + len) break;
        const fc = buf[7], a = buf.readUInt16BE(8), v = buf.readUInt16BE(10), hdr = buf.subarray(0, 4);
        let pdu;
        if (fc === 3) { pdu = Buffer.alloc(2 + v * 2); pdu[0] = 3; pdu[1] = v * 2; for (let i = 0; i < v; i++) pdu.writeUInt16BE(R[a + i], 2 + i * 2); }
        else if (fc === 6) { R[a] = v; writes.push({ a, v, t: Date.now() }); pdu = Buffer.from(buf.subarray(7, 12)); }
        else pdu = Buffer.from([fc | 0x80, 1]);
        const rsp = Buffer.alloc(7 + pdu.length); hdr.copy(rsp, 0); rsp.writeUInt16BE(pdu.length + 1, 4); rsp[6] = buf[6]; pdu.copy(rsp, 7);
        s.write(rsp);
        buf = buf.subarray(6 + len);
      }
    });
    s.on('error', () => {});
  }).listen(5030, '127.0.0.1', () => console.log('modbus plc :5030'));
  net.createServer((s) => {
    s.on('data', (d) => { const c = d.toString().trim(); if (c === 'writes') s.end(JSON.stringify(writes)); else if (c === 'counter') s.end(JSON.stringify({ counter, t: Date.now() })); else if (c === 'reset') { writes.length = 0; s.end('ok'); } else s.end(); });
    s.on('error', () => {});
  }).listen(5031, '127.0.0.1');
}

function ctl(cmd) { return new Promise((res) => { const s = net.connect(5031, '127.0.0.1'); let b = ''; s.on('data', d => b += d); s.on('end', () => res(b)); s.on('error', () => res('')); s.write(cmd); }); }

/** Mỗi worker một socket riêng; oneRequest(socket) trả Promise<boolean>. */
async function closedLoop(socks, secs, oneRequest) {
  const lat = []; let errors = 0, done = 0; const end = Date.now() + secs * 1000;
  await Promise.all(socks.map(async (sk) => {
    while (Date.now() < end) {
      const t0 = process.hrtime.bigint();
      try { const ok = await Promise.race([oneRequest(sk), new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), 5000))]); if (!ok) errors++; } catch { errors++; }
      lat.push(Number(process.hrtime.bigint() - t0) / 1e6); done++;
    }
  }));
  return { lat, errors, done, rps: done / secs };
}

if (mode === 'web') {
  (async () => {
    const url = new URL(arg('url')); const conc = +arg('conc', 10), secs = +arg('secs', 8);
    const headers = {};
    if (arg('basic')) headers.Authorization = 'Basic ' + Buffer.from(arg('basic')).toString('base64');
    if (arg('login-url')) {                       // C#: đăng nhập lấy cookie
      const lu = new URL(arg('login-url')); const body = arg('login-body');
      const cookie = await new Promise((res, rej) => { const r = http.request({ host: lu.hostname, port: lu.port, path: lu.pathname, method: 'POST', headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body), 'X-Requested-With': 'scada' } }, (x) => { x.resume(); res((x.headers['set-cookie'] || [])[0]?.split(';')[0]); }); r.on('error', rej); r.end(body); });
      if (!cookie) { console.log('login failed'); process.exit(2); }
      headers.Cookie = cookie; headers['X-Requested-With'] = 'scada';
    }
    // HTTP/1.1 thô trên net.Socket: http.Agent của Node suy giảm mạnh khi >~16 socket trên Windows loopback
    const hdrs = Object.entries(headers).map(([k, v]) => `${k}: ${v}`).join(CRLF);
    const reqStr = `GET ${url.pathname}${url.search} HTTP/1.1${CRLF}Host: ${url.host}${CRLF}${hdrs ? hdrs + CRLF : ''}${CRLF}`;
    const mk = () => new Promise((res, rej) => {
      const sk = net.connect(+url.port, url.hostname, () => res(sk)); sk.setNoDelay(true); sk.on('error', rej);
      let buf = Buffer.alloc(0);
      sk.on('data', (d) => {
        buf = Buffer.concat([buf, d]);
        const he = buf.indexOf(CRLF + CRLF); if (he < 0) return;
        const head = buf.subarray(0, he).toString(); const m = /content-length:\s*(\d+)/i.exec(head);
        let cl, consumed;
        if (m) { cl = +m[1]; consumed = he + 4 + cl; if (buf.length < consumed) return; }
        else {                                                           // Transfer-Encoding: chunked (Kestrel, Node-RED)
          const endMark = buf.indexOf(CRLF + '0' + CRLF + CRLF, he); if (endMark < 0) return;
          consumed = endMark + 5 + 2; cl = consumed - he - 4;
        }
        const status = +head.slice(9, 12); buf = buf.subarray(consumed);
        sk._cb && sk._cb(status === 200 && cl > 50);
      });
    });
    const socks = await Promise.all(Array.from({ length: conc }, mk));
    const one = (sk) => new Promise((r) => { sk._cb = r; sk.write(reqStr); });
    await closedLoop(socks.slice(0, 2), 1, one);                         // khởi động
    const r = await closedLoop(socks, secs, one);
    console.log(`web conc=${conc}: ${r.rps.toFixed(0)} req/s, lỗi ${r.errors}/${r.done}, ${fmt(r.lat)}`);
    process.exit(0);
  })();
}

if (mode === 'mbs') {
  (async () => {
    const port = +arg('port'), conc = +arg('conc', 10), secs = +arg('secs', 8);
    const mk = () => new Promise((res, rej) => {
      const s = net.connect(port, '127.0.0.1', () => res(s)); s.on('error', rej); s.setNoDelay(true);
      let b = Buffer.alloc(0); s.on('data', d => { b = Buffer.concat([b, d]); if (b.length >= 89) { b = Buffer.alloc(0); s._cb && s._cb(true); } });
      s.on('close', () => s._cb && s._cb(false));
    });
    const socks = await Promise.all(Array.from({ length: conc }, mk));
    let tid = 0; const req = Buffer.from([0, 0, 0, 0, 0, 6, 1, 3, 0, 0, 0, 40]);
    const one = (sk) => new Promise((r) => { sk._cb = r; req.writeUInt16BE(++tid & 0xFFFF, 0); sk.write(req); });
    const r = await closedLoop(socks, secs, one);
    console.log(`modbus-server conc=${conc}: ${r.rps.toFixed(0)} req/s, lỗi ${r.errors}/${r.done}, ${fmt(r.lat)}`);
    process.exit(0);
  })();
}

if (mode === 'lat') {
  (async () => {
    const mqtt = require('mqtt'); const base = arg('base'), n = +arg('n', 40);
    const c = mqtt.connect(arg('mqtt', 'mqtt://127.0.0.1:21884'), { username: 'bench', password: 'x', rejectUnauthorized: false });
    await new Promise(r => c.on('connect', r));
    c.subscribe(base + '/telemetry');
    const teleLat = []; let lastCounter = -1;
    // độ trễ PLC→MQTT: thời điểm bộ đếm D14 của PLC giả đạt giá trị X (đo ở harness) so với lúc telemetry mang giá trị đó tới
    const hist = [];
    const poll = setInterval(async () => { try { const j = JSON.parse(await ctl('counter')); hist.push([j.counter, j.t]); if (hist.length > 400) hist.shift(); } catch {} }, 20);
    c.on('message', (t, p) => { const now = Date.now(); try { const r = JSON.parse(p.toString()).r; const cnt = r[14]; if (cnt !== lastCounter) { lastCounter = cnt; const h = hist.find(x => x[0] >= cnt); if (h) teleLat.push(Math.max(0, now - h[1])); } } catch {} });
    await new Promise(r => setTimeout(r, 6000));
    await ctl('reset');
    const sent = [];
    for (let i = 0; i < n; i++) { const v = 100 + i; sent.push([v, Date.now()]); c.publish(base + '/cmd', JSON.stringify({ id: 'p' + i, a: 7, v })); await new Promise(r => setTimeout(r, 250)); }
    await new Promise(r => setTimeout(r, 1500));
    const writes = JSON.parse(await ctl('writes')).filter(w => w.a === 7);
    const cmdLat = []; for (const [v, t0] of sent) { const w = writes.find(x => x.v === v); if (w) cmdLat.push(w.t - t0); }
    clearInterval(poll);
    console.log(`lệnh MQTT→PLC: ${cmdLat.length}/${n} tới PLC, ${cmdLat.length ? fmt(cmdLat) : 'không có'}`);
    console.log(`PLC→telemetry MQTT (tính từ lúc bộ đếm đổi): ${teleLat.length} mẫu, ${teleLat.length ? fmt(teleLat) : 'không có'}`);
    process.exit(0);
  })();
}
