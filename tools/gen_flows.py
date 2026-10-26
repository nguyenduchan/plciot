"""Generate the Node-RED flow that bridges a PLC to the project's MQTT contract.

  python tools/gen_flows.py --protocol modbus --plc-host 192.168.1.50 --mqtt wss://plc-mqtt.dieukhientudong.net:443/mqtt
  python tools/gen_flows.py --protocol s7     --plc-host 192.168.0.1  --rack 0 --slot 1

Writes edge/data/flows.json (+ flows_cred.json with the MQTT login, git-ignored).
The flow exposes the same 40-register map as the ESP32 gateway (docs/PROTOCOL.md), so the webapp is unchanged:
  telemetry  <base>/telemetry  {"r":[D0..D39]}   on change + 10 s heartbeat
  history    <base>/history    hourly block D100-D150 / D199-D248, once a minute
  status     <base>/status     online | plc_fault | offline (will)
  cmd/ack    <base>/cmd, <base>/ack   write (whitelisted) and read ({"op":"read","a":100,"n":4})
For Siemens, the PLC keeps the same map as INT[] in DB1 (register i = DB1.DBW(2*i)).

Protocols: modbus (Modbus TCP) | s7 (Siemens) | opcua | eip (Rockwell EtherNet/IP) | mc (Mitsubishi MC) | fins (Omron) | ads (Beckhoff).
Everything except modbus/s7 reads the whole 300-register image as one array (the PLC keeps the same D-map, see docs/NODE-RED.md).
Extras written into the same flow:
  --serve modbus,opcua   listen as a Modbus TCP slave / OPC UA server so other HMI/MES can READ the data (monitor only)
  InfluxDB 2 writer      so Grafana can chart it (edge/grafana)
  /scada                 local web monitor+control page (role based, behind scada-auth.js)
"""
import argparse, json, os

ap = argparse.ArgumentParser()
ap.add_argument('--protocol', choices=['modbus', 's7', 'opcua', 'eip', 'mc', 'fins', 'ads'], default='modbus')
ap.add_argument('--plc-host', default='127.0.0.1'); ap.add_argument('--plc-port', default=None)
ap.add_argument('--unit', type=int, default=1, help='Modbus unit id')
ap.add_argument('--rack', default='0'); ap.add_argument('--slot', default='1')
ap.add_argument('--db', default='1', help='S7 data block holding the register map')
ap.add_argument('--site', default='factory1'); ap.add_argument('--dev', default='plc01')
ap.add_argument('--mqtt', default='wss://plc-mqtt.dieukhientudong.net:443/mqtt')
ap.add_argument('--mqtt-user', default=os.environ.get('MQTT_USER', 'gw'))
ap.add_argument('--mqtt-pass', default=os.environ.get('MQTT_PASS', ''))
ap.add_argument('--opcua-endpoint', default='opc.tcp://127.0.0.1:4840', help='OPC UA client: PLC endpoint')
ap.add_argument('--opcua-image', default='ns=2;s=PLC_D', help='OPC UA client: NodeId of the UInt16[300] register image')
ap.add_argument('--opcua-write', default='ns=2;s=PLC_W{a}', help='OPC UA client: NodeId pattern of a writable register ({a} = D number)')
ap.add_argument('--eip-slot', default='0'); ap.add_argument('--eip-tag', default='PLC_D', help='EtherNet/IP: INT[300] controller tag')
ap.add_argument('--mc-type', default='Q', help='Mitsubishi PLC series: Q|L|QnA|iQ-R|iQ-L'); ap.add_argument('--mc-frame', default='3E')
ap.add_argument('--fins-protocol', default='udp', choices=['udp', 'tcp']); ap.add_argument('--fins-area', default='D', help='Omron memory area (D = DM)')
ap.add_argument('--ads-net-id', default='127.0.0.1.1.1'); ap.add_argument('--ads-port', default='851')
ap.add_argument('--ads-symbol', default='GVL_PLC.D', help='Beckhoff: ARRAY[0..299] OF INT symbol')
ap.add_argument('--serve', default='', help='comma list: modbus,opcua  (listen as a server for other HMI/MES; monitor only)')
ap.add_argument('--modbus-server-port', default='1502'); ap.add_argument('--opcua-server-port', default='4840')
ap.add_argument('--no-influx', action='store_true'); ap.add_argument('--influx-url', default='http://influxdb:8086')
ap.add_argument('--influx-org', default=None); ap.add_argument('--influx-bucket', default=None); ap.add_argument('--influx-token', default=None)
ap.add_argument('--influx-every', type=int, default=2, help='seconds between InfluxDB points')
ap.add_argument('--poll', type=float, default=1.0, help='seconds between register reads')
ap.add_argument('--no-web', action='store_true', help='do not generate the /scada page')
ap.add_argument('--out', default=os.path.join(os.path.dirname(__file__), '..', 'edge', 'data'))
a = ap.parse_args()

BASE = f'plc/{a.site}/{a.dev}'
WRITABLE = [3, 4, 6, 7, 9]
Z = 'tab_plc'
nodes = []


def node(**kw):
    kw.setdefault('z', Z)
    nodes.append(kw)
    return kw['id']


def fn(id, name, code, outputs, x, y, wires):
    return node(id=id, type='function', name=name, func=code.replace('__BASE__', BASE), outputs=outputs, timeout=0, noerr=0,
                initialize='', finalize='', libs=[], x=x, y=y, wires=wires)


def inject(id, name, secs, x, y, wires, once=True, delay=2):
    return node(id=id, type='inject', name=name, props=[{'p': 'payload'}], repeat=str(secs), crontab='', once=once,
                onceDelay=str(delay), topic='', payload='', payloadType='date', x=x, y=y, wires=wires)


node(id=Z, type='tab', label=f'PLC {a.protocol.upper()} → MQTT', disabled=False, info='', z=None)
nodes[-1].pop('z')
node(id='mq', type='mqtt-broker', name='Broker', broker=a.mqtt, port='1883', clientid=f'edge-{a.dev}', autoConnect=True, usetls=False,
     protocolVersion='4', keepalive='30', cleansession=True, autoUnsubscribe=True,
     birthTopic=f'{BASE}/status', birthQos='1', birthRetain='true', birthPayload='online', birthMsg={},
     closeTopic='', closeQos='0', closePayload='', closeMsg={},
     willTopic=f'{BASE}/status', willQos='1', willRetain='true', willPayload='offline', willMsg={}, userProps='', sessionExpiry='', z=None)
nodes[-1].pop('z')

# ---- common logic (shared by both protocols)
TELE = r'''
const BASE = "__BASE__";
const arr = Array.isArray(msg.payload) ? msg.payload : null;
if (!arr || arr.length < 40) return null;
const r = arr.slice(0, 40).map(v => v & 0xFFFF);          // INT (signed) -> unsigned register
const now = Date.now(), out = [];
flow.set('lastOk', now); flow.set('regs', r);
if (flow.get('status') !== 'online') { flow.set('status', 'online'); out.push({topic: BASE + '/status', payload: 'online', qos: 1, retain: true}); }
const last = context.get('last') || [];
const skip = i => i === 10 || i === 11 || (i >= 20 && i <= 35);   // per-second counters ride along
let changed = last.length !== r.length;
for (let i = 0; i < r.length && !changed; i++) if (!skip(i) && r[i] !== last[i]) changed = true;
if (changed || now - (context.get('lp') || 0) >= 10000) {
  context.set('last', r); context.set('lp', now);
  out.push({topic: BASE + '/telemetry', payload: JSON.stringify({r}), qos: 0, retain: true});
}
return [out.length ? out : null];
'''
HIST = r'''
const BASE = "__BASE__";
if (!Array.isArray(msg.payload)) return null;
context.set(msg.part, msg.payload.map(v => v & 0xFFFF));
const A = context.get('a'), B = context.get('b');
if (msg.part !== 'b' || !A || !B || A.length < 51 || B.length < 50) return null;
if (Date.now() - (context.get('lh') || 0) < 55000) return null;       // once a minute
context.set('lh', Date.now()); flow.set('ha', A); flow.set('hb', B);
const hist = {c: A.slice(0, 49), s: A[49], n: A[50], r: B[0], m: B.slice(1, 50)};
return {topic: BASE + '/history', payload: JSON.stringify(hist), qos: 0, retain: true};
'''
WATCHDOG = r'''
const BASE = "__BASE__";
if (Date.now() - (flow.get('lastOk') || 0) > 5000 && flow.get('status') !== 'plc_fault') {
  flow.set('status', 'plc_fault');
  return {topic: BASE + '/status', payload: 'plc_fault', qos: 1, retain: true};
}
return null;
'''
ACK = r'''
const BASE = "__BASE__";
const id = msg.cmd && msg.cmd.id;
const ok = __OK__;   // a failed Modbus request comes back as an empty payload (emptyMsgOnFail)
const extra = (__READ__ && Array.isArray(msg.payload)) ? {a: msg.cmd.a, v: msg.payload.map(v => v & 0xFFFF)} : {};
return {topic: BASE + '/ack', payload: JSON.stringify(Object.assign({id, ok}, extra)), qos: 0, retain: false};
'''

# ---- command parsing (protocol specific part is only how a message is built)
if a.protocol == 'modbus':
    CMD = r'''
const BASE = "__BASE__", W = %(W)s, UNIT = %(U)d;
let c; try { c = (typeof msg.payload === 'object' && !Buffer.isBuffer(msg.payload)) ? msg.payload : JSON.parse(String(msg.payload)); } catch (e) { return null; }
const ack = (ok) => ({topic: BASE + '/ack', payload: JSON.stringify({id: c.id, ok}), qos: 0, retain: false});
const a = Number(c.a);
if (c.op === 'read') {                                  // query any register range 0..299 straight from the PLC
  const n = Number(c.n || 1);
  if (!Number.isInteger(a) || !Number.isInteger(n) || a < 0 || n < 1 || n > 60 || a + n > 300) return [null, null, ack(false)];
  return [null, {payload: {fc: 3, unitid: UNIT, address: a, quantity: n}, cmd: {id: c.id, op: 'read', a, n}}, null];
}
const v = Number(c.v);
if (!W.includes(a) || !Number.isInteger(v) || v < 0 || v > 65535) return [null, null, ack(false)];
return [{payload: {value: v, fc: 6, unitid: UNIT, address: a, quantity: 1}, cmd: {id: c.id, op: 'w', a, v}}, null, null];
''' % {'W': json.dumps(WRITABLE), 'U': a.unit}
elif a.protocol == 's7':
    CMD = r'''
const BASE = "__BASE__", W = %(W)s;
let c; try { c = (typeof msg.payload === 'object' && !Buffer.isBuffer(msg.payload)) ? msg.payload : JSON.parse(String(msg.payload)); } catch (e) { return null; }
const ack = (ok, extra) => ({topic: BASE + '/ack', payload: JSON.stringify(Object.assign({id: c.id, ok}, extra || {})), qos: 0, retain: false});
const a = Number(c.a);
if (c.op === 'read') {                                  // S7: answered from the cached blocks that are polled
  const n = Number(c.n || 1);
  if (!Number.isInteger(a) || !Number.isInteger(n) || a < 0 || n < 1 || n > 60) return [null, ack(false)];
  const R = flow.get('regs') || [], HA = flow.get('ha') || [], HB = flow.get('hb') || [];
  const pick = (arr, base) => (a >= base && a + n <= base + arr.length) ? arr.slice(a - base, a - base + n) : null;
  const v = pick(R, 0) || pick(HA, 100) || pick(HB, 199);
  return [null, ack(!!v, v ? {a, v} : {})];
}
const v = Number(c.v);
if (!W.includes(a) || !Number.isInteger(v) || v < 0 || v > 65535) return [null, ack(false)];
return [{variable: 'w' + a, payload: v > 32767 ? v - 65536 : v}, ack(true)];   // INT is signed; ack is optimistic
''' % {'W': json.dumps(WRITABLE)}

IMG_CMD = r'''
const BASE = "__BASE__", W = %(W)s;
let c; try { c = (typeof msg.payload === 'object' && !Buffer.isBuffer(msg.payload)) ? msg.payload : JSON.parse(String(msg.payload)); } catch (e) { return null; }
const ack = (ok, extra) => ({topic: BASE + '/ack', payload: JSON.stringify(Object.assign({id: c.id, ok}, extra || {})), qos: 0, retain: false});
const a = Number(c.a);
if (c.op === 'read') {                                  // answered from the last polled 300-register image
  const n = Number(c.n || 1);
  if (!Number.isInteger(a) || !Number.isInteger(n) || a < 0 || n < 1 || n > 60 || a + n > 300) return [null, ack(false)];
  const I = flow.get('img') || [];
  const v = I.length >= a + n ? I.slice(a, a + n) : null;
  return [null, ack(!!v, v ? {a, v} : {})];
}
const v = Number(c.v);
if (!W.includes(a) || !Number.isInteger(v) || v < 0 || v > 65535) return [null, ack(false)];
return [%(WRITE)s, ack(true)];                          // ack is optimistic: the real value comes back in the next telemetry
'''

IMAGE = r'''
const arr0 = msg.payload;
let arr = Array.isArray(arr0) ? arr0 : (arr0 && typeof arr0 === 'object' ? Object.values(arr0) : null);
if (!arr || arr.length < 250) return null;
const I = arr.slice(0, 300).map(v => Number(v) & 0xFFFF);
while (I.length < 300) I.push(0);
flow.set('img', I);
return [{payload: I.slice(0, 40)}, {part: 'a', payload: I.slice(100, 151)}, {part: 'b', payload: I.slice(199, 249)}];
'''

# remote-control gate: lệnh từ MQTT (điện thoại/cloud) phải qua công tắc an toàn + giới hạn tốc độ
GATE = r'''
const BASE = "__BASE__";
let c; try { c = (typeof msg.payload === 'object' && !Buffer.isBuffer(msg.payload)) ? msg.payload : JSON.parse(String(msg.payload)); } catch (e) { return null; }
if (!c || typeof c !== 'object') return null;
const reject = (err) => ({topic: BASE + '/ack', payload: JSON.stringify({id: c.id, ok: false, err}), qos: 0, retain: false});
if (JSON.stringify(c).length > 512) return [null, reject('bad_size')];
const now = Date.now(), win = (context.get('win') || []).filter(t => now - t < 1000);
if (win.length >= Number(env.get('SCADA_REMOTE_RATE') || 5)) return [null, reject('rate_limited')];
win.push(now); context.set('win', win);
if (c.op !== 'read' && String(env.get('SCADA_ALLOW_REMOTE') || 'false').toLowerCase() !== 'true') {
  const audit = flow.get('audit') || []; audit.push(new Date().toISOString().slice(11, 19) + ' Từ chối lệnh từ xa D' + c.a + ' (remote_disabled)');
  flow.set('audit', audit.slice(-200));
  return [null, reject('remote_disabled')];
}
if (c.op !== 'read') { const audit = flow.get('audit') || []; audit.push(new Date().toISOString().slice(11, 19) + ' Lệnh từ xa D' + c.a + ' = ' + c.v); flow.set('audit', audit.slice(-200)); }
return [{payload: c}, null];
'''
# ---- wiring
node(id='in_cmd', type='mqtt in', name='lệnh từ app', topic=f'{BASE}/cmd', qos='1', datatype='utf8', broker='mq', nl=False, rap=True, rh=0, inputs=0,
     x=140, y=420, wires=[['fn_gate']])
fn('fn_gate', 'cổng điều khiển từ xa', GATE, 2, 140, 480, [['fn_cmd'], ['out_mq']])
node(id='out_mq', type='mqtt out', name='MQTT out', topic='', qos='', retain='', respTopic='', contentType='', userProps='', correl='', expiry='',
     broker='mq', x=1100, y=260, wires=[])
fn('fn_wd', 'giám sát mất PLC', WATCHDOG, 1, 320, 40, [['out_mq']])
inject('inj_wd', 'mỗi 2 s', 2, 140, 40, [['fn_wd']], once=False)

if a.protocol == 'modbus':
    port = a.plc_port or '502'
    node(id='mbc', type='modbus-client', name='PLC Modbus TCP', clienttype='tcp', bufferCommands=True, stateLogEnabled=False, queueLogEnabled=False,
         failureLogEnabled=False, tcpHost=a.plc_host, tcpPort=str(port), tcpType='DEFAULT', serialPort='/dev/ttyUSB0', serialType='RTU-BUFFERD',
         serialBaudrate='9600', serialDatabits='8', serialStopbits='1', serialParity='none', serialConnectionDelay='100',
         serialAsciiResponseStartDelimiter='0x3A', unit_id=str(a.unit), commandDelay='1', clientTimeout='1500', reconnectOnTimeout=True,
         reconnectTimeout='2000', parallelUnitIdsAllowed=True, z=None)
    nodes[-1].pop('z')
    getter = lambda id, x, y, w0, w1: node(id=id, type='modbus-flex-getter', name='', showStatusActivities=False, showErrors=False, showWarnings=False,
                                           logIOActivities=False, server='mbc', useIOFile=False, ioFile='', useIOForPayload=False, emptyMsgOnFail=False,
                                           keepMsgProperties=True, delayOnStart=False, startDelayTime='', x=x, y=y, wires=[w0, w1])
    inject('inj_poll', 'đọc D0-D39', a.poll, 140, 120, [['fn_rd']])
    fn('fn_rd', 'tạo lệnh đọc', 'msg.payload = {fc: 3, unitid: %d, address: 0, quantity: 40};\nreturn msg;' % a.unit, 1, 320, 120, [['mb_get']])
    getter('mb_get', 520, 120, ['fn_tele'], [])
    fn('fn_tele', 'telemetry', TELE, 1, 720, 120, [['out_mq']])
    inject('inj_hist', 'lịch sử mỗi 60 s', 60, 140, 200, [['fn_rdh']], delay=5)
    fn('fn_rdh', 'tạo lệnh đọc lịch sử', '''return [[
  {part: 'a', payload: {fc: 3, unitid: %d, address: 100, quantity: 51}},
  {part: 'b', payload: {fc: 3, unitid: %d, address: 199, quantity: 50}}]];''' % (a.unit, a.unit), 1, 320, 200, [['mb_geth']])
    getter('mb_geth', 520, 200, ['fn_hist'], [])
    fn('fn_hist', 'lịch sử theo giờ', HIST, 1, 720, 200, [['out_mq']])
    fn('fn_cmd', 'phân tích lệnh', CMD, 3, 320, 420, [['mb_w'], ['mb_q'], ['out_mq']])
    node(id='mb_w', type='modbus-flex-write', name='', showStatusActivities=False, showErrors=False, showWarnings=False, server='mbc',
         emptyMsgOnFail=True, keepMsgProperties=True, x=540, y=380, wires=[['ack_w'], []])
    getter('mb_q', 540, 460, ['ack_r'], [])
    nodes[-1]['emptyMsgOnFail'] = True
    fn('ack_w', 'ack ghi', ACK.replace('__OK__', "!(msg.payload === '' || msg.payload === undefined || msg.error)").replace('__READ__', 'false'), 1, 760, 380, [['out_mq']])
    fn('ack_r', 'ack đọc', ACK.replace('__OK__', 'Array.isArray(msg.payload)').replace('__READ__', 'true'), 1, 760, 460, [['out_mq']])
elif a.protocol == 's7':
    port = a.plc_port or '102'
    DB = a.db
    vt = [{'name': 'regs', 'addr': f'DB{DB},INT0.40'}, {'name': 'ha', 'addr': f'DB{DB},INT200.51'}, {'name': 'hb', 'addr': f'DB{DB},INT398.50'}]
    vt += [{'name': f'w{r}', 'addr': f'DB{DB},INT{2 * r}'} for r in WRITABLE]
    node(id='s7e', type='s7 endpoint', transport='iso-on-tcp', address=a.plc_host, port=str(port), rack=a.rack, slot=a.slot, localtsaphi='01', localtsaplo='00',
         remotetsaphi='01', remotetsaplo='00', connmode='rack-slot', adapter='', busaddr=2, cycletime=1000, timeout=2000, name='PLC Siemens S7', vartable=vt, z=None)
    nodes[-1].pop('z')
    s7in = lambda id, var, x, y, wires: node(id=id, type='s7 in', endpoint='s7e', mode='single', variable=var, diff=False, name=var, x=x, y=y, wires=[wires])
    s7in('s7_regs', 'regs', 140, 120, ['fn_tele'])
    fn('fn_tele', 'telemetry', TELE, 1, 400, 120, [['out_mq']])
    s7in('s7_ha', 'ha', 140, 200, ['fn_pa']); s7in('s7_hb', 'hb', 140, 260, ['fn_pb'])
    fn('fn_pa', 'phần a', "msg.part = 'a';\nreturn msg;", 1, 320, 200, [['fn_hist']])
    fn('fn_pb', 'phần b', "msg.part = 'b';\nreturn msg;", 1, 320, 260, [['fn_hist']])
    fn('fn_hist', 'lịch sử theo giờ', HIST, 1, 520, 230, [['out_mq']])
    fn('fn_cmd', 'phân tích lệnh', CMD, 2, 320, 420, [['s7_out'], ['out_mq']])
    node(id='s7_out', type='s7 out', endpoint='s7e', variable='', name='ghi DB', x=540, y=400, wires=[])


# ======================================================================================
# Client drivers that read the whole 300-register image (opcua / eip / mc / fins / ads)
# ======================================================================================
if a.protocol not in ('modbus', 's7'):
    P = a.protocol
    fn('fn_tele', 'telemetry', TELE, 1, 720, 120, [['out_mq']])
    fn('fn_hist', 'lịch sử theo giờ', HIST, 1, 720, 200, [['out_mq']])
    fn('fn_image', 'tách ảnh thanh ghi', IMAGE, 3, 520, 160, [['fn_tele'], ['fn_hist'], ['fn_hist']])
    last = a.plc_host.split('.')[-1]
    if P == 'mc':
        node(id='mcc', type='MC Protocol Connection', name='PLC Mitsubishi MC', host=a.plc_host, port=str(a.plc_port or '5001'), protocol='TCP',
             frame=a.mc_frame, plcType=a.mc_type, ascii=False, PLCStation=0, timeout=1000, octalInputOutput=False, z=None)
        nodes[-1].pop('z')
        inject('inj_poll', 'đọc D0-D299 mỗi 1 s', 1, 140, 120, [['fn_poll']])
        fn('fn_poll', 'địa chỉ đọc', "return {address: 'DUINT0,300'};", 1, 320, 120, [['rd']])
        node(id='rd', type='MC Read', name='đọc D0..D299', topic='', connection='mcc', address='address', addressType='msg', outputFormat=1,
             errorHandling='throw', outputs=1, x=420, y=120, wires=[['fn_image']])
        WRITE = "{address: 'DUINT' + a, payload: v}"
        node(id='wr', type='MC Write', name='ghi D', topic='', connection='mcc', address='address', addressType='msg', data='payload', dataType='msg',
             errorHandling='throw', outputs=1, x=560, y=420, wires=[[]])
    elif P == 'fins':
        node(id='fnc', type='FINS Connection', name='PLC Omron FINS', host=a.plc_host, port=int(a.plc_port or 9600), MODE='', MODEType='CS', protocol='',
             protocolType=a.fins_protocol, ICF=128, DNA=0, DA1=int(last) if last.isdigit() else 0, DA2=0, SNA=0, SA1=0, SA2=0, autoConnect=False, z=None)
        nodes[-1].pop('z')
        inject('inj_poll', 'đọc D0-D299 mỗi 1 s', 1, 140, 120, [['fn_poll']])
        fn('fn_poll', 'địa chỉ đọc', "return {topic: '%s0'};" % a.fins_area, 1, 320, 120, [['rd']])
        node(id='rd', type='FINS Read', name='đọc D0..D299', connection='fnc', addressType='msg', address='topic', countType='num', count=300,
             msgPropertyType='msg', msgProperty='payload', outputFormatType='list', outputFormat='unsigned', x=420, y=120, wires=[['fn_image']])
        WRITE = "{topic: '%s' + a, payload: v}" % a.fins_area
        node(id='wr', type='FINS Write', name='ghi D', connection='fnc', addressType='msg', address='topic', dataType='msg', data='payload',
             msgPropertyType='str', msgProperty='payload', x=560, y=420, wires=[[]])
    elif P == 'ads':
        node(id='adsc', type='ads-client-connection', name='PLC Beckhoff ADS', targetAmsNetId=a.ads_net_id, targetAdsPort=int(a.ads_port),
             routerAddress=a.plc_host, routerTcpPort=48898, autoReconnect=True, z=None)
        nodes[-1].pop('z')
        inject('inj_poll', 'đọc mảng mỗi 1 s', 1, 140, 120, [['fn_poll']])
        fn('fn_poll', 'symbol đọc', "return {topic: '%s'};" % a.ads_symbol, 1, 320, 120, [['rd']])
        node(id='rd', type='ads-client-read-value', name='đọc mảng D', connection='adsc', path='', x=420, y=120, wires=[['fn_image']])
        WRITE = "{topic: '%s[' + a + ']', payload: v > 32767 ? v - 65536 : v}" % a.ads_symbol      # ARRAY OF INT là có dấu
        node(id='wr', type='ads-client-write-value', name='ghi D', connection='adsc', path='', autoFill=False, x=560, y=420, wires=[[]])
    elif P == 'opcua':
        node(id='ouae', type='OpcUa-Endpoint', name='PLC OPC UA', endpoint=a.opcua_endpoint, secpol='None', secmode='None', none=True, login=False,
             usercert=False, usercertificate='', userprivatekey='', z=None)
        nodes[-1].pop('z')
        cl = lambda id, act, x, y, w: node(id=id, type='OpcUa-Client', endpoint='ouae', action=act, deadbandtype='a', deadbandvalue=1, time=10, timeUnit='s',
                                          certificate='n', localfile='', localkeyfile='', securitymode='None', securitypolicy='None', useTransport=False,
                                          maxChunkCount=1, maxMessageSize=8192, receiveBufferSize=8192, sendBufferSize=8192, setstatusandtime=False,
                                          keepsessionalive=True, name=act, x=x, y=y, wires=[w])
        inject('inj_poll', 'đọc ảnh mỗi 1 s', 1, 140, 120, [['fn_poll']])
        fn('fn_poll', 'NodeId đọc', "return {topic: '%s', action: 'read', payload: ''};" % a.opcua_image, 1, 320, 120, [['rd']])
        cl('rd', 'read', 420, 120, ['fn_image'])
        WRITE = "{topic: '%s'.replace('{a}', a) + ';datatype=UInt16', action: 'write', payload: v}" % a.opcua_write
        cl('wr', 'write', 560, 420, [])
    elif P == 'eip':
        want = list(range(40)) + list(range(100, 151)) + list(range(199, 249))
        vt = {'': {f'{a.eip_tag}[{i}]': {'type': 'INT'} for i in want}}
        node(id='eipe', type='eth-ip endpoint', name='PLC Rockwell EtherNet/IP', address=a.plc_host, slot=a.eip_slot, cycletime=1000, vartable=vt, z=None)
        nodes[-1].pop('z')
        node(id='rd', type='eth-ip in', name='đọc tất cả', endpoint='eipe', mode='all', variable='', program='', diff=False, x=140, y=120, wires=[['fn_eipimg']])
        fn('fn_eipimg', 'gom thành ảnh 300 thanh ghi', r'''
const I = new Array(300).fill(0);
for (const k of Object.keys(msg.payload || {})) {
  const m = /\[(\d+)\]$/.exec(k); if (m && +m[1] < 300) I[+m[1]] = Number(msg.payload[k]) & 0xFFFF;
}
msg.payload = I; return msg;''', 1, 330, 120, [['fn_image']])
        WRITE = "{payload: v > 32767 ? v - 65536 : v, a}"
        for w in WRITABLE:
            node(id=f'wr{w}', type='eth-ip out', name=f'ghi D{w}', endpoint='eipe', variable=f'{a.eip_tag}[{w}]', program='', x=760, y=380 + 40 * WRITABLE.index(w), wires=[])
    fn('fn_cmd', 'phân tích lệnh', IMG_CMD % {'W': json.dumps(WRITABLE), 'WRITE': WRITE}, 2, 320, 420, [['fn_route'] if P == 'eip' else ['wr'], ['out_mq']])
    if P == 'eip':
        fn('fn_route', 'chọn thanh ghi ghi', "const W = %s; const o = W.map(() => null); const i = W.indexOf(msg.a); if (i < 0) return null; o[i] = msg; return o;" % json.dumps(WRITABLE),
           len(WRITABLE), 520, 420, [[f'wr{w}'] for w in WRITABLE])

# ======================================================================================
# InfluxDB writer (Grafana reads this)
# ======================================================================================
def dotenv():
    env = {}
    pth = os.path.join(os.path.dirname(__file__), '..', 'edge', '.env')
    if os.path.exists(pth):
        for ln in open(pth, encoding='utf8'):
            ln = ln.split('#')[0].strip()
            if '=' in ln:
                k, v = ln.split('=', 1); env[k.strip()] = v.strip()
    return env

ENV = dotenv()
INFLUX_ORG = a.influx_org or ENV.get('INFLUX_ORG', 'plciot')
INFLUX_BUCKET = a.influx_bucket or ENV.get('INFLUX_BUCKET', 'plc')
INFLUX_TOKEN = a.influx_token or ENV.get('INFLUX_TOKEN', '')
INFLUX = r'''
const R = flow.get('regs'); if (!R) return null;
const tags = {site: "__SITE__", device: "__DEV__"}, ts = new Date();
const fresh = Date.now() - (flow.get('lastOk') || 0) < 5000;
const pts = [{measurement: 'plc_status', tags, fields: {online: (fresh && flow.get('status') === 'online') ? 1 : 0}, timestamp: ts}];
if (fresh) {
  const f = {inputs: R[0], outputs: R[1], alarms: R[2], mode: R[3], run_req: R[6], target: R[7], conveyor: R[8],
    count: R[14] + R[15] * 65536, total: R[16] + R[17] * 65536, run_s: R[10] + R[11] * 65536, pump_starts: R[12] + R[13] * 65536,
    estop: R[2] & 1, level_fault: (R[2] >> 1) & 1};
  for (let i = 0; i < 8; i++) { f['x' + i] = (R[0] >> i) & 1; f['y' + i] = (R[1] >> i) & 1; }
  pts.push({measurement: 'plc', tags, fields: f, timestamp: ts});
}
return {payload: pts};
'''.replace('__SITE__', a.site).replace('__DEV__', a.dev)
if not a.no_influx:
    node(id='influx', type='influxdb', name='InfluxDB', influxdbVersion='2.0', url=a.influx_url, hostname='influxdb', port=8086, protocol='http',
         database='database', usetls=False, timeout='10', rejectUnauthorized=True, z=None)
    nodes[-1].pop('z')
    inject('inj_influx', f'ghi InfluxDB mỗi {a.influx_every} s', a.influx_every, 140, 560, [['fn_influx']], delay=5)
    fn('fn_influx', 'điểm dữ liệu', INFLUX, 1, 340, 560, [['out_influx']])
    node(id='out_influx', type='influxdb batch', influxdb='influx', name='InfluxDB', precision='', retentionPolicy='', database='database',
         precisionV18FluxV20='ms', retentionPolicyV18Flux='', org=INFLUX_ORG, bucket=INFLUX_BUCKET, x=560, y=560, wires=[])

# ======================================================================================
# /scada : local web monitor + control (login by scada-auth.js, role in msg.req.scadaRole)
# ======================================================================================
WEBDIR = os.path.join(os.path.dirname(__file__), '..', 'edge', 'web')
if not a.no_web:
    page = open(os.path.join(WEBDIR, 'index.html'), encoding='utf8').read()
    pjs = open(os.path.join(WEBDIR, 'app.js'), encoding='utf8').read()
    NEEDAUTH = "if (!msg.req || !msg.req.scadaRole) return {statusCode: 401, payload: 'unauthorized', headers: {'content-type': 'text/plain'}};\n"
    SEC = "{'content-type': '%s', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff', 'x-frame-options': 'DENY', 'referrer-policy': 'no-referrer'}"
    resp = node(id='http_resp', type='http response', name='', statusCode='', headers={}, x=980, y=700, wires=[])
    def route(id, method, url, label, code, y, outs=1, wires=None):
        # http response needs the original msg.req/res: re-attach them to any reply that carries a statusCode
        code = ("const __f = () => {\n" + code + "\n};\nconst __r = __f();\n"
                "const __fix = (m) => (m && m.statusCode !== undefined) ? Object.assign(m, {req: msg.req, res: msg.res}) : m;\n"
                "return Array.isArray(__r) ? __r.map(__fix) : __fix(__r);")
        node(id='wi_' + id, type='http in', name=label, url=url, method=method, upload=False, swaggerDoc='', x=140, y=y, wires=[['wf_' + id]])
        fn('wf_' + id, label, code, outs, 420, y, wires or [['http_resp']])
    route('page', 'get', '/scada', 'trang điều khiển', NEEDAUTH + "return {statusCode: 200, headers: %s, payload: %s};" % (SEC % 'text/html; charset=utf-8', json.dumps(page)), 660)
    route('page2', 'get', '/scada/', 'trang điều khiển /', NEEDAUTH + "return {statusCode: 200, headers: %s, payload: %s};" % (SEC % 'text/html; charset=utf-8', json.dumps(page)), 700)
    route('js', 'get', '/scada/app.js', 'app.js', NEEDAUTH + "return {statusCode: 200, headers: %s, payload: %s};" % (SEC % 'text/javascript; charset=utf-8', json.dumps(pjs)), 740)
    STATE = NEEDAUTH + r'''
const R = flow.get('regs') || new Array(40).fill(0), H = flow.get('ha'), HB = flow.get('hb');
const fresh = Date.now() - (flow.get('lastOk') || 0) < 5000;
const conv = ['Dừng', 'Chạy', 'Đủ số lượng', 'E-stop'];
const u32 = (i) => R[i] + R[i + 1] * 65536;
const body = {user: msg.req.scadaUser, role: msg.req.scadaRole, site: "__SITE__", device: "__DEV__",
  status: flow.get('status') || 'offline', fresh, regs: R, inputs: R[0], outputs: R[1], alarms: R[2], manual: R[3] === 1, manualMask: R[4],
  runRequested: R[6] === 1, target: R[7], conveyor: R[8], conveyorText: conv[R[8]] || '?', count: u32(14), total: u32(16), runSeconds: u32(10), pumpStarts: u32(12),
  history: (H && HB) ? {c: H.slice(0, 49), s: H[49], n: H[50], m: HB.slice(1, 50)} : null,
  lastAck: null, cloud: flow.get('mqtt') || 'unknown', localClients: 0,
  remoteAllowed: String(env.get('SCADA_ALLOW_REMOTE') || 'false').toLowerCase() === 'true'};
return {statusCode: 200, headers: {'content-type': 'application/json', 'cache-control': 'no-store'}, payload: JSON.stringify(body)};
'''.replace('__SITE__', a.site).replace('__DEV__', a.dev)
    route('state', 'get', '/scada/api/state', 'trạng thái', STATE, 780)
    route('log', 'get', '/scada/api/log', 'nhật ký', NEEDAUTH + "return {statusCode: 200, headers: {'content-type': 'application/json', 'cache-control': 'no-store'}, payload: JSON.stringify(flow.get('audit') || [])};", 820)
    WEBCMD = NEEDAUTH + r'''
const W = %s, fail = (code, err) => [{statusCode: code, headers: {'content-type': 'application/json'}, payload: JSON.stringify({error: err})}, null];
if (msg.req.headers['x-requested-with'] !== 'scada') return fail(400, 'bad_request');
if (msg.req.scadaRole !== 'operator') return fail(403, 'forbidden');
const c = msg.payload || {}, a = Number(c.a), v = Number(c.v);
if (!W.includes(a)) return fail(400, 'not_writable');
if (!Number.isInteger(v) || v < 0 || v > 65535) return fail(400, 'bad_value');
const audit = flow.get('audit') || []; audit.push(new Date().toISOString().slice(11, 19) + ' Điều khiển cục bộ (' + msg.req.scadaUser + '): D' + a + ' = ' + v);
flow.set('audit', audit.slice(-200));
return [{statusCode: 200, headers: {'content-type': 'application/json'}, payload: JSON.stringify({ok: true})}, {payload: {id: 'w' + Date.now().toString(36), a, v}}];
''' % json.dumps(WRITABLE)
    route('cmd', 'post', '/scada/api/cmd', 'lệnh điều khiển', WEBCMD, 860, outs=2, wires=[['http_resp'], ['fn_cmd']])

# ======================================================================================
# Listen as a server for other HMI / MES (monitor only — nothing written by a client reaches the PLC)
# ======================================================================================
SERVE = [s.strip() for s in a.serve.split(',') if s.strip()]
IMGBUILD = r'''
const I = flow.get('img') ? flow.get('img').slice() : new Array(300).fill(0);
if (!flow.get('img')) { (flow.get('regs') || []).forEach((v, i) => I[i] = v); (flow.get('ha') || []).forEach((v, i) => I[100 + i] = v); (flow.get('hb') || []).forEach((v, i) => I[199 + i] = v); }
'''
if 'modbus' in SERVE:
    MBS = IMGBUILD + r'''
const sid = msg._session && msg._session.id; if (!sid || !Buffer.isBuffer(msg.payload)) return null;
const key = 'b' + sid;
let buf = Buffer.concat([context.get(key) || Buffer.alloc(0), msg.payload]);
if (buf.length > 1024) { context.set(key, null); return null; }
const fresh = Date.now() - (flow.get('lastOk') || 0) < 5000;
const out = [];
while (buf.length >= 8) {
  const len = buf.readUInt16BE(4);
  if (buf.readUInt16BE(2) !== 0 || len < 2 || len > 254) { buf = Buffer.alloc(0); break; }     // không phải Modbus TCP
  if (buf.length < 6 + len) break;
  const fc = buf[7], hdr = Buffer.from(buf.subarray(0, 4));
  let pdu;
  const exc = (code) => Buffer.from([fc | 0x80, code]);
  if ((fc === 3 || fc === 4) && len === 6) {
    const addr = buf.readUInt16BE(8), qty = buf.readUInt16BE(10);
    if (qty < 1 || qty > 125) pdu = exc(3);
    else if (addr + qty > 300) pdu = exc(2);
    else if (!fresh) pdu = exc(4);                              // PLC mất liên lạc: báo lỗi thay vì dữ liệu cũ
    else { pdu = Buffer.alloc(2 + qty * 2); pdu[0] = fc; pdu[1] = qty * 2; for (let i = 0; i < qty; i++) pdu.writeUInt16BE(I[addr + i] & 0xFFFF, 2 + i * 2); }
  } else pdu = exc(1);                                           // chỉ giám sát: mọi lệnh ghi bị từ chối
  const rsp = Buffer.alloc(7 + pdu.length);
  hdr.copy(rsp, 0); rsp.writeUInt16BE(pdu.length + 1, 4); rsp[6] = buf[6]; pdu.copy(rsp, 7);
  out.push({payload: rsp, _session: msg._session});
  buf = buf.subarray(6 + len);
}
context.set(key, buf.length ? Buffer.from(buf) : null);
return [out];
'''
    node(id='tcp_in', type='tcp in', name='Modbus TCP server', server='server', host='', port=str(a.modbus_server_port), datamode='stream', datatype='buffer',
         newline='', topic='', trim=False, base64=False, tls='', x=140, y=940, wires=[['fn_mbs']])
    fn('fn_mbs', 'trả lời Modbus (chỉ đọc)', MBS, 1, 360, 940, [['tcp_out']])
    node(id='tcp_out', type='tcp out', name='', host='', port='', beserver='reply', base64=False, end=False, tls='', x=580, y=940, wires=[])

if 'opcua' in SERVE:
    VARS = [('Status', 'String'), ('Online', 'Boolean'), ('Inputs', 'Int32'), ('Outputs', 'Int32'), ('Alarms', 'Int32'), ('Mode', 'Int32'), ('RunRequest', 'Int32'),
            ('Target', 'Int32'), ('Conveyor', 'Int32'), ('Count', 'Int32'), ('Total', 'Int32'), ('RunSeconds', 'Int32'), ('PumpStarts', 'Int32')]
    node(id='ua_srv', type='OpcUa-Server', port=str(a.opcua_server_port), name='OPC UA server (chỉ đọc)', endpoint='', usersFile='users.json', nodesetDir='',
         autoAcceptUnknownCertificate=False, registerToDiscovery=False, constructDefaultAddressSpace=True, allowAnonymous=True, endpointNone=True, endpointSign=True,
         endpointSignEncrypt=True, endpointBasic128Rsa15=False, endpointBasic256=False, endpointBasic256Sha256=True, maxSessions=10, maxConnectionsPerEndpoint=10,
         maxMessageSize=4096, maxBufferSize=4096, x=560, y=1020, wires=[[]])
    inject('inj_ua_init', 'tạo biến OPC UA', 1, 140, 1020, [['fn_ua_init']], once=True, delay=15)
    nodes[-1]['repeat'] = ''
    ADDV = ";\n".join(f"out.push({{topic: 'ns=1;s={n};datatype={t}', payload: {{opcuaCommand: 'addVariable'}}}})" for n, t in VARS)
    fn('fn_ua_init', 'khai báo biến', "const out = [{topic: 'ns=1;s=PLC', payload: {opcuaCommand: 'addFolder'}}];\n" + ADDV + ";\nreturn [out];", 1, 340, 1020, [['ua_srv']])
    inject('inj_ua', 'cập nhật mỗi 1 s', 1, 140, 1080, [['fn_ua']], delay=20)
    fn('fn_ua', 'giá trị', r'''
const R = flow.get('regs'); if (!R) return null;
const fresh = Date.now() - (flow.get('lastOk') || 0) < 5000, u32 = (i) => R[i] + R[i + 1] * 65536;
const v = {Status: flow.get('status') || 'offline', Online: fresh && flow.get('status') === 'online', Inputs: R[0], Outputs: R[1], Alarms: R[2], Mode: R[3], RunRequest: R[6],
  Target: R[7], Conveyor: R[8], Count: u32(14), Total: u32(16), RunSeconds: u32(10), PumpStarts: u32(12)};
return [Object.keys(v).map(k => ({payload: {messageType: 'Variable', namespace: '1', variableName: k, variableValue: v[k]}}))];''', 1, 340, 1080, [['ua_srv']])

ids = [n['id'] for n in nodes]
assert len(ids) == len(set(ids)), 'duplicate node ids: %s' % sorted({i for i in ids if ids.count(i) > 1})
os.makedirs(a.out, exist_ok=True)
json.dump(nodes, open(os.path.join(a.out, 'flows.json'), 'w', encoding='utf8'), ensure_ascii=False, indent=1)
cred = {'mq': {'user': a.mqtt_user, 'password': a.mqtt_pass}}
if not a.no_influx: cred['influx'] = {'token': INFLUX_TOKEN}
json.dump(cred, open(os.path.join(a.out, 'flows_cred.json'), 'w'))
print(f'wrote {len(nodes)} nodes ({a.protocol}) to {os.path.abspath(a.out)}')
