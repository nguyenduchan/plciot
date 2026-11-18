# -*- coding: utf-8 -*-
"""Sinh solutions/<id>/ từ specs.py + specs_extra.py + industry.js/css (chạy: python tools/solution-kit/gen.py [id ...]).
Mỗi thư mục sinh ra ĐỘC LẬP (copy engine vào từng giải pháp) nên chép riêng lên server vẫn chạy.
Cũng sinh gateway/setup.json: bản khai gateway (thiết bị + field) mà giao diện của giải pháp này cần — dán vào GatewayApp hoặc gửi khi ghép cặp."""
import json, os, sys

here = os.path.dirname(os.path.abspath(__file__))
repo = os.path.abspath(os.path.join(here, '..', '..'))
sys.path.insert(0, here)
from specs import SPECS  # noqa: E402
from specs_extra import SPECS as EXTRA  # noqa: E402
from requirements import REQ  # noqa: E402
import icons_gen  # noqa: E402

ALL = SPECS + EXTRA
only = set(sys.argv[1:])
root = os.path.join(repo, 'solutions')


def theme_css(spec):
    p = spec['palette']

    def block(c, accbg):
        return (f"--bg:{c['bg']};--card:{c['card']};--fg:{c['fg']};--mut:{c['mut']};--line:{c['line']};"
                f"--acc:{c['acc']};--accbg:{c['acc']}{accbg};--on:{c['acc']}")
    return (f"/* Bảng màu \"{spec['title']}\" — chỉ đổi màu; cấu trúc ở industry.css */\n"
            f":root{{{block(p['light'], '1a')}}}\n"
            f"@media (prefers-color-scheme:dark){{:root{{{block(p['dark'], '22')}}}}}\n")


def write(path, text):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, 'w', encoding='utf-8', newline='\n') as f:
        f.write(text)


SWITCH_KEYS = {'pump', 'fan', 'mist', 'run', 'pump1_run', 'pump2_run', 'pump_a', 'pump_b', 'aerator', 'blower', 'zone1', 'zone2', 'lamp', 'pond', 'heater'}


def setup_json(spec):
    """Bản khai gateway: mỗi thiết bị mẫu → một thiết bị; field → widget theo kiểu chỉ số (trạng thái → led, bật/tắt điều khiển → switch, số có khoảng → gauge)."""
    bykey = {}
    for mt in spec['metrics']:
        for k in mt.get('keys') or [mt['id']]:
            bykey[(k[0] if isinstance(k, list) else k).lower()] = mt
    devices = []
    for did, dv in spec['demo']['devices'].items():
        fields = []
        for key in dv['f']:
            mt = bykey.get(key.lower(), {})
            f = {'key': key, 'lbl': mt.get('label', key)}
            if mt.get('unit'):
                f['unit'] = mt['unit']
            if key in SWITCH_KEYS:
                f.update({'widget': 'switch', 'writable': True, 'on': 'Đang chạy', 'off': 'Dừng'})
            elif mt.get('map'):
                f['widget'] = 'led'
            elif 'min' in mt and 'max' in mt:
                f.update({'widget': 'gauge', 'min': mt['min'], 'max': mt['max']})
            else:
                f['widget'] = 'kpi'
            fields.append(f)
        devices.append({'id': did, 'name': dv['title'], 'fields': fields[:32]})
    return {'gw': spec['id'].upper()[:12], 'devices': devices}



SHORT = {  # (tên ngắn ở thanh bên gateway, ký hiệu)
    'water': ('Cấp nước', '≈'), 'agri': ('Nhà kính', '❦'), 'coldchain': ('Kho lạnh', '❄'), 'hvac': ('Tòa nhà', '⌂'), 'factory': ('OEE', '⚙'),
    'energy': ('Điện 3 pha', '⚡'), 'ev': ('Sạc xe điện', '⏻'), 'aqua': ('Thủy sản', '≈'), 'tank': ('Bồn bể', '▮'), 'lighting': ('Chiếu sáng', '☼'),
    'env': ('Môi trường', '☁'), 'compressor': ('Khí nén', '⚙'), 'facility': ('Mặt bằng', '▦'), 'process': ('P&ID', '⇄'), 'schedule': ('Lịch', '◷'),
    'elevator': ('Thang máy', '⇅'), 'fleet': ('Đội xe', '➤'), 'workshop': ('Xưởng', '⚙'), 'andon': ('Andon', '◉'), 'boiler': ('Lò hơi', '♨'),
    'generator': ('Máy phát', '⚡'), 'bts': ('Trạm BTS', '⌁'), 'weather': ('Khí tượng', '☂'), 'wwtp': ('Nước thải', '≈'), 'dryer': ('Lò sấy', '♨'),
    'pumpstn': ('Trạm bơm', '≈'),
}


def ui_json(spec, runtime):
    """Giao diện của giải pháp dạng DỮ LIỆU cho gateway (server gửi trong kit): GatewayApp dùng chung một bản, chỉ nhận cấu hình này."""
    name, glyph = SHORT[spec['id']]
    d = spec['palette']['dark']
    return {'id': spec['id'], 'title': spec['title'], 'short': name, 'glyph': glyph, 'icon': spec.get('icon', 'chart'),   # glyph: gateway bản cũ; icon: mã icon vector (icons.json)
            'palette': {k: d[k] for k in ('bg', 'card', 'fg', 'mut', 'line', 'acc')}, 'spec': runtime}


# bộ icon dùng chung (icons.json + webapp/icons.js) → webapp/metric-icons.js + GatewayApp/Ui/IconData.g.cs + vector kiểm tra
metric_js = icons_gen.metric_icons_js()
write(os.path.join(repo, 'webapp', 'metric-icons.js'), metric_js)
write(os.path.join(repo, 'tools', 'GatewayApp', 'Ui', 'IconData.g.cs'), icons_gen.icon_data_cs())
write(os.path.join(here, 'icon-vectors.json'), json.dumps(icons_gen.vectors(ALL), ensure_ascii=False, indent=0) + '\n')

engine_js = open(os.path.join(here, 'expr.js'), encoding='utf-8').read() + '\n' + metric_js + open(os.path.join(here, 'industry.js'), encoding='utf-8').read()   # bộ tính công thức + icon + engine
engine_css = open(os.path.join(here, 'industry.css'), encoding='utf-8').read()
shell = os.path.join(root, '..', 'webapp')   # engine + CSS dùng chung cho mọi giải pháp: MỘT bản ở shell
write(os.path.join(shell, 'industry-engine.js'), engine_js)
write(os.path.join(shell, 'industry.css'), engine_css)
made = []
for spec in ALL:
    sid = spec['id']
    if only and sid not in only:
        continue
    d = os.path.join(root, sid)
    web = os.path.join(d, 'webapp')
    runtime = {k: v for k, v in spec.items() if k not in ('palette', 'themeColor', 'id')}
    runtime['id'] = sid
    req, why = REQ.get(sid, ([], ''))
    runtime['required'] = req
    runtime['why'] = why
    write(os.path.join(d, 'solution.json'), json.dumps({
        'kind': 'plciot-solution', 'id': sid, 'title': spec['title'], 'themeColor': spec['themeColor'], 'icon': spec.get('icon', 'chart'),   # kind = DẤU NHẬN DIỆN để admin tự đồng bộ vào ô chọn; icon = mã trong icons.json (admin, gateway)
        'inject': {'css': ['theme.css?v=1'], 'js': ['spec.js?v=1']},   # engine + industry.css dùng chung ở shell (webapp/industry-engine.js)
    }, ensure_ascii=False, indent=2) + '\n')
    write(os.path.join(web, 'spec.js'), '/* Cấu hình giao diện ngành (sinh bởi tools/solution-kit/gen.py từ specs.py) */\nwindow.INDUSTRY = '
          + json.dumps(runtime, ensure_ascii=False, indent=1) + ';\n')
    write(os.path.join(web, 'theme.css'), theme_css(spec))
    for old in ('IndustryPage.cs', 'IndustrySkin.cs'):   # bản cũ build riêng từng giải pháp: nay giao diện là dữ liệu
        if os.path.exists(os.path.join(d, 'gateway', old)):
            os.remove(os.path.join(d, 'gateway', old))
    write(os.path.join(d, 'gateway', 'ui.json'), json.dumps(ui_json(spec, runtime), ensure_ascii=False, indent=1) + '\n')
    write(os.path.join(d, 'gateway', 'solution.json'), json.dumps({'kind': 'plciot-solution', 'id': sid, 'title': spec['title']}, ensure_ascii=False, indent=2) + '\n')
    write(os.path.join(d, 'gateway', 'setup.json'), json.dumps(setup_json(spec), ensure_ascii=False, indent=2) + '\n')
    write(os.path.join(d, 'gateway', 'README.md'), f"# Gateway cho giải pháp \"{spec['title']}\"\n\n"
          f"`setup.json` là bản khai thiết bị + field mà giao diện cần (ghép cặp: gửi làm `config`).\n\n"
          f"Giao diện gateway là DỮ LIỆU: `ui.json` (bảng màu + khối hiển thị + công thức). Admin gán giải pháp cho gateway khi phát mã ghép cặp; server gửi `ui.json` trong kit lúc Enroll, GatewayApp (một bản dùng chung) lưu cache và áp dụng khi mở lại. Không cần build riêng.\n\n"
          f"**Field bắt buộc:** {', '.join(req) or '—'}\n\n{why}\n")
    made.append(sid)
print('generated:', ', '.join(made))
