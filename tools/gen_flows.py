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
"""
import argparse, json, os

ap = argparse.ArgumentParser()
ap.add_argument('--protocol', choices=['modbus', 's7'], default='modbus')
ap.add_argument('--plc-host', default='127.0.0.1'); ap.add_argument('--plc-port', default=None)
ap.add_argument('--unit', type=int, default=1, help='Modbus unit id')
ap.add_argument('--rack', default='0'); ap.add_argument('--slot', default='1')
ap.add_argument('--db', default='1', help='S7 data block holding the register map')
ap.add_argument('--site', default='factory1'); ap.add_argument('--dev', default='plc01')
ap.add_argument('--mqtt', default='wss://plc-mqtt.dieukhientudong.net:443/mqtt')
ap.add_argument('--mqtt-user', default=os.environ.get('MQTT_USER', 'gw'))
ap.add_argument('--mqtt-pass', default=os.environ.get('MQTT_PASS', ''))
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
else:
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

# ---- wiring
node(id='in_cmd', type='mqtt in', name='lệnh từ app', topic=f'{BASE}/cmd', qos='1', datatype='utf8', broker='mq', nl=False, rap=True, rh=0, inputs=0,
     x=140, y=420, wires=[['fn_cmd']])
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
    inject('inj_poll', 'đọc D0-D39 mỗi 1 s', 1, 140, 120, [['fn_rd']])
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
else:
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

os.makedirs(a.out, exist_ok=True)
json.dump(nodes, open(os.path.join(a.out, 'flows.json'), 'w', encoding='utf8'), ensure_ascii=False, indent=1)
json.dump({'mq': {'user': a.mqtt_user, 'password': a.mqtt_pass}}, open(os.path.join(a.out, 'flows_cred.json'), 'w'))
print(f'wrote {len(nodes)} nodes ({a.protocol}) to {os.path.abspath(a.out)}')
