"""Thế giới bên ngoài của board Waveshare ESP32-S3 giả lập (gateway-mcu/build-sim/gw-sim.exe). Không cần phần cứng, không cần thư viện.

  python tools/esp32_field_sim.py --data gateway-mcu/simdata
  # rồi chạy gw-sim với:  SIM_DATA=simdata  SIM_RS485_TCP=127.0.0.1:5485

Gồm 3 phần:
  1. RS485 giả   : cổng TCP 5485 nhận khung Modbus RTU thô (có CRC) — board nối vào bằng SIM_RS485_TCP. Slave 1 và 2 (FC1,2,3,4,5,6,15,16).
  2. Modbus TCP  : cổng TCP 5020, cùng ngân hàng thanh ghi như RS485 (unit 1, 2) — dùng làm PLC cho kết nối "Modbus TCP" của GatewayApp.
  3. Bảng DI/DO  : http://127.0.0.1:8090 — bấm công tắc DI1..DI8 (ghi <data>/di.txt, board đọc), xem DO1..DO8 (board ghi <data>/do.txt).
Dữ liệu động: unit 1: D0 nhiệt độ x10 (dao động), D1 bộ đếm +1/giây, D2 mức bồn %, D10.. ghi được; coil n -> discrete n sau 1 giây (relay).
"""
import argparse, json, math, os, socket, struct, sys, threading, time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

sys.stdout.reconfigure(encoding='utf-8', errors='replace')
ap = argparse.ArgumentParser()
ap.add_argument('--data', default='gateway-mcu/simdata'); ap.add_argument('--rs485', type=int, default=5485)
ap.add_argument('--tcp', type=int, default=5020); ap.add_argument('--http', type=int, default=8090)
a = ap.parse_args()
os.makedirs(a.data, exist_ok=True)
lock = threading.Lock()
UNITS = (1, 2)
bank = {u: {'h': [0] * 1000, 'c': [0] * 1000, 'd': [0] * 1000} for u in UNITS}   # h = holding+input, c = coil, d = discrete
log = []


def note(m):
    line = time.strftime('%H:%M:%S ') + m
    log.append(line); del log[:-30]; print(line, flush=True)


def crc16(b):
    c = 0xFFFF
    for x in b:
        c ^= x
        for _ in range(8): c = (c >> 1) ^ 0xA001 if c & 1 else c >> 1
    return c


def pdu_handle(u, p):
    """Xử lý một PDU Modbus cho slave u; trả PDU trả lời. Gọi khi đã giữ lock."""
    b, fc = bank[u], p[0]
    def exc(c): return bytes([fc | 0x80, c])
    try:
        if fc in (1, 2, 3, 4):
            addr, n = struct.unpack('>HH', p[1:5])
            if n < 1 or n > (2000 if fc < 3 else 125): return exc(3)
            if addr + n > 1000: return exc(2)
            if fc >= 3: return bytes([fc, n * 2]) + b''.join(struct.pack('>H', b['h'][addr + i] & 0xFFFF) for i in range(n))
            src = b['c' if fc == 1 else 'd']; by = bytearray((n + 7) // 8)
            for i in range(n):
                if src[addr + i]: by[i // 8] |= 1 << (i % 8)
            return bytes([fc, len(by)]) + bytes(by)
        if fc == 5:
            addr, v = struct.unpack('>HH', p[1:5])
            if addr >= 1000: return exc(2)
            b['c'][addr] = 1 if v == 0xFF00 else 0; note('unit %d coil %d = %d' % (u, addr, b['c'][addr])); return p[:5]
        if fc == 6:
            addr, v = struct.unpack('>HH', p[1:5])
            if addr >= 1000: return exc(2)
            b['h'][addr] = v; note('unit %d D%d = %d' % (u, addr, v)); return p[:5]
        if fc == 15:
            addr, n, bc = struct.unpack('>HHB', p[1:6])
            if addr + n > 1000: return exc(2)
            for i in range(n): b['c'][addr + i] = (p[6 + i // 8] >> (i % 8)) & 1
            note('unit %d coils %d..%d' % (u, addr, addr + n - 1)); return p[:5]
        if fc == 16:
            addr, n, bc = struct.unpack('>HHB', p[1:6])
            if addr + n > 1000: return exc(2)
            for i in range(n): b['h'][addr + i] = struct.unpack('>H', p[6 + i * 2:8 + i * 2])[0]
            note('unit %d D%d..D%d = %s' % (u, addr, addr + n - 1, b['h'][addr:addr + n])); return p[:5]
    except (struct.error, IndexError): return exc(3)
    return exc(1)


def rtu_len(buf):
    """Độ dài khung yêu cầu RTU từ các byte đầu; None = chưa đủ để biết."""
    if len(buf) < 2: return None
    if buf[1] in (1, 2, 3, 4, 5, 6): return 8
    if buf[1] in (15, 16): return 9 + buf[6] if len(buf) >= 7 else None
    return 8


def serve_rs485(conn):
    buf = b''
    while True:
        try: c = conn.recv(512)
        except OSError: return
        if not c: return
        buf += c
        while True:
            n = rtu_len(buf)
            if n is None or len(buf) < n: break
            frame, buf = buf[:n], buf[n:]
            if crc16(frame[:-2]) != struct.unpack('<H', frame[-2:])[0]: note('RS485: sai CRC, bỏ khung'); continue
            u = frame[0]
            if u not in UNITS: continue   # không slave nào có địa chỉ này: im lặng (bên hỏi hết giờ chờ), như bus thật
            with lock: resp = bytes([u]) + pdu_handle(u, frame[1:-2])
            conn.sendall(resp + struct.pack('<H', crc16(resp)))


def serve_tcp(conn):
    buf = b''
    while True:
        try: c = conn.recv(512)
        except OSError: return
        if not c: return
        buf += c
        while len(buf) >= 7:
            tid, pid, ln, u = struct.unpack('>HHHB', buf[:7])
            if len(buf) < 6 + ln: break
            pdu, buf = buf[7:6 + ln], buf[6 + ln:]
            with lock: resp = pdu_handle(u, pdu) if u in UNITS else bytes([pdu[0] | 0x80, 0x0B])
            conn.sendall(struct.pack('>HHHB', tid, 0, len(resp) + 1, u) + resp)


def listen(port, fn):
    s = socket.socket(); s.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1); s.bind(('0.0.0.0', port)); s.listen(5)
    def run():
        while True:
            c, _ = s.accept(); threading.Thread(target=fn, args=(c,), daemon=True).start()
    threading.Thread(target=run, daemon=True).start()


def dynamics():
    pend = {}   # (unit, coil) -> thời điểm đổi discrete (relay trễ 1 giây)
    t = 0
    while True:
        time.sleep(1); t += 1
        with lock:
            b = bank[1]
            b['h'][0] = int(250 + 40 * math.sin(t / 10.0))          # nhiệt độ x10
            b['h'][1] = (b['h'][1] + 1) & 0xFFFF                    # bộ đếm
            b['h'][2] = int(50 + 40 * math.sin(t / 30.0))           # mức %
            for u in UNITS:
                for i in range(16):
                    if bank[u]['c'][i] != bank[u]['d'][i]:
                        k = (u, i); pend.setdefault(k, time.time())
                        if time.time() - pend[k] >= 1: bank[u]['d'][i] = bank[u]['c'][i]; pend.pop(k)
                    else: pend.pop((u, i), None)


def read_int(name, default=0):
    try: return int(open(os.path.join(a.data, name)).read().strip(), 0)
    except (OSError, ValueError): return default


PAGE = """<!doctype html><meta charset=utf-8><title>ESP32 field sim</title><style>body{font:14px sans-serif;margin:20px}
.led{display:inline-block;width:18px;height:18px;border-radius:9px;background:#ccc;margin:0 4px;vertical-align:middle}.on{background:#2a2}
label{margin-right:12px}pre{background:#f4f4f4;padding:8px}</style>
<h3>DI (bấm = có tín hiệu, ghi di.txt)</h3><div id=di></div><h3>DO (board ghi ra)</h3><div id=do></div>
<h3>Ngân hàng thanh ghi (unit 1, D0..D9) — qua RS485 hoặc Modbus TCP</h3><pre id=regs></pre><h3>Nhật ký ghi</h3><pre id=log></pre>
<script>
const di=document.getElementById('di');for(let i=0;i<8;i++)di.insertAdjacentHTML('beforeend',`<label><input type=checkbox id=d${i} onchange="fetch('/di?n=${i}&v='+(this.checked?1:0),{method:'POST'})"> DI${i+1}</label>`);
async function tick(){const s=await (await fetch('/state')).json();
 for(let i=0;i<8;i++){const e=document.getElementById('d'+i);if(document.activeElement!==e)e.checked=!!(s.di>>i&1)}
 document.getElementById('do').innerHTML=[...Array(8).keys()].map(i=>`DO${i+1}<span class="led ${s.do>>i&1?'on':''}"></span>`).join('');
 document.getElementById('regs').textContent=s.regs.map((v,i)=>'D'+i+' = '+v).join('\\n');document.getElementById('log').textContent=s.log.join('\\n')}
setInterval(tick,700);tick();</script>"""


class H(BaseHTTPRequestHandler):
    def log_message(self, *x): pass
    def send(self, code, body, ct):
        self.send_response(code); self.send_header('Content-Type', ct); self.end_headers(); self.wfile.write(body)
    def do_GET(self):
        if self.path == '/state':
            with lock: regs = bank[1]['h'][:10]
            self.send(200, json.dumps({'di': read_int('di.txt'), 'do': read_int('do.txt'), 'regs': regs, 'log': log[-12:]}).encode(), 'application/json')
        else: self.send(200, PAGE.encode(), 'text/html; charset=utf-8')
    def do_POST(self):
        from urllib.parse import urlparse, parse_qs
        q = parse_qs(urlparse(self.path).query); n, v = int(q['n'][0]), int(q['v'][0])
        d = read_int('di.txt'); d = d | (1 << n) if v else d & ~(1 << n)
        open(os.path.join(a.data, 'di.txt'), 'w').write(str(d & 0xFF)); note('DI%d = %d' % (n + 1, v)); self.send(200, b'ok', 'text/plain')


if not os.path.exists(os.path.join(a.data, 'di.txt')): open(os.path.join(a.data, 'di.txt'), 'w').write('0')
listen(a.rs485, serve_rs485); listen(a.tcp, serve_tcp)
threading.Thread(target=dynamics, daemon=True).start()
print('RS485-giả (RTU thô) :%d · Modbus TCP :%d · bảng DI/DO http://127.0.0.1:%d · dữ liệu %s' % (a.rs485, a.tcp, a.http, a.data), flush=True)
ThreadingHTTPServer(('0.0.0.0', a.http), H).serve_forever()
