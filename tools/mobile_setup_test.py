"""Thử tự động trang cài đặt bằng điện thoại của board Waveshare (gateway-mcu/src/mobile.cpp) trên bản giả lập gw-sim.

  python tools/mobile_setup_test.py            (cần gateway-mcu/build-sim/gw-sim.exe: .\\gateway-mcu\\build.ps1 -Sim)

Tự dựng RS485 giả (khung Modbus RTU thô qua TCP, đủ 65536 thanh ghi + vùng input FC04 riêng), dữ liệu board tạm, danh sách mẫu đã lưu
(/tpl.json — server không có/không nối được thì board dùng bản lưu), rồi chạy đúng luồng của kỹ thuật viên: đăng nhập (cửa sổ BOOT) → cổng
→ đọc thử mẫu → thêm thiết bị → trùng Slave ID → ẩn/hiện thông số → đọc/ghi thử (FC03/04/06/16, CDAB, đảo byte, địa chỉ 0x3000) → DI/DO →
phạm vi phiên KTV → hoàn tất (tắt trang). Kết quả: in ra + mã thoát ≠ 0 khi có lỗi.
"""
import json, os, shutil, socket, ssl, struct, subprocess, sys, tempfile, threading, time, urllib.request, urllib.error

sys.stdout.reconfigure(encoding="utf-8")
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
EXE = os.path.join(ROOT, 'gateway-mcu', 'build-sim', 'gw-sim.exe')
API, HTTP, RS = 8460, 8461, 5486
fails = 0


def ok(c, label):
    global fails
    print(('ok   ' if c else 'FAIL ') + label, flush=True)
    if not c: fails += 1


# ---------------------------------------------------------------- RS485 giả
H = {u: [0] * 65536 for u in (1, 3)}      # holding (FC03/06/16)
I = {u: [0] * 65536 for u in (1, 3)}      # input register (FC04)
WR = []                                    # (unit, fc, addr, values) các lệnh ghi nhận được
H[1][0x3000] = 5000                        # 50.00 Hz (÷100)
H[1][0x3004] = 123                         # 12.3 A (÷10)
f = struct.unpack('>HH', struct.pack('>f', 7.5)); H[1][0x3006], H[1][0x3007] = f[1], f[0]   # 7.5 kW, CDAB (word thấp trước)
I[3][1] = (-235) & 0xFFFF                  # -23.5 °C Int16 FC04
I[3][2] = ((612 & 0xFF) << 8) | (612 >> 8)  # 61.2 % đảo byte (BA)


def crc16(b):
    c = 0xFFFF
    for x in b:
        c ^= x
        for _ in range(8): c = (c >> 1) ^ 0xA001 if c & 1 else c >> 1
    return c


def handle(fr):
    u, fc = fr[0], fr[1]
    if u not in H: return None             # trạm không có: im lặng (timeout)
    if fc in (3, 4):
        a, n = struct.unpack('>HH', fr[2:6]); bank = H[u] if fc == 3 else I[u]
        return bytes([u, fc, n * 2]) + b''.join(struct.pack('>H', bank[a + i]) for i in range(n))
    if fc == 6:
        a, v = struct.unpack('>HH', fr[2:6]); H[u][a] = v; WR.append((u, 6, a, [v])); return fr[:6]
    if fc == 16:
        a, n = struct.unpack('>HH', fr[2:6]); vals = [struct.unpack('>H', fr[7 + 2 * i:9 + 2 * i])[0] for i in range(n)]
        for i, v in enumerate(vals): H[u][a + i] = v
        WR.append((u, 16, a, vals)); return fr[:6]
    return bytes([u, fc | 0x80, 1])


def rs_server():
    srv = socket.socket(); srv.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1); srv.bind(('127.0.0.1', RS)); srv.listen(1)
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
                r = handle(fr[:-2])
                if r is not None:
                    cr = crc16(r); c.sendall(r + bytes([cr & 0xFF, cr >> 8]))


threading.Thread(target=rs_server, daemon=True).start()

# ---------------------------------------------------------------- board giả lập
data = tempfile.mkdtemp(prefix='mobile-')
TPL = {'rev': 1, 'templates': [
    {'id': 'invt-gd20', 'name': 'Biến tần INVT GD20', 'brand': 'INVT', 'model': 'GD20', 'icon': 'vfd', 'note': '', 'serial': {'baud': 9600, 'parity': 'None'},
     'test': ['f', 'a'], 'fields': [
        {'key': 'f', 'label': 'Tần số ngõ ra', 'fc': 3, 'addr': 0x3000, 'type': 'UInt16', 'order': 'AB', 'scale': 100, 'unit': 'Hz', 'access': 'r', 'kind': 'gauge', 'show': True},
        {'key': 'a', 'label': 'Dòng điện', 'fc': 3, 'addr': 0x3004, 'type': 'UInt16', 'order': 'AB', 'scale': 10, 'unit': 'A', 'access': 'r', 'kind': 'gauge', 'show': True},
        {'key': 'kw', 'label': 'Công suất', 'fc': 3, 'addr': 0x3006, 'type': 'Float32', 'order': 'CDAB', 'scale': 1, 'unit': 'kW', 'access': 'r', 'kind': 'gauge', 'show': False},
        {'key': 'sp', 'label': 'Cài đặt tần số', 'fc': 3, 'addr': 0x2001, 'type': 'UInt16', 'order': 'AB', 'scale': 100, 'unit': 'Hz', 'access': 'rw', 'kind': 'slider', 'show': True, 'min': 0, 'max': 50},
        {'key': 'cmd', 'label': 'Lệnh chạy/dừng', 'fc': 3, 'addr': 0x2000, 'type': 'UInt16', 'order': 'AB', 'scale': 1, 'unit': '', 'access': 'w', 'kind': 'number', 'show': True, 'wfc': 16}]},
    {'id': 'xy-md02', 'name': 'Cảm biến nhiệt ẩm XY-MD02', 'brand': 'XY', 'model': 'MD02', 'icon': 'env', 'note': '', 'serial': {'baud': 9600, 'parity': 'None'},
     'test': ['t', 'h'], 'fields': [
        {'key': 't', 'label': 'Nhiệt độ', 'fc': 4, 'addr': 1, 'type': 'Int16', 'order': 'AB', 'scale': 10, 'unit': '°C', 'access': 'r', 'kind': 'gauge', 'show': True},
        {'key': 'h', 'label': 'Độ ẩm', 'fc': 4, 'addr': 2, 'type': 'UInt16', 'order': 'BA', 'scale': 10, 'unit': '%', 'access': 'r', 'kind': 'gauge', 'show': True}]}]}
# "server" thư viện mẫu giả (http:// trong LAN được phép): board tải ?since=rev → 304 khi không đổi
import http.server
CAT_HITS = []
class Cat(http.server.BaseHTTPRequestHandler):
    def do_GET(self):
        CAT_HITS.append(self.path)
        if self.path.startswith('/api/v1/device-templates'):
            if f'since={TPL["rev"]}' in self.path: self.send_response(304); self.end_headers(); return
            b = json.dumps(TPL, ensure_ascii=False).encode(); self.send_response(200); self.send_header('Content-Type', 'application/json')
            self.send_header('Content-Length', str(len(b))); self.end_headers(); self.wfile.write(b); return
        self.send_response(404); self.end_headers()
    def do_POST(self):
        n = int(self.headers.get('Content-Length') or 0); body = json.loads(self.rfile.read(n) or b'{}')
        CAT_HITS.append(self.path); ACC['calls'].append((self.path, body, self.headers.get('Authorization', '')))
        def out(st, o):
            b = json.dumps(o).encode(); self.send_response(st); self.send_header('Content-Type', 'application/json'); self.send_header('Content-Length', str(len(b))); self.end_headers(); self.wfile.write(b)
        if self.path == '/api/v1/gateway/login/start': return out(200, {'deviceCode': 'dc-' + 'x' * 30, 'userCode': '12345678', 'expiresIn': 600, 'interval': 3, 'verifyUrl': 'https://web.test/gateway-login.html?code=12345678'})
        if self.path == '/api/v1/gateway/login/poll':
            if not ACC['approved']: return out(200, {'status': 'pending'})
            return out(200, {'status': 'approved', 'token': 'regtok', 'uid': 42, 'user': 'chutram'})
        if self.path == '/api/v1/gateway/register': return out(403, {'error': 'too_many_gateways'})
        out(404, {})
    def log_message(self, *a): pass
ACC = {'approved': False, 'calls': []}
cat_srv = http.server.ThreadingHTTPServer(('127.0.0.1', 0), Cat); threading.Thread(target=cat_srv.serve_forever, daemon=True).start()
with open(os.path.join(data, 'config.json'), 'w', encoding='utf-8') as fh:
    json.dump({'Config': {'ConfigSchema': 1, 'Site': 'factory1', 'Device': 'wsh-test', 'Mobile': 'Off', 'PollMs': 1000, 'Pack': [], 'Connections': [],
               'CloudApiUrl': f'http://127.0.0.1:{cat_srv.server_address[1]}'}, 'Fields': {}, 'Devices': {}}, fh)
env = dict(os.environ, SIM_DATA=data, SIM_API_PORT=str(API), SIM_HTTP_PORT=str(HTTP), SIM_MBS_PORT='5503', SIM_RS485_TCP=f'127.0.0.1:{RS}', SIM_WINDOW_SEC='600', SIM_RPC_TEST='1')
log = open(os.path.join(data, 'sim.log'), 'w', encoding='utf-8', errors='replace')
proc = subprocess.Popen([EXE], env=env, cwd=data, stdout=log, stderr=subprocess.STDOUT)
CTX = ssl.create_default_context(); CTX.check_hostname = False; CTX.verify_mode = ssl.CERT_NONE
TOKEN = ''


def req(method, path, body=None, tls=True, token=None, raw=False):
    url = (f'https://127.0.0.1:{API}' if tls else f'http://127.0.0.1:{HTTP}') + path
    r = urllib.request.Request(url, method=method, data=json.dumps(body).encode() if body is not None else None,
                               headers={'Content-Type': 'application/json', 'Authorization': 'Bearer ' + (TOKEN if token is None else token)})
    try:
        with urllib.request.urlopen(r, context=CTX if tls else None, timeout=30) as resp: st, txt = resp.status, resp.read().decode('utf-8', 'backslashreplace')
    except urllib.error.HTTPError as e: st, txt = e.code, e.read().decode('utf-8', 'backslashreplace')
    if raw: return st, txt
    try: return st, json.loads(txt)
    except ValueError: return st, {}


try:
    for _ in range(60):
        try: socket.create_connection(('127.0.0.1', API), 1).close(); break
        except OSError: time.sleep(0.5)
    time.sleep(1)
    st, txt = req('GET', '/m', tls=False, raw=True)
    ok(st == 200 and f'https://' in txt and '/m' in txt, 'cổng 80: /m chỉ dẫn sang HTTPS')
    st, j = req('GET', '/api/m/state', tls=False)
    ok(st == 403 and j.get('Err') == 'use_https', 'cổng 80: /api/m/* bị từ chối')
    st, txt = req('GET', '/m', raw=True)
    ok(st == 200 and 'Đăng nhập kỹ thuật viên' in txt, 'HTTPS: trang điện thoại')
    st, j = req('GET', '/api/m/state')
    ok(st == 401, 'chưa đăng nhập → 401')
    st, j = req('POST', '/api/m/login', {'Name': ''})
    ok(st == 400 and j.get('Err') == 'name_required', 'đăng nhập phải có tên KTV')
    st, j = req('POST', '/api/m/login', {'Name': 'Anh Ba'})
    ok(st == 200 and j.get('Token'), 'đăng nhập trong cửa sổ cài đặt (board mới)')
    TOKEN = j.get('Token', '')
    st, j = req('GET', '/api/config')
    ok(st == 401, 'phiên KTV KHÔNG vào được API quản trị (/api/config)')
    st, j = req('POST', '/api/m/catalog', {})
    ok(st == 200 and len(j.get('Templates', [])) == 2 and not j.get('Msg'), 'danh sách mẫu tải từ server')
    TPL['rev'] = 2; TPL['templates'][0]['name'] = 'Biến tần INVT GD20 (bản mới)'
    st, j = req('POST', '/api/m/catalog', {})
    ok(j['Templates'][0]['name'].endswith('(bản mới)') and any('since=1' in h for h in CAT_HITS), 'kỹ sư sửa mẫu → KTV mở lại thấy ngay')
    st, j = req('POST', '/api/m/catalog', {})
    ok(j.get('Rev') == 2 and CAT_HITS[-1].endswith('since=2'), 'không đổi → server trả 304, dùng bản lưu')
    # ---- gắn tài khoản chủ trạm (device code)
    st, j = req('POST', '/api/m/account/start', {})
    ok(j.get('Ok') and j.get('UserCode') == '12345678' and 'deviceCode' not in json.dumps(j) and 'dc-' not in json.dumps(j), 'lấy mã gắn tài khoản (deviceCode không lộ ra điện thoại)')
    st, j = req('POST', '/api/m/account/poll', {})
    ok(j.get('Status') == 'pending', 'chờ chủ trạm duyệt')
    ACC['approved'] = True; time.sleep(3)
    st, j = req('POST', '/api/m/account/poll', {})
    reg = [c for c in ACC['calls'] if c[0] == '/api/v1/gateway/register']
    ok(not j.get('Ok') and 'tối đa' in j.get('Msg', ''), f'duyệt → board tự đăng ký, báo lỗi server rõ ràng: {j.get("Msg")}')
    ok(reg and reg[-1][2] == 'Bearer regtok' and reg[-1][1].get('pubkey') and reg[-1][1].get('sig'), 'board ký register bằng khoá của chính nó + token ngắn hạn')
    st, j = req('GET', '/api/m/state')
    ok(j['Account']['Registered'] is False and not j['Account']['Pending'], 'trạng thái tài khoản')
    cat_srv.shutdown(); cat_srv.server_close()
    st, j = req('POST', '/api/m/catalog', {})
    ok(len(j.get('Templates', [])) == 2 and j.get('Msg'), f'server mất → dùng bản đã lưu ({j.get("Msg", "")[:50]})')
    st, j = req('PUT', '/api/m/port', {'Baud': 9600, 'Parity': 'None', 'PollMs': 1000})
    ok(j.get('Ok'), 'lưu cổng RS485 9600 8-N-1')
    st, j = req('PUT', '/api/m/port', {'Baud': 1234, 'Parity': 'None', 'PollMs': 1000})
    ok(not j.get('Ok'), 'baud sai bị từ chối')
    st, j = req('POST', '/api/m/probe', {'Template': 'invt-gd20', 'Unit': 1})
    vals = {x['Field']: x.get('Value') for x in j.get('Items', [])}
    ok(j.get('Ok') and abs(vals.get('f', 0) - 50) < 1e-6 and abs(vals.get('a', 0) - 12.3) < 1e-6, f'đọc thử trước khi thêm (0x3000/0x3004): {vals}')
    st, j = req('POST', '/api/m/probe', {'Template': 'invt-gd20', 'Unit': 9})
    ok(not j.get('Ok') and 'dây' in j.get('Msg', ''), f'Slave ID không có → báo kiểm tra dây: {j.get("Msg")}')
    st, j = req('POST', '/api/m/device', {'Template': 'invt-gd20', 'Unit': 1, 'Title': 'Quạt hút xưởng 1'})
    gd = j.get('Child'); ok(j.get('Ok') and gd, f'thêm biến tần (child {gd})')
    st, j = req('POST', '/api/m/device', {'Template': 'xy-md02', 'Unit': 1, 'Title': 'Nhiệt ẩm kho'})
    ok(st == 409 and j.get('Err') == 'unit_used' and 'Quạt hút xưởng 1' in j.get('Msg', '') and j.get('Suggest') == 2, f'trùng Slave ID: {j.get("Msg")}')
    st, j = req('POST', '/api/m/device', {'Template': 'xy-md02', 'Unit': 3, 'Title': 'Nhiệt ẩm kho'})
    xy = j.get('Child'); ok(j.get('Ok'), 'thêm cảm biến nhiệt ẩm ID 3')
    time.sleep(3)
    st, s = req('GET', '/api/m/state')
    D = {d['Child']: d for d in s.get('Devices', [])}
    g = {f['Field']: f.get('Value') for f in D.get(gd, {}).get('Fields', [])}
    ok(set(g) == {'f', 'a', 'sp', 'cmd'} and abs((g['f'] or 0) - 50) < 1e-6, f'đã thêm: thông số ẩn (kw) không có, vòng đọc chạy: {g}')
    x = {f['Field']: f.get('Value') for f in D.get(xy, {}).get('Fields', [])}
    ok(abs((x.get('t') or 0) + 23.5) < 1e-6 and abs((x.get('h') or 0) - 61.2) < 1e-6, f'FC04 Int16 âm + đảo byte: {x}')
    ok(D.get(gd, {}).get('Kind') == 'rs485' and D[gd].get('Unit') == 1 and D[gd].get('Model') == 'invt-gd20', 'thẻ thiết bị: loại/ID/mẫu')
    st, j = req('POST', '/api/m/device', {'Child': gd, 'Template': 'invt-gd20', 'Unit': 1, 'Title': 'Quạt hút xưởng 1', 'Show': ['f', 'kw', 'sp', 'cmd']})
    ok(j.get('Ok') and j.get('Child') == gd, 'sửa: giữ child (khoá MQTT không đổi), hiện thêm Công suất')
    st, j = req('POST', '/api/m/probe', {'Child': gd})
    pv = {x['Field']: x.get('Value') for x in j.get('Items', [])}
    ok(j.get('Ok') and abs(pv.get('kw', 0) - 7.5) < 1e-6 and 'a' not in pv and 'cmd' not in pv, f'đọc thử thiết bị: Float32 CDAB, bỏ field ẩn/chỉ ghi: {pv}')
    WR.clear()
    st, j = req('POST', '/api/m/write', {'Child': gd, 'Field': 'sp', 'Value': 30})
    ok(j.get('Ok') and (1, 6, 0x2001, [3000]) in WR, f'ghi thử FC06 0x2001 = 3000: {WR}')
    st, j = req('POST', '/api/m/write', {'Child': gd, 'Field': 'cmd', 'Value': 1})
    ok(j.get('Ok') and (1, 16, 0x2000, [1]) in WR, 'ghi thử lệnh bằng FC16 (wfc 16)')
    st, j = req('POST', '/api/m/write', {'Child': gd, 'Field': 'sp', 'Value': 80})
    ok(not j.get('Ok') and 'khoảng' in j.get('Msg', ''), 'ghi ngoài Min/Max bị chặn')
    st, j = req('POST', '/api/m/dio', {'Kind': 'do', 'Ch': 2, 'Title': 'Đèn kho', 'Icon': 'bulb', 'Fb': 3})
    ok(j.get('Ok'), 'đặt tên DO2 + phản hồi DI3')
    st, j = req('POST', '/api/m/dio', {'Kind': 'do', 'Ch': 2, 'Title': 'Trùng'})
    ok(st == 409 and 'Đèn kho' in j.get('Msg', ''), 'DO2 đã dùng → báo trùng')
    st, j = req('POST', '/api/m/dio', {'Kind': 'di', 'Ch': 5, 'Title': 'Cửa tủ'})
    ok(j.get('Ok'), 'đặt tên DI5')
    st, j = req('POST', '/api/m/do', {'Ch': 1, 'On': True}); time.sleep(0.3)
    st, s = req('GET', '/api/m/state')
    ok(j.get('Ok') and s['Do'][0] == 1, 'thử chân DO1 (chưa đặt tên)')
    req('POST', '/api/m/do', {'Ch': 1, 'On': False})
    dio = [d for d in s['Devices'] if d['Kind'] == 'dio']
    ok(any(d.get('Ch') == 2 and d['Title'] == 'Đèn kho' for d in dio) and any(d.get('Ch') == -5 for d in dio), 'trạng thái: DO2/DI5 đã gán')
    st, j = req('POST', '/api/m/remove', {'Child': xy})
    ok(j.get('Ok') and not any(d['Child'] == xy for d in req('GET', '/api/m/state')[1]['Devices']), 'xoá thiết bị')
    # ---- GatewayAdmin qua relay (apiRpc) cùng lúc với KTV
    def rpc(m, p, b=None): return req('POST', '/sim/rpc', {'m': m, 'p': p, 'b': json.dumps(b) if b is not None else '', 'adm': 'PC kỹ sư'})
    st, rs = rpc('GET', '/api/m/state')
    ok(st == 200 and rs.get('Remote') and 'Anh Ba' in rs.get('Techs', []), 'GatewayAdmin xem trạng thái + thấy KTV đang đăng nhập')
    rev0 = rs['Rev']
    st, j = rpc('POST', '/api/m/device', {'Rev': rev0, 'Template': 'xy-md02', 'Unit': 4, 'Title': 'Nhiệt ẩm văn phòng'})
    ok(j.get('Ok'), 'GatewayAdmin thêm thiết bị')
    st, s2 = req('GET', '/api/m/state')
    ok(s2['Rev'] != rev0 and s2['LastChange']['By'].startswith('GatewayAdmin') and any(d['Title'] == 'Nhiệt ẩm văn phòng' for d in s2['Devices']), 'điện thoại thấy ngay thay đổi của GatewayAdmin')
    st, j = req('PUT', '/api/m/port', {'Rev': rev0, 'Baud': 19200, 'Parity': 'Even', 'PollMs': 1000})
    ok(st == 409 and j.get('Err') == 'rev_conflict' and 'GatewayAdmin' in j.get('Msg', ''), f'KTV lưu với Rev cũ → 409: {j.get("Msg")}')
    st, j = req('PUT', '/api/m/port', {'Rev': s2['Rev'], 'Baud': 9600, 'Parity': 'None', 'PollMs': 2000})
    st, rs = rpc('GET', '/api/m/state')
    ok(j.get('Ok') and rs['Port']['PollMs'] == 2000 and rs['LastChange']['By'].startswith('KTV'), 'GatewayAdmin thấy thay đổi của KTV')
    st, j = rpc('POST', '/api/m/probe', {'Template': 'xy-md02', 'Unit': 3})
    ok(st == 200, 'GatewayAdmin đọc thử từ xa')
    st, j = rpc('POST', '/api/m/write', {'Child': gd, 'Field': 'sp', 'Value': 10})
    ok(st == 403, 'GatewayAdmin KHÔNG ghi thử từ xa (chỉ tại chỗ)')
    st, j = rpc('POST', '/api/m/account/start', {})
    ok(st == 403, 'GatewayAdmin không gắn tài khoản thay KTV')
    st, j = rpc('POST', '/api/m/finish', {})
    ok(st == 403, 'GatewayAdmin không bấm hoàn tất thay KTV')
    st, j = req('POST', '/api/m/finish', {})
    ok(j.get('Ok'), 'hoàn tất lắp đặt')
    st, txt = req('GET', '/m', raw=True)
    ok(st == 404 and 'đã tắt' in txt, 'trang /m đã tắt')
    st, j = req('POST', '/api/m/login', {'Name': 'Người lạ'})
    ok(st == 403 and j.get('Err') == 'mobile_off', 'đăng nhập bị từ chối sau khi tắt (kể cả trong cửa sổ BOOT)')
    st, j = req('GET', '/api/m/state')
    ok(st == 403, 'phiên cũ không dùng được nữa')
    st, rs = rpc('GET', '/api/m/state')
    ok(st == 200 and rs.get('Enabled') is False, 'sau khi hoàn tất: GatewayAdmin vẫn XEM được')
    st, j = rpc('POST', '/api/m/device', {'Template': 'xy-md02', 'Unit': 9, 'Title': 'x'})
    ok(st == 403 and j.get('Err') == 'mobile_off', 'sau khi hoàn tất: GatewayAdmin không sửa được (phải bật lại)')
    st, j = rpc('PUT', '/api/mobile', {'Enabled': True})
    st2, j2 = rpc('POST', '/api/m/device', {'Template': 'xy-md02', 'Unit': 9, 'Title': 'Kho 2'})
    ok(st == 200 and j2.get('Ok'), 'GatewayAdmin bật lại → sửa được')
    with open(os.path.join(data, 'config.json'), encoding='utf-8') as fh: cfg = json.load(fh)
    pk = [p for p in cfg['Config']['Pack'] if p['Child'] == gd]
    ok(any(p['Field'] == 'kw' and p['WordSwap'] and p['Params']['fc'] == '3' for p in pk) and any(p['Field'] == 'cmd' and p['Params'].get('wfc') == '16' for p in pk), 'config.json: Params fc/wfc, WordSwap (GatewayApp đọc được)')
    ok(cfg['Devices'][gd]['Title'] == 'Quạt hút xưởng 1' and cfg['Fields'][gd + '.f']['Unit'] == 'Hz', 'config.json: Devices/Fields cho webapp')
finally:
    proc.kill(); log.close()
    if fails: print('Nhật ký board:', os.path.join(data, 'sim.log'))
    else: shutil.rmtree(data, ignore_errors=True)
print('KẾT QUẢ:', 'OK' if not fails else f'{fails} lỗi')
sys.exit(1 if fails else 0)
