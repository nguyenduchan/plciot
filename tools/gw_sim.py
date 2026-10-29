"""Gateway + XD3 PLC simulator for integration tests (no hardware, no dependencies).

Speaks raw MQTT 3.1.1 over TCP exactly like gateway/src/main.cpp: publishes retained
telemetry {"r":[D0..D39]}, status (with LWT), subscribes <base>/cmd, enforces the same
write whitelist, answers on <base>/ack. The register logic mirrors plc/xd3_logic.st.

  python tools/gw_sim.py --port 1883 --user gw --password ...
"""
import argparse, json, random, socket, struct, threading, time

WRITABLE = {3, 4, 6, 7, 9}


def s(x):
    b = x.encode()
    return struct.pack('>H', len(b)) + b


def pkt(first, body):
    n, rl = len(body), b''
    while True:
        d, n = n % 128, n // 128
        rl += bytes([d | 128 if n else d])
        if not n:
            break
    return bytes([first]) + rl + body


class Plc:
    def __init__(self):
        self.d = [0] * 260
        self.hour = 3600          # seconds per history slot (shorten for demos with --hour)
        self.level, self.pump, self.was_y0, self.m1 = 55.0, False, 0, False

    def u32(self, i): return self.d[i] + self.d[i + 1] * 65536

    def add(self, i, n=1):
        v = self.u32(i) + n
        self.d[i], self.d[i + 1] = v & 0xFFFF, v >> 16

    def scan(self):  # one second
        d = self.d
        self.level = min(100, max(0, self.level + (3 if d[1] & 1 else 0) - 1.2 - random.random() * .5))
        x0, x1, x2 = True, self.level > 20, self.level >= 80
        d[0] = 1 | (2 if x1 else 0) | (4 if x2 else 0)
        d[2] = (2 if x2 and not x1 else 0)
        if d[3] == 1 and not self.m1: d[4] = d[1]
        self.m1 = d[3] == 1
        if not x1: self.pump = True
        elif x2: self.pump = False
        d5 = (1 if self.pump else 0) if d[3] == 0 else d[4] & 0x7F
        if d[8] == 1 and random.random() < .6:  # item passes the photo-eye (only while belt runs)
            self.add(14); self.add(16); self.d[100] += 1
        if d[9] == 1: d[14] = d[15] = 0; d[9] = 0
        reached = d[7] > 0 and self.u32(14) >= d[7]
        d[8] = (2 if reached else 1) if d[6] == 1 else 0
        d5 &= 0xFD
        if d[8] == 1: d5 |= 2
        if d[2] & 2: d5 = (d5 & 0xFE) | 0x80; self.pump = False
        if not x1: d5 &= 0xFE
        d[1] = d5
        self.add(10)
        d[149] += 1
        if d[8] == 1: d[199] += 1
        if d[149] >= self.hour:
            d[200] = d[199] * 60 // self.hour
            d[101:149] = d[100:148]; d[201:249] = d[200:248]
            d[100] = d[200] = d[199] = d[149] = 0; d[150] += 1
        for i in range(8):
            if d5 >> i & 1: self.add(20 + 2 * i)
        if (d5 & 1) and not self.was_y0: self.add(12)
        self.was_y0 = d5 & 1


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--host', default='127.0.0.1'); ap.add_argument('--port', type=int, default=1883)
    ap.add_argument('--user', default='gw'); ap.add_argument('--password', default='')
    ap.add_argument('--site', default='factory1'); ap.add_argument('--dev', default='plc01')
    ap.add_argument('--ns', choices=('plc', 'iot'), default='plc',
                    help='topic namespace: plc/<site>/<dev> (legacy) hoặc iot/<tenant>/<site>/<dev>')
    ap.add_argument('--tenant', default='default', help='tenant id khi --ns=iot (partner contract)')
    ap.add_argument('--schema', type=int, default=1, help='payload schema version (0 = omit field)')
    ap.add_argument('--hour', type=int, default=3600, help='seconds per history slot (use 60 to see rollovers)')
    ap.add_argument('--hist-every', type=int, default=10, help='seconds between history publishes')
    a = ap.parse_args()
    if a.ns == 'iot':
        base = f'iot/{a.tenant}/{a.site}/{a.dev}'
    else:
        base = f'plc/{a.site}/{a.dev}'
    print('topic base', base)

    def body(obj):
        if a.schema:
            return json.dumps({'schema': a.schema, **obj})
        return json.dumps(obj)

    sk = socket.create_connection((a.host, a.port))
    flags = 0x02 | 0x04 | 0x08 | 0x20 | 0x80 | 0x40   # clean, will(qos1, retain), user, pass
    sk.sendall(pkt(0x10, s('MQTT') + bytes([4, flags]) + struct.pack('>H', 30) +
                   s('gw-sim') + s(base + '/status') + s('offline') + s(a.user) + s(a.password)))
    plc, cmds, lock = Plc(), [], threading.Lock()
    plc.hour = a.hour
    for i in range(48):                       # prefill 48 past hours so charts are not empty
        plc.d[101 + i] = random.randint(15, 90); plc.d[201 + i] = random.randint(20, 60)
    plc.d[150] = 48; plc.d[149] = a.hour // 3; plc.d[100] = 12; plc.d[199] = a.hour // 6
    tick = 0

    def reader():
        buf = b''
        while True:
            c = sk.recv(4096)
            if not c: print('broker closed connection'); break
            buf += c
            while len(buf) >= 2:
                i, mul, n = 1, 1, 0
                while True:
                    if i >= len(buf): break
                    b = buf[i]; i += 1; n += (b & 127) * mul; mul *= 128
                    if not b & 128: break
                if len(buf) < i + n: break
                first, body, buf = buf[0], buf[i:i + n], buf[i + n:]
                if first >> 4 == 2:
                    print('CONNACK rc =', body[1])
                    if body[1] == 0:
                        sk.sendall(pkt(0x82, struct.pack('>H', 1) + s(base + '/cmd') + b'\x00'))
                elif first >> 4 == 3:
                    tl = struct.unpack('>H', body[:2])[0]
                    with lock: cmds.append(body[2 + tl:].decode())
    threading.Thread(target=reader, daemon=True).start()

    def pub(topic, msg, retain=False):
        sk.sendall(pkt(0x30 | retain, s(topic) + msg.encode()))

    time.sleep(0.5)
    pub(base + '/status', 'online', True)
    while True:
        with lock: todo, cmds[:] = cmds[:], []
        for raw in todo:
            try:
                c = json.loads(raw)
                if c.get('op') == 'read':
                    n = int(c.get('n') or 1); addr = int(c['a'])
                    vals = plc.d[addr:addr + n]
                    print('CMD read', raw, '->', vals)
                    pub(base + '/ack', body({'id': c.get('id'), 'ok': True, 'a': addr, 'v': vals}))
                    continue
                ok = c['a'] in WRITABLE
                if ok: plc.d[c['a']] = int(c['v']) & 0xFFFF
                print('CMD', raw, '->', 'ok' if ok else 'REFUSED')
                pub(base + '/ack', body({'id': c.get('id'), 'ok': ok}))
            except Exception as e:
                print('bad cmd', raw, e)
        plc.scan()
        pub(base + '/telemetry', body({'r': plc.d[:40], 'ts': int(time.time())}), True)
        if tick % a.hist_every == 0:
            d = plc.d
            pub(base + '/history', body({'c': d[100:149], 's': d[149], 'n': d[150], 'r': d[199], 'm': d[200:249]}), True)
        tick += 1
        time.sleep(1)


if __name__ == '__main__':
    main()
