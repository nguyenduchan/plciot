"""Modbus TCP slave simulating the XD3 PLC register map (same logic as tools/gw_sim.py). For testing the Node-RED bridge.

  python tools/modbus_tcp_sim.py --port 5020 --hour 60
FC3 read holding registers (0..259), FC6 write single register. No dependencies.
"""
import argparse, importlib.util, os, socket, struct, threading, time

spec = importlib.util.spec_from_file_location('gw_sim', os.path.join(os.path.dirname(__file__), 'gw_sim.py'))
gw = importlib.util.module_from_spec(spec); spec.loader.exec_module(gw)

ap = argparse.ArgumentParser()
ap.add_argument('--port', type=int, default=5020); ap.add_argument('--hour', type=int, default=3600)
a = ap.parse_args()
plc, lock = gw.Plc(), threading.Lock()
plc.hour = a.hour
for i in range(48):
    plc.d[101 + i] = 20 + (i * 7) % 60; plc.d[201 + i] = 25 + (i * 5) % 35
plc.d[150], plc.d[149], plc.d[100], plc.d[199] = 48, a.hour // 3, 12, a.hour // 6


def ticker():
    while True:
        time.sleep(1)
        with lock: plc.scan()


def serve(conn):
    buf = b''
    while True:
        try: c = conn.recv(512)
        except OSError: return
        if not c: return
        buf += c
        while len(buf) >= 7:
            tid, pid, ln, unit = struct.unpack('>HHHB', buf[:7])
            if len(buf) < 6 + ln: break
            pdu, buf = buf[7:6 + ln], buf[6 + ln:]
            fc = pdu[0]
            with lock:
                if fc == 3:
                    addr, n = struct.unpack('>HH', pdu[1:5])
                    if addr + n > len(plc.d) or n > 125: resp = bytes([0x83, 2])
                    else: resp = bytes([3, n * 2]) + b''.join(struct.pack('>H', plc.d[addr + i] & 0xFFFF) for i in range(n))
                elif fc == 6:
                    addr, val = struct.unpack('>HH', pdu[1:5])
                    if addr in gw.WRITABLE: plc.d[addr] = val; resp = pdu[:5]; print('WRITE D%d = %d' % (addr, val), flush=True)
                    else: resp = bytes([0x86, 2])
                else: resp = bytes([fc | 0x80, 1])
            conn.sendall(struct.pack('>HHHB', tid, 0, len(resp) + 1, unit) + resp)


threading.Thread(target=ticker, daemon=True).start()
srv = socket.socket(); srv.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1); srv.bind(('0.0.0.0', a.port)); srv.listen(5)
print('Modbus TCP simulator on port', a.port, flush=True)
while True:
    conn, _ = srv.accept(); threading.Thread(target=serve, args=(conn,), daemon=True).start()
