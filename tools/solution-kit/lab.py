# -*- coding: utf-8 -*-
"""Phòng thử: dựng PlcSim + cấu hình GatewayApp có ĐỦ dữ liệu cho MỘT giải pháp (đúng thiết bị/field của solutions/<id>/gateway/setup.json,
giá trị sinh theo cùng bộ mẫu của spec) để webapp của giải pháp nhận live data thật: PlcSim → Modbus TCP → GatewayApp → cloud → webapp.

  python tools/solution-kit/lab.py <id>        ghi PlcSim settings + gateway config.json/config.ui.json (sao lưu bản gốc lần đầu)
  python tools/solution-kit/lab.py --restore   trả các file về bản gốc đã sao lưu
Sau khi ghi: dừng PlcSim + GatewayApp, mở lại PlcSim --autostart rồi GatewayApp --autostart (xem lab.ps1).
Site/Device/MQTT của gateway giữ nguyên (chỉ đổi Pack + tên/đơn vị widget)."""
import json, os, shutil, sys

repo = os.path.abspath(os.path.join(os.path.dirname(__file__), '..', '..'))
PLCSIM = os.path.join(os.environ.get('APPDATA', ''), 'PlcSim', 'settings.json')
GWDIR = os.path.join(os.environ.get('ProgramData', r'C:\ProgramData'), 'PlciotScada', 'gateway-app')
GWCFG, GWUI = os.path.join(GWDIR, 'config.json'), os.path.join(GWDIR, 'config.ui.json')
BAK = os.path.join(os.environ.get('TEMP', '.'), 'plciot-lab-backup')
FILES = {'plcsim.json': PLCSIM, 'config.json': GWCFG, 'config.ui.json': GWUI}


def backup():
    os.makedirs(BAK, exist_ok=True)
    for name, src in FILES.items():
        dst = os.path.join(BAK, name)
        if os.path.exists(src) and not os.path.exists(dst):
            shutil.copy2(src, dst)


def restore():
    for name, dst in FILES.items():
        src = os.path.join(BAK, name)
        if os.path.exists(src):
            shutil.copy2(src, dst)
            print('khôi phục', dst)
    print('xong')


def load_spec(sid):
    t = open(os.path.join(repo, 'solutions', sid, 'webapp', 'spec.js'), encoding='utf-8').read()
    return json.loads(t[t.index('window.INDUSTRY =') + 17:].rstrip().rstrip(';'))


def gen_of(g, field):
    """Bộ sinh mẫu của spec → chế độ PlcSim (Fixed/Sine/Ramp), giá trị đầu, min, max, chu kỳ, bước."""
    if isinstance(g, (int, float)):
        return ('Fixed', g, 0, 100, 60, 1)
    if isinstance(g, list):
        base, amp = g[0], g[1]
        per = g[2] if len(g) > 2 else 60
        return ('Sine', base, base - abs(amp), base + abs(amp), per, 1)
    if isinstance(g, dict):
        if 'sin' in g:
            b, a = g['sin'][0], g['sin'][1]
            return ('Sine', b, b - abs(a), b + abs(a), g['sin'][2] if len(g['sin']) > 2 else 60, 1)
        if 'sq' in g:   # xung vuông: trạng thái bình thường = giá trị "bật" (phần tử 2)
            return ('Fixed', g['sq'][1], 0, 1, 60, 1)
        if 'cnt' in g:
            s, r = g.get('start', 0), g['cnt']
            return ('Ramp', s, s, s + max(1, r * 3600), 60, max(r, 0.01))
    return ('Fixed', 0, 0, 100, 60, 1)


KIND = {'gauge': 'gauge', 'switch': 'toggle', 'kpi': 'number', 'led': 'number', 'tank': 'tank'}


def build(sid):
    spec, setup = load_spec(sid), json.load(open(os.path.join(repo, 'solutions', sid, 'gateway', 'setup.json'), encoding='utf-8'))
    fields, pack, meta_f, meta_d = [], [], {}, {}
    addr = 50
    for dv in setup['devices']:
        gens = spec['demo']['devices'][dv['id']]['f']
        meta_d[dv['id']] = {'Title': dv['name'], 'Template': '', 'Icon': '', 'Color': ''}
        for f in dv['fields']:
            mode, val, mn, mx, per, step = gen_of(gens[f['key']], f['key'])
            writable = f.get('writable', False)
            fields.append([dv['id'], f['key'], str(val), str(addr), '1', mode, str(mn), str(mx), str(per), str(step), 'modbus',
                           'ReadWrite' if writable else 'Read', 'unit=1', 'Float32', 'False', ''])
            pack.append({'Child': dv['id'], 'Field': f['key'], 'MqttKey': '', 'Address': addr, 'Scale': 1, 'Min': 0 if writable else None, 'Max': 1 if writable else None,
                         'Protocol': 'ModbusTcp', 'Access': 'ReadWrite' if writable else 'Read', 'DataType': 'Float32', 'WordSwap': False,
                         'Params': {'unit': '1'}, 'Group': '', 'Enabled': True})
            meta_f[f"{dv['id']}.{f['key']}"] = {'Kind': KIND.get(f.get('widget'), 'auto'), 'Unit': f.get('unit', ''), 'Title': f.get('lbl', f['key']),
                                                'Min': f.get('min'), 'Max': f.get('max'), 'OnText': f.get('on', ''), 'OffText': f.get('off', ''), 'Low': None, 'High': None}
            addr += 2
    return fields, pack, meta_f, meta_d, addr


def main():
    if len(sys.argv) < 2:
        print(__doc__); return 2
    if sys.argv[1] == '--restore':
        return restore()
    sid = sys.argv[1]
    backup()
    fields, pack, meta_f, meta_d, end = build(sid)
    if end > 299:
        print('quá 300 thanh ghi D:', end); return 1
    ps = json.load(open(PLCSIM, encoding='utf-8-sig'))
    ps['Fields'] = fields
    json.dump(ps, open(PLCSIM, 'w', encoding='utf-8'), ensure_ascii=False, indent=1)
    cfg = json.load(open(GWCFG, encoding='utf-8-sig'))
    cfg['Pack'] = pack
    json.dump(cfg, open(GWCFG, 'w', encoding='utf-8'), ensure_ascii=False, indent=2)
    json.dump({'Fields': meta_f, 'Devices': meta_d}, open(GWUI, 'w', encoding='utf-8'), ensure_ascii=False, indent=2)
    print(f'{sid}: {len(setup_devices(sid))} thiết bị, {len(fields)} field, D50..D{end - 1}')
    return 0


def setup_devices(sid):
    return json.load(open(os.path.join(repo, 'solutions', sid, 'gateway', 'setup.json'), encoding='utf-8'))['devices']


if __name__ == '__main__':
    sys.exit(main())
