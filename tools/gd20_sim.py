"""Biến tần INVT GD20 GIẢ trên dây RS485 (khung Modbus RTU thô qua TCP — đúng kiểu SIM_RS485_TCP của board giả lập gw-sim).

  python tools/gd20_sim.py [--port 5490] [--unit 1] [--log gd20.log]

Bảng thanh ghi theo GD20 VFD Manual V2.1, chương 7 (đúng mẫu tools/GatewayAdmin/templates/invt-gd20.json):
  2000H lệnh (W): 1 chạy thuận, 2 chạy nghịch, 5 dừng, 6 dừng tự do, 7 reset lỗi — giá trị khác → lỗi 03 (giá trị sai)
  2001H tần số đặt (R/W, 0.01 Hz, 0..Fmax 50.00 Hz)      2100H trạng thái (R): 1 chạy thuận, 2 chạy nghịch, 3 dừng, 4 lỗi
  2102H mã lỗi (R)    3000H tần số chạy (0.01 Hz)   3002H DC bus (0.1 V)   3003H điện áp ra (V)   3004H dòng ra (0.1 A)
  3005H tốc độ (rpm)  3006H công suất (0.1 %)       3007H mô-men (0.1 %)
Như máy thật: FC03/06/16, đọc tối đa 16 thanh ghi liên tiếp (nhiều hơn → lỗi 03), địa chỉ không có → lỗi 02, tăng/giảm tốc 10 Hz/s.
Mọi lệnh ghi được in ra (và ghi vào --log) để đối chiếu với lệnh từ webapp.
"""
import argparse, socket, struct, sys, threading, time

sys.stdout.reconfigure(encoding="utf-8")
ap = argparse.ArgumentParser()
ap.add_argument('--port', type=int, default=5490)
ap.add_argument('--unit', type=int, default=1)
ap.add_argument('--log', default='')
a = ap.parse_args()

R = {0x2000: 0, 0x2001: 0, 0x2100: 3, 0x2101: 1, 0x2102: 0, 0x2103: 0x0106}
for i in range(0x3000, 0x3011): R[i] = 0
R[0x3002] = 5400                      # 540.0 V DC bus (lưới 380 V)
FMAX = 5000
lock = threading.Lock()
st = {'run': False, 'f': 0.0}
logf = open(a.log, 'a', encoding='utf-8') if a.log else None


def log(msg):
    line = time.strftime('%H:%M:%S ') + msg
    print(line, flush=True)
    if logf: logf.write(line + '\n'); logf.flush()


def physics():
    while True:
        time.sleep(0.2)
        with lock:
            target = R[0x2001] if st['run'] else 0
            f = st['f']
            f = min(target, f + 200) if f < target else max(target, f - 200)   # 10 Hz/s
            st['f'] = f
            R[0x3000] = int(f); R[0x3001] = R[0x2001]
            R[0x3003] = int(380 * f / FMAX); R[0x3004] = int(85 * f / FMAX) + (3 if f else 0)   # 8.5 A ở 50 Hz
            R[0x3005] = int(1480 * f / FMAX); R[0x3006] = int(750 * f / FMAX); R[0x3007] = int(600 * f / FMAX)
            R[0x2100] = 1 if st['run'] else 3


def write(addr, v):
    """→ mã lỗi Modbus (0 = ok)."""
    if addr == 0x2000:
        if v not in (1, 2, 3, 4, 5, 6, 7, 8): return 3
        R[0x2000] = v
        if v in (1, 2, 3, 4): st['run'] = True
        elif v in (5, 6, 8): st['run'] = False
        log(f'LỆNH 2000H = {v} ({ {1: "chạy thuận", 5: "dừng", 6: "dừng tự do", 7: "reset lỗi"}.get(v, "khác") })')
        return 0
    if addr == 0x2001:
        if v > FMAX: return 3
        R[0x2001] = v; log(f'TẦN SỐ ĐẶT 2001H = {v} ({v / 100:.2f} Hz)'); return 0
    return 2


def crc16(b):
    c = 0xFFFF
    for x in b:
        c ^= x
        for _ in range(8): c = (c >> 1) ^ 0xA001 if c & 1 else c >> 1
    return c


def handle(fr):
    u, fc = fr[0], fr[1]
    if u != a.unit: return None                                    # trạm khác: im lặng
    ex = lambda code: bytes([u, fc | 0x80, code])
    with lock:
        if fc == 3:
            addr, n = struct.unpack('>HH', fr[2:6])
            if n < 1 or n > 16: return ex(3)
            if any((addr + i) not in R for i in range(n)): return ex(2)
            return bytes([u, 3, n * 2]) + b''.join(struct.pack('>H', R[addr + i]) for i in range(n))
        if fc == 6:
            addr, v = struct.unpack('>HH', fr[2:6]); e = write(addr, v)
            return ex(e) if e else fr[:6]
        if fc == 16:
            addr, n = struct.unpack('>HH', fr[2:6])
            for i in range(n):
                e = write(addr + i, struct.unpack('>H', fr[7 + 2 * i:9 + 2 * i])[0])
                if e: return ex(e)
            return fr[:6]
    return ex(1)


def serve():
    srv = socket.socket(); srv.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1); srv.bind(('127.0.0.1', a.port)); srv.listen(1)
    log(f'GD20 giả: Slave ID {a.unit}, RS485-qua-TCP 127.0.0.1:{a.port}')
    while True:
        c, _ = srv.accept(); buf = b''
        while True:
            try: d = c.recv(512)
            except OSError: break
            if not d: break
            buf += d
            while len(buf) >= 8:
                need = 8 if buf[1] in (3, 4, 6) else (9 + buf[6] if len(buf) >= 7 else 999)
                if len(buf) < need: break
                fr, buf = buf[:need], buf[need:]
                if crc16(fr[:-2]) != fr[-2] | (fr[-1] << 8): continue
                r = handle(fr[:-2])
                if r is not None:
                    if r[1] & 0x80: log(f'LỖI MODBUS {r[2]} cho FC{fr[1]:02d} {fr[2:6].hex()}')
                    cr = crc16(r); c.sendall(r + bytes([cr & 0xFF, cr >> 8]))


threading.Thread(target=physics, daemon=True).start()
serve()
