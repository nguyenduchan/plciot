# -*- coding: utf-8 -*-
"""Giải pháp bổ sung: mặt bằng, P&ID, lịch, thang máy, đội xe + xưởng / nhà máy nhỏ / trạm độc lập."""
from specs import m, th, sin, RUN, FAULT, pal

SPECS = []
D2 = {'state': {'map': {'0': 'Dừng', '1': 'Chạy', '2': 'LỖI', '3': 'Chờ'}, 'lv': {'0': 'off', '1': 'ok', '2': 'bad', '3': 'warn'}, 'agg': 'max'}}
OPEN = {'map': {'0': 'Đóng', '1': 'Mở'}, 'lv': {'0': 'off', '1': 'ok'}, 'agg': 'max'}

# ============================================================ MẶT BẰNG NHÀ MÁY
ROOMS = [{'x': 2, 'y': 6, 'w': 42, 'h': 28, 'label': 'Xưởng A'}, {'x': 46, 'y': 6, 'w': 32, 'h': 28, 'label': 'Xưởng B'}, {'x': 80, 'y': 6, 'w': 18, 'h': 28, 'label': 'Kho'},
         {'x': 2, 'y': 37, 'w': 30, 'h': 21, 'label': 'Văn phòng'}, {'x': 34, 'y': 37, 'w': 24, 'h': 21, 'label': 'Phòng điện'}, {'x': 60, 'y': 37, 'w': 38, 'h': 21, 'label': 'Bãi / khu hóa chất'}]
POS = {'n1': (22, 20), 'n2': (62, 20), 'n3': (89, 20), 'n4': (16, 47), 'n5': (46, 47), 'n6': (80, 47)}
NAMES = {'n1': 'Xưởng A', 'n2': 'Xưởng B', 'n3': 'Kho', 'n4': 'Văn phòng', 'n5': 'Phòng điện', 'n6': 'Khu hóa chất'}
MARK = [{'dev': k, 'x': v[0], 'y': v[1], 'label': NAMES[k]} for k, v in POS.items()]
SPECS.append({
    'id': 'facility', 'title': 'Mặt bằng nhà máy', 'icon': 'map', 'style': 'glass', 'themeColor': '#0369a1',
    'palette': pal(['#e4eef6', '#ffffff', '#0c2236', '#506a80', '#c1d3e2', '#0369a1'], ['#07121c', '#0e2234', '#e2effa', '#8aa8c2', '#1c3a55', '#38bdf8']),
    'metrics': [
        m('temp', 'Nhiệt độ', '°C', ['temp_c', 'temp'], agg='max', dec=1, min=15, max=50, th=th(None, None, 33, 40)),
        m('hum', 'Độ ẩm', '%', ['hum_pct', 'hum'], agg='avg', dec=0),
        m('gas', 'Khí gas', 'ppm', ['gas_ppm', 'gas'], agg='max', dec=0, min=0, max=100, th=th(None, None, 25, 50)),
        m('smoke', 'Khói', '', ['smoke'], agg='max', map={'0': 'Bình thường', '1': 'CÓ KHÓI'}, lv={'0': 'ok', '1': 'bad'}),
        m('door', 'Cửa', '', ['door'], agg='max', map={'0': 'Đóng', '1': 'Mở'}, lv={'0': 'ok', '1': 'warn'}),
        m('power', 'Công suất', 'kW', ['kw'], agg='sum', dec=1),
    ],
    'overview': [
        {'type': 'alarms'},
        {'type': 'plan', 'title': 'Nhiệt độ theo vị trí', 'w': 100, 'h': 60, 'main': 'temp', 'rooms': ROOMS, 'markers': MARK},
        {'type': 'kpis', 'items': ['temp', 'hum', 'gas', 'power']},
        {'type': 'state', 'items': ['smoke', 'door']},
        {'type': 'trend', 'metric': 'temp', 'title': 'Nhiệt độ cao nhất'},
    ],
    'tabs': [
        {'id': 'gasmap', 'label': 'Khí gas', 'title': 'Bản đồ khí gas', 'icon': 'bell', 'blocks': [{'type': 'plan', 'w': 100, 'h': 60, 'main': 'gas', 'rooms': ROOMS, 'markers': MARK}, {'type': 'bars', 'items': ['gas']}]},
        {'id': 'zones', 'label': 'Khu vực', 'title': 'Các khu vực', 'icon': 'home', 'blocks': [{'type': 'tiles', 'main': 'temp', 'subs': ['hum', 'gas', 'door']}]},
    ],
    'demo': {'devices': {
        'n1': {'title': 'Xưởng A', 'f': {'temp_c': sin(31, 2.5, 200), 'hum_pct': sin(60, 5, 220), 'gas_ppm': sin(8, 4, 150), 'smoke': 0, 'door': {'sq': [0, 1], 'p': 90, 'duty': 0.2}, 'kw': sin(42, 6, 90)}, 'dec': {'hum_pct': 0, 'gas_ppm': 0}},
        'n2': {'title': 'Xưởng B', 'f': {'temp_c': sin(34, 3, 210, 20), 'hum_pct': sin(55, 5, 230), 'gas_ppm': sin(14, 6, 160), 'smoke': 0, 'door': 0, 'kw': sin(35, 5, 80)}, 'dec': {'hum_pct': 0, 'gas_ppm': 0}},
        'n3': {'title': 'Kho', 'f': {'temp_c': sin(29, 1.2, 250), 'hum_pct': sin(68, 4, 240), 'gas_ppm': sin(4, 2, 170), 'smoke': 0, 'door': {'sq': [0, 1], 'p': 120, 'duty': 0.15}, 'kw': sin(4, 1, 100)}, 'dec': {'hum_pct': 0, 'gas_ppm': 0}},
        'n4': {'title': 'Văn phòng', 'f': {'temp_c': sin(25, 0.6, 260), 'hum_pct': sin(52, 3, 250), 'gas_ppm': sin(2, 1, 180), 'smoke': 0, 'door': 0, 'kw': sin(8, 1, 100)}, 'dec': {'hum_pct': 0, 'gas_ppm': 0}},
        'n5': {'title': 'Phòng điện', 'f': {'temp_c': sin(36, 3, 190, 30), 'hum_pct': sin(45, 3, 210), 'gas_ppm': sin(3, 1, 160), 'smoke': 0, 'door': 0, 'kw': sin(6, 1, 100)}, 'dec': {'hum_pct': 0, 'gas_ppm': 0}},
        'n6': {'title': 'Khu hóa chất', 'f': {'temp_c': sin(32, 2, 220), 'hum_pct': sin(63, 4, 230), 'gas_ppm': sin(27, 8, 140, 50), 'smoke': 0, 'door': {'sq': [0, 1], 'p': 150, 'duty': 0.25}, 'kw': sin(2, 0.5, 100)}, 'dec': {'hum_pct': 0, 'gas_ppm': 0}},
    }},
})

# ============================================================ P&ID: QUY TRÌNH PHA CHẾ
SPECS.append({
    'id': 'process', 'title': 'Quy trình pha chế (P&ID)', 'icon': 'pipe', 'style': 'sharp', 'themeColor': '#0f766e',
    'palette': pal(['#e3f1ee', '#ffffff', '#0c2c28', '#4d6e69', '#bfd9d4', '#0f766e'], ['#071a18', '#0d2a27', '#e0f5f1', '#88b3ac', '#1b4640', '#2dd4bf']),
    'metrics': [
        m('la', 'Bồn A', '%', ['lvl_a'], agg='avg', dec=0, min=0, max=100, th=th(15, 8)), m('lb', 'Bồn B', '%', ['lvl_b'], agg='avg', dec=0, min=0, max=100, th=th(15, 8)),
        m('lc', 'Bồn thành phẩm', '%', ['lvl_c'], agg='avg', dec=0, min=0, max=100, th=th(None, None, 90, 97)),
        m('temp', 'Nhiệt độ bình', '°C', ['temp_c'], agg='avg', dec=0, min=0, max=120, th=th(None, None, 85, 95)),
        m('press', 'Áp suất', 'bar', ['press_bar'], agg='avg', dec=1, min=0, max=6, th=th(None, None, 4, 5)),
        m('flow', 'Lưu lượng', 'L/ph', ['flow_lpm'], agg='sum', dec=0),
        m('p1', 'Bơm A', '', ['pump_a'], **RUN), m('p2', 'Bơm B', '', ['pump_b'], **RUN),
        m('v1', 'Van A', '', ['valve_a'], **OPEN), m('v2', 'Van B', '', ['valve_b'], **OPEN), m('v3', 'Van xả', '', ['valve_out'], **OPEN),
        m('batch', 'Mẻ hôm nay', 'mẻ', ['batch'], agg='max', dec=0),
    ],
    'overview': [
        {'type': 'pid', 'w': 130, 'h': 70,
         'pipes': [{'pts': [[23, 17], [69, 17], [69, 30]], 'on': 'p1', 'color': 'var(--acc)'}, {'pts': [[23, 52], [69, 52], [69, 44]], 'on': 'p2', 'color': 'var(--warn)'}, {'pts': [[91, 37], [111, 37]], 'on': 'v3', 'color': 'var(--ok)'}],
         'nodes': [{'kind': 'tank', 'x': 14, 'y': 4, 'w': 18, 'h': 26, 'metric': 'la', 'label': 'Bồn A'}, {'kind': 'tank', 'x': 14, 'y': 38, 'w': 18, 'h': 26, 'metric': 'lb', 'label': 'Bồn B'},
                   {'kind': 'pump', 'x': 38, 'y': 17, 'metric': 'p1', 'label': 'Bơm A'}, {'kind': 'pump', 'x': 38, 'y': 52, 'metric': 'p2', 'label': 'Bơm B'},
                   {'kind': 'valve', 'x': 54, 'y': 17, 'metric': 'v1', 'label': 'Van A'}, {'kind': 'valve', 'x': 54, 'y': 52, 'metric': 'v2', 'label': 'Van B'},
                   {'kind': 'vessel', 'x': 80, 'y': 26, 'w': 22, 'h': 22, 'metric': 'temp', 'label': 'Bình trộn'}, {'kind': 'valve', 'x': 100, 'y': 37, 'metric': 'v3', 'label': 'Van xả'},
                   {'kind': 'tank', 'x': 119, 'y': 22, 'w': 16, 'h': 30, 'metric': 'lc', 'label': 'Thành phẩm'}, {'kind': 'sensor', 'x': 80, 'y': 8, 'metric': 'press', 'label': 'Áp suất'}]},
        {'type': 'kpis', 'items': ['temp', 'press', 'flow', 'batch']},
        {'type': 'state', 'items': ['p1', 'p2', 'v1', 'v2', 'v3']},
        {'type': 'alarms'},
    ],
    'tabs': [{'id': 'trend', 'label': 'Xu hướng', 'title': 'Xu hướng quy trình', 'icon': 'chart', 'blocks': [{'type': 'trend', 'metric': 'temp', 'title': 'Nhiệt độ bình'}, {'type': 'trend', 'metric': 'press', 'title': 'Áp suất'}, {'type': 'trend', 'metric': 'lc', 'title': 'Mức thành phẩm'}]}],
    'demo': {'devices': {'pl1': {'title': 'Dây chuyền pha chế', 'dec': {'lvl_a': 0, 'lvl_b': 0, 'lvl_c': 0, 'temp_c': 0, 'press_bar': 1, 'flow_lpm': 0, 'batch': 0}, 'f': {
        'lvl_a': sin(62, 18, 240), 'lvl_b': sin(48, 20, 280, 40), 'lvl_c': sin(52, 28, 300, 100), 'temp_c': sin(68, 12, 180), 'press_bar': sin(2.4, 0.6, 90), 'flow_lpm': sin(95, 30, 100),
        'pump_a': {'sq': [0, 1], 'p': 160, 'duty': 0.75}, 'pump_b': {'sq': [0, 1], 'p': 200, 'duty': 0.55, 'ph': 40}, 'valve_a': {'sq': [0, 1], 'p': 160, 'duty': 0.8}, 'valve_b': {'sq': [0, 1], 'p': 200, 'duty': 0.6, 'ph': 30}, 'valve_out': {'sq': [0, 1], 'p': 240, 'duty': 0.5, 'ph': 20}, 'batch': {'cnt': 0.004, 'start': 12}}}}},
})

# ============================================================ LỊCH VẬN HÀNH
SPECS.append({
    'id': 'schedule', 'title': 'Lịch vận hành thiết bị', 'icon': 'calendar', 'style': 'soft', 'themeColor': '#7c3aed',
    'palette': pal(['#eee8fb', '#ffffff', '#241448', '#665a8c', '#d4cbef', '#7c3aed'], ['#120a26', '#201442', '#eee8ff', '#aa9dd6', '#392a68', '#a78bfa']),
    'metrics': [m('z1', 'Tưới vùng 1', '', ['zone1'], **RUN), m('z2', 'Tưới vùng 2', '', ['zone2'], **RUN), m('lamp', 'Đèn sân', '', ['lamp'], **RUN), m('pond', 'Bơm hồ', '', ['pond'], **RUN),
                m('water', 'Nước hôm nay', 'L', ['water_l'], agg='sum', dec=0), m('kw', 'Công suất', 'kW', ['kw'], agg='sum', dec=1), m('kwh', 'Điện hôm nay', 'kWh', ['kwh'], agg='sum', dec=1)],
    'overview': [
        {'type': 'schedule', 'title': 'Lịch trong tuần (theo cài đặt)', 'rows': [
            {'label': 'Tưới vùng 1', 'on': '05:30', 'off': '06:15'}, {'label': 'Tưới vùng 2', 'on': '17:00', 'off': '17:45', 'days': [1, 3, 5]},
            {'label': 'Đèn sân', 'on': '18:00', 'off': '23:00'}, {'label': 'Bơm hồ cá', 'on': '08:00', 'off': '10:00', 'days': [6, 7]}]},
        {'type': 'state', 'title': 'Trạng thái thực tế từ thiết bị', 'items': ['z1', 'z2', 'lamp', 'pond']},
        {'type': 'kpis', 'items': ['water', 'kwh', 'kw']},
    ],
    'tabs': [{'id': 'usage', 'label': 'Tiêu thụ', 'title': 'Nước & điện', 'icon': 'chart', 'blocks': [{'type': 'kpis', 'items': ['water', 'kwh']}, {'type': 'trend', 'metric': 'kw', 'title': 'Công suất'}]}],
    'demo': {'devices': {'s1': {'title': 'Bộ điều khiển sân vườn', 'f': {'zone1': {'sq': [0, 1], 'p': 200, 'duty': 0.4}, 'zone2': {'sq': [0, 1], 'p': 260, 'duty': 0.3, 'ph': 60}, 'lamp': {'sq': [0, 1], 'p': 300, 'duty': 0.6}, 'pond': {'sq': [0, 1], 'p': 150, 'duty': 0.5},
                                                                  'water_l': {'cnt': 0.8, 'start': 240}, 'kw': sin(1.8, 0.6, 120), 'kwh': {'cnt': 0.001, 'start': 6.2}}, 'dec': {}}}},
})

# ============================================================ THANG MÁY
SPECS.append({
    'id': 'elevator', 'title': 'Thang máy & tòa nhà', 'icon': 'elevator', 'style': 'dense', 'themeColor': '#475569',
    'palette': pal(['#e8ebf0', '#ffffff', '#171e29', '#5c6676', '#cbd2dc', '#475569'], ['#0c1017', '#171e29', '#e6ebf2', '#9aa6b8', '#2b3648', '#fbbf24']),
    'metrics': [m('floor', 'Tầng', '', ['floor'], agg='avg', dec=0), m('door', 'Cửa', '', ['door'], agg='max', map={'0': 'Đóng', '1': 'Mở'}, lv={'0': 'ok', '1': 'warn'}),
                m('load', 'Tải', '%', ['load'], agg='avg', dec=0, min=0, max=100, th=th(None, None, 85, 100)), m('trips', 'Chuyến hôm nay', '', ['trips'], agg='sum', dec=0),
                m('fault', 'Sự cố', '', ['fault'], **FAULT), m('kw', 'Công suất', 'kW', ['kw'], agg='sum', dec=1)],
    'overview': [
        {'type': 'elevator', 'floors': 12, 'floor': 'floor', 'door': 'door', 'load': 'load', 'fault': 'fault'},
        {'type': 'kpis', 'items': ['trips', 'load', 'kw', 'fault']},
        {'type': 'alarms'},
    ],
    'tabs': [{'id': 'usage', 'label': 'Vận hành', 'title': 'Vận hành thang máy', 'icon': 'chart', 'blocks': [{'type': 'tiles', 'main': 'trips', 'subs': ['load', 'kw', 'door']}, {'type': 'trend', 'metric': 'load', 'title': 'Tải trung bình'}]}],
    'demo': {'devices': {
        'l1': {'title': 'Thang 1', 'dec': {'floor': 2, 'load': 0, 'kw': 1}, 'f': {'floor': {'sin': [6.5, 5.5, 70]}, 'door': {'sq': [0, 1], 'p': 35, 'duty': 0.88, 'ph': 5}, 'load': sin(42, 30, 110), 'trips': {'cnt': 0.02, 'start': 310}, 'fault': 0, 'kw': sin(3.4, 1.2, 40)}},
        'l2': {'title': 'Thang 2', 'dec': {'floor': 2, 'load': 0, 'kw': 1}, 'f': {'floor': {'sin': [6.5, 5.5, 95, 30]}, 'door': {'sq': [0, 1], 'p': 47, 'duty': 0.85}, 'load': sin(35, 25, 130), 'trips': {'cnt': 0.015, 'start': 270}, 'fault': 0, 'kw': sin(3, 1.1, 50)}},
        'l3': {'title': 'Thang chở hàng', 'dec': {'floor': 2, 'load': 0, 'kw': 1}, 'f': {'floor': {'sin': [4, 3, 120, 10]}, 'door': {'sq': [0, 1], 'p': 60, 'duty': 0.9}, 'load': sin(60, 28, 150), 'trips': {'cnt': 0.008, 'start': 96}, 'fault': {'sq': [1, 0], 'p': 500, 'duty': 0.97}, 'kw': sin(5, 1.5, 60)}},
    }},
})

# ============================================================ ĐỘI XE GPS
CAR = {'dec': {'speed': 0, 'fuel': 0, 'odo': 1, 'temp': 0, 'lat': 5, 'lon': 5}}
SPECS.append({
    'id': 'fleet', 'title': 'Quản lý đội xe GPS', 'icon': 'truck', 'style': 'glass', 'themeColor': '#0e7490',
    'palette': pal(['#e1f1f5', '#ffffff', '#082a35', '#4a6c78', '#bcd9e2', '#0e7490'], ['#051920', '#0b2a35', '#def2f8', '#85b2c0', '#18485a', '#22d3ee']),
    'metrics': [
        m('speed', 'Tốc độ', 'km/h', ['speed'], agg='max', dec=0, min=0, max=120, th=th(None, None, 80, 100)),
        m('state', 'Trạng thái', '', ['state'], agg='max', map={'0': 'Đỗ', '1': 'Đang chạy', '2': 'Quá tốc độ', '3': 'Cảnh báo'}, lv={'0': 'off', '1': 'ok', '2': 'warn', '3': 'bad'}),
        m('fuel', 'Nhiên liệu', '%', ['fuel'], agg='avg', dec=0, min=0, max=100, th=th(20, 10)), m('odo', 'Quãng đường', 'km', ['odo'], agg='sum', dec=0),
        m('temp', 'Nhiệt độ động cơ', '°C', ['temp'], agg='max', dec=0, th=th(None, None, 100, 110)), m('moving', 'Xe đang chạy', 'xe', ['state'], agg='count', dec=0),
    ],
    'overview': [
        {'type': 'map', 'title': 'Vị trí xe', 'lat': 'lat', 'lon': 'lon', 'state': 'state', 'speed': 'speed'},
        {'type': 'kpis', 'items': ['moving', 'speed', 'odo', 'fuel']},
        {'type': 'tiles', 'title': 'Từng xe', 'main': 'speed', 'subs': ['fuel', 'odo', 'state']},
        {'type': 'alarms'},
    ],
    'tabs': [{'id': 'trips', 'label': 'Hành trình', 'title': 'Hành trình & nhiên liệu', 'icon': 'truck', 'blocks': [{'type': 'bars', 'items': ['fuel', 'speed']}, {'type': 'trend', 'metric': 'speed', 'title': 'Tốc độ cao nhất'}]}],
    'demo': {'devices': {
        'v1': {'title': 'Xe tải 51C-123', **CAR, 'f': {'lat': {'sin': [10.78, 0.010, 420]}, 'lon': {'sin': [106.70, 0.016, 420, 105]}, 'speed': sin(42, 14, 70), 'state': 1, 'fuel': sin(64, 6, 600), 'odo': {'cnt': 0.011, 'start': 48210}, 'temp': sin(88, 5, 120)}},
        'v2': {'title': 'Xe tải 51D-456', **CAR, 'f': {'lat': {'sin': [10.76, 0.012, 360, 60]}, 'lon': {'sin': [106.66, 0.014, 360, 150]}, 'speed': sin(58, 22, 60), 'state': {'sq': [2, 1], 'p': 300, 'duty': 0.8}, 'fuel': sin(41, 6, 600), 'odo': {'cnt': 0.015, 'start': 71005}, 'temp': sin(94, 6, 110)}},
        'v3': {'title': 'Xe bán tải 60A-789', **CAR, 'f': {'lat': 10.7725, 'lon': 106.6985, 'speed': 0, 'state': 0, 'fuel': 77, 'odo': 22800, 'temp': 38}},
        'v4': {'title': 'Xe giao hàng 59B-321', **CAR, 'f': {'lat': {'sin': [10.795, 0.008, 300, 20]}, 'lon': {'sin': [106.72, 0.012, 300, 95]}, 'speed': sin(35, 12, 50), 'state': {'sq': [3, 1], 'p': 360, 'duty': 0.93}, 'fuel': sin(17, 3, 500), 'odo': {'cnt': 0.01, 'start': 15320}, 'temp': sin(86, 5, 120)}},
    }},
})

# ============================================================ XƯỞNG CƠ KHÍ
SPECS.append({
    'id': 'workshop', 'title': 'Xưởng gia công cơ khí', 'icon': 'gear', 'style': 'sharp', 'themeColor': '#b45309',
    'palette': pal(['#f6ebdd', '#ffffff', '#2c1a08', '#76603f', '#e3d0b3', '#b45309'], ['#16100a', '#241a0e', '#fcefd9', '#c2a97f', '#443219', '#f59e0b']),
    'metrics': [
        m('state', 'Trạng thái máy', '', ['state'], agg='max', map={'0': 'Dừng', '1': 'Đang gia công', '2': 'LỖI', '3': 'Chờ vật liệu'}, lv={'0': 'off', '1': 'ok', '2': 'bad', '3': 'warn'}),
        m('parts', 'Chi tiết hôm nay', 'cái', ['parts'], agg='sum', dec=0), m('plan', 'Kế hoạch ca', 'cái', ['plan'], agg='sum', dec=0),
        m('cycle', 'Chu kỳ', 's', ['cycle_s'], agg='avg', dec=0), m('spindle', 'Tốc độ trục', 'rpm', ['rpm'], agg='avg', dec=0, min=0, max=6000),
        m('temp', 'Nhiệt độ trục', '°C', ['temp_c'], agg='max', dec=0, th=th(None, None, 65, 80)), m('kw', 'Công suất', 'kW', ['kw'], agg='sum', dec=1),
        m('run_h', 'Giờ chạy hôm nay', 'h', ['run_h'], agg='sum', dec=1),
    ],
    'overview': [
        {'type': 'progress', 'title': 'Kế hoạch ca', 'items': [{'actual': 'parts', 'target': 'plan', 'label': 'Sản lượng ca'}]},
        {'type': 'tiles', 'title': 'Các máy', 'main': 'state', 'subs': ['parts', 'spindle', 'temp']},
        {'type': 'kpis', 'items': ['parts', 'cycle', 'kw', 'run_h']},
        {'type': 'alarms'},
        {'type': 'trend', 'metric': 'kw', 'title': 'Công suất xưởng'},
    ],
    'tabs': [{'id': 'andon', 'label': 'Andon', 'title': 'Bảng trạng thái máy', 'icon': 'bell', 'blocks': [{'type': 'andon', 'state': 'state', 'value': 'parts'}]}],
    'demo': {'devices': {
        'cnc1': {'title': 'CNC 1', 'dec': {'rpm': 0, 'parts': 0}, 'f': {'state': 1, 'parts': {'cnt': 0.02, 'start': 188}, 'plan': 400, 'cycle_s': sin(48, 4, 90), 'rpm': sin(3800, 400, 60), 'temp_c': sin(54, 5, 150), 'kw': sin(11, 2, 60), 'run_h': {'cnt': 0.0002, 'start': 5.1}}},
        'cnc2': {'title': 'CNC 2', 'dec': {'rpm': 0, 'parts': 0}, 'f': {'state': {'sq': [3, 1], 'p': 240, 'duty': 0.8}, 'parts': {'cnt': 0.015, 'start': 150}, 'plan': 400, 'cycle_s': sin(55, 5, 100), 'rpm': sin(3600, 350, 70), 'temp_c': sin(58, 6, 160), 'kw': sin(10, 2, 70), 'run_h': {'cnt': 0.00018, 'start': 4.4}}},
        'press1': {'title': 'Máy ép 1', 'dec': {'rpm': 0, 'parts': 0}, 'f': {'state': {'sq': [2, 1], 'p': 360, 'duty': 0.92}, 'parts': {'cnt': 0.05, 'start': 520}, 'plan': 900, 'cycle_s': sin(12, 1, 80), 'rpm': 0, 'temp_c': sin(66, 6, 130), 'kw': sin(18, 4, 50), 'run_h': {'cnt': 0.0002, 'start': 5.5}}},
        'saw1': {'title': 'Máy cưa', 'dec': {'rpm': 0, 'parts': 0}, 'f': {'state': {'sq': [0, 1], 'p': 300, 'duty': 0.6}, 'parts': {'cnt': 0.03, 'start': 260}, 'plan': 500, 'cycle_s': sin(30, 3, 90), 'rpm': sin(2800, 200, 80), 'temp_c': sin(44, 4, 140), 'kw': sin(6, 1, 60), 'run_h': {'cnt': 0.00015, 'start': 3.9}}},
    }},
})

# ============================================================ BẢNG ANDON
SPECS.append({
    'id': 'andon', 'title': 'Bảng Andon sản xuất', 'icon': 'bell', 'style': 'sharp', 'themeColor': '#16a34a',
    'palette': pal(['#e6efe6', '#ffffff', '#102014', '#506a54', '#c3d6c5', '#15803d'], ['#050b07', '#0f1d13', '#e8f6ea', '#8fb394', '#1f3a25', '#4ade80']),
    'metrics': [
        m('state', 'Trạng thái', '', ['state'], agg='max', map={'0': 'DỪNG', '1': 'ĐANG CHẠY', '2': 'LỖI', '3': 'CHỜ'}, lv={'0': 'off', '1': 'ok', '2': 'bad', '3': 'warn'}),
        m('count', 'Sản lượng', 'sp', ['count'], agg='sum', dec=0), m('plan', 'Kế hoạch', 'sp', ['plan'], agg='sum', dec=0), m('good', 'Đạt', 'sp', ['good'], agg='sum', dec=0),
        m('takt', 'Takt time', 's', ['takt'], agg='avg', dec=0), m('attain', 'Đạt kế hoạch', '%', expr='count / plan * 100', dec=0, th=th(60, 40)), m('down', 'Dừng lâu nhất', 'phút', ['down_min'], agg='max', dec=0, th=th(None, None, 30, 60)),
    ],
    'overview': [
        {'type': 'andon', 'state': 'state', 'value': 'count'},
        {'type': 'progress', 'title': 'Kế hoạch ca', 'items': [{'actual': 'count', 'target': 'plan', 'label': 'Sản lượng toàn xưởng'}, {'actual': 'good', 'target': 'count', 'label': 'Tỷ lệ đạt'}]},
        {'type': 'kpis', 'items': ['count', 'good', 'attain', 'down']},
        {'type': 'alarms'},
    ],
    'tabs': [{'id': 'lines', 'label': 'Chuyền', 'title': 'Từng chuyền', 'icon': 'factory', 'blocks': [{'type': 'tiles', 'main': 'count', 'subs': ['takt', 'down', 'state']}, {'type': 'trend', 'metric': 'count', 'title': 'Sản lượng'}]}],
    'demo': {'devices': {
        'L1': {'title': 'Chuyền 1', 'dec': {}, 'f': {'state': 1, 'count': {'cnt': 0.4, 'start': 612}, 'plan': 900, 'good': {'cnt': 0.39, 'start': 600}, 'takt': sin(32, 2, 90), 'down_min': 8}},
        'L2': {'title': 'Chuyền 2', 'dec': {}, 'f': {'state': {'sq': [3, 1], 'p': 280, 'duty': 0.8}, 'count': {'cnt': 0.35, 'start': 540}, 'plan': 900, 'good': {'cnt': 0.34, 'start': 520}, 'takt': sin(36, 3, 100), 'down_min': 22}},
        'L3': {'title': 'Chuyền 3', 'dec': {}, 'f': {'state': {'sq': [2, 1], 'p': 320, 'duty': 0.88}, 'count': {'cnt': 0.3, 'start': 470}, 'plan': 800, 'good': {'cnt': 0.285, 'start': 440}, 'takt': sin(40, 3, 110), 'down_min': 36}},
        'L4': {'title': 'Chuyền 4', 'dec': {}, 'f': {'state': 1, 'count': {'cnt': 0.42, 'start': 690}, 'plan': 900, 'good': {'cnt': 0.41, 'start': 680}, 'takt': sin(30, 2, 80), 'down_min': 5}},
        'L5': {'title': 'Đóng gói', 'dec': {}, 'f': {'state': {'sq': [0, 1], 'p': 400, 'duty': 0.9}, 'count': {'cnt': 0.8, 'start': 1220}, 'plan': 1800, 'good': {'cnt': 0.79, 'start': 1200}, 'takt': sin(18, 1, 80), 'down_min': 12}},
        'L6': {'title': 'Kiểm tra', 'dec': {}, 'f': {'state': 1, 'count': {'cnt': 0.78, 'start': 1190}, 'plan': 1800, 'good': {'cnt': 0.74, 'start': 1130}, 'takt': sin(19, 1, 80), 'down_min': 9}},
    }},
})

# ============================================================ LÒ HƠI
SPECS.append({
    'id': 'boiler', 'title': 'Lò hơi công nghiệp', 'icon': 'pipe', 'style': 'sharp', 'themeColor': '#b91c1c',
    'palette': pal(['#f6e4e2', '#ffffff', '#2d0f0c', '#795551', '#e5c6c3', '#b91c1c'], ['#170a09', '#2a1210', '#fde8e6', '#c8a09b', '#472320', '#fb7185']),
    'metrics': [
        m('wl', 'Mức nước', '%', ['water_lvl'], agg='avg', dec=0, min=0, max=100, th=th(35, 25, 85, 92)),
        m('press', 'Áp suất hơi', 'bar', ['press_bar'], agg='avg', dec=1, min=0, max=12, th=th(None, None, 9, 10.5)),
        m('temp', 'Nhiệt độ hơi', '°C', ['temp_c'], agg='avg', dec=0, min=0, max=250, th=th(None, None, 185, 200)),
        m('flame', 'Ngọn lửa', '', ['flame'], agg='max', map={'0': 'Tắt', '1': 'Cháy'}, lv={'0': 'off', '1': 'ok'}),
        m('pump', 'Bơm cấp nước', '', ['pump'], **RUN), m('feedv', 'Van cấp', '', ['feed_v'], **OPEN), m('steamv', 'Van hơi', '', ['steam_v'], **OPEN),
        m('fuel', 'Nhiên liệu', '%', ['fuel'], agg='avg', dec=0, min=0, max=100, th=th(20, 10)), m('steam', 'Sản lượng hơi', 'kg/h', ['steam_kgh'], agg='sum', dec=0),
        m('eff', 'Hiệu suất', '%', ['eff'], agg='avg', dec=1),
    ],
    'overview': [
        {'type': 'pid', 'w': 130, 'h': 70,
         'pipes': [{'pts': [[23, 24], [66, 24]], 'on': 'pump', 'color': 'var(--acc)'}, {'pts': [[93, 30], [128, 30]], 'on': 'steamv', 'color': 'var(--warn)'}],
         'nodes': [{'kind': 'tank', 'x': 14, 'y': 10, 'w': 18, 'h': 28, 'metric': 'wl', 'label': 'Bồn nước cấp'}, {'kind': 'pump', 'x': 38, 'y': 24, 'metric': 'pump', 'label': 'Bơm cấp'},
                   {'kind': 'valve', 'x': 52, 'y': 24, 'metric': 'feedv', 'label': 'Van cấp'}, {'kind': 'vessel', 'x': 80, 'y': 12, 'w': 26, 'h': 36, 'metric': 'press', 'label': 'Nồi hơi'},
                   {'kind': 'valve', 'x': 108, 'y': 30, 'metric': 'steamv', 'label': 'Van hơi'}, {'kind': 'sensor', 'x': 80, 'y': 58, 'metric': 'temp', 'label': 'Nhiệt độ hơi'}, {'kind': 'sensor', 'x': 50, 'y': 58, 'metric': 'flame', 'label': 'Lửa'}]},
        {'type': 'kpis', 'items': ['press', 'temp', 'steam', 'eff']},
        {'type': 'state', 'items': ['flame', 'pump', 'feedv', 'steamv']},
        {'type': 'alarms'},
        {'type': 'trend', 'metric': 'press', 'title': 'Áp suất hơi'},
    ],
    'tabs': [{'id': 'safe', 'label': 'An toàn', 'title': 'An toàn lò hơi', 'icon': 'bell', 'blocks': [{'type': 'gauges', 'items': ['press', 'wl', 'temp']}, {'type': 'bars', 'items': ['wl', 'press', 'fuel']}, {'type': 'alarms'}]}],
    'demo': {'devices': {'b1': {'title': 'Lò hơi 1', 'dec': {'water_lvl': 0, 'press_bar': 1, 'temp_c': 0, 'fuel': 0, 'steam_kgh': 0, 'eff': 1}, 'f': {
        'water_lvl': sin(60, 14, 200), 'press_bar': sin(7.8, 1.3, 120), 'temp_c': sin(172, 12, 140), 'flame': {'sq': [0, 1], 'p': 180, 'duty': 0.8}, 'pump': {'sq': [0, 1], 'p': 200, 'duty': 0.6},
        'feed_v': {'sq': [0, 1], 'p': 200, 'duty': 0.65}, 'steam_v': 1, 'fuel': sin(58, 10, 500), 'steam_kgh': sin(1800, 300, 100), 'eff': sin(86, 1.5, 150)}}}},
})

# ============================================================ MÁY PHÁT ĐIỆN / ATS
SPECS.append({
    'id': 'generator', 'title': 'Máy phát điện & ATS', 'icon': 'bolt', 'style': 'dense', 'themeColor': '#ca8a04',
    'palette': pal(['#f5efd9', '#fffdf3', '#2a2208', '#6e6232', '#e1d6a3', '#a16207'], ['#14100a', '#221b0c', '#fbf1cf', '#c2b178', '#403714', '#fbbf24']),
    'metrics': [
        m('src', 'Nguồn đang cấp', '', ['source'], agg='max', map={'0': 'Điện lưới', '1': 'MÁY PHÁT', '2': 'MẤT ĐIỆN'}, lv={'0': 'ok', '1': 'warn', '2': 'bad'}),
        m('run', 'Máy phát', '', ['run'], **RUN), m('rpm', 'Vòng quay', 'rpm', ['rpm'], agg='avg', dec=0, min=0, max=2000, th=th(None, None, 1560, 1650)),
        m('volt', 'Điện áp', 'V', ['volt'], agg='avg', dec=0, min=0, max=480, th=th(360, 340, 420, 440)), m('hz', 'Tần số', 'Hz', ['hz'], agg='avg', dec=1, min=45, max=55, th=th(48.5, 47, 51.5, 53)),
        m('kw', 'Công suất', 'kW', ['kw'], agg='sum', dec=0), m('load', 'Tải', '%', ['load_pct'], agg='avg', dec=0, min=0, max=100, th=th(None, None, 85, 100)),
        m('fuel', 'Nhiên liệu', '%', ['fuel'], agg='avg', dec=0, min=0, max=100, th=th(25, 12)), m('oil', 'Áp dầu', 'bar', ['oil_bar'], agg='avg', dec=1, min=0, max=8, th=th(2, 1.2)),
        m('cool', 'Nhiệt độ nước làm mát', '°C', ['coolant'], agg='max', dec=0, min=20, max=120, th=th(None, None, 92, 100)), m('hours', 'Giờ chạy', 'h', ['hours'], agg='max', dec=0),
        m('batt', 'Ắc quy khởi động', 'V', ['batt_v'], agg='avg', dec=1, th=th(11.5, 10.5)),
    ],
    'overview': [
        {'type': 'state', 'title': 'Nguồn điện', 'items': ['src', 'run']},
        {'type': 'gauges', 'items': ['load', 'fuel', 'cool']},
        {'type': 'kpis', 'items': ['kw', 'volt', 'hz', 'rpm']},
        {'type': 'alarms'},
        {'type': 'trend', 'metric': 'kw', 'title': 'Công suất phát'},
    ],
    'tabs': [{'id': 'maint', 'label': 'Bảo dưỡng', 'title': 'Bảo dưỡng & thông số động cơ', 'icon': 'gear', 'blocks': [{'type': 'kpis', 'items': ['hours', 'batt']}, {'type': 'bars', 'items': ['oil', 'cool', 'fuel']}, {'type': 'trend', 'metric': 'cool', 'title': 'Nhiệt độ làm mát'}]}],
    'demo': {'devices': {'g1': {'title': 'Máy phát 500kVA', 'dec': {'rpm': 0, 'volt': 0, 'hz': 1, 'kw': 0, 'load_pct': 0, 'fuel': 0, 'oil_bar': 1, 'coolant': 0, 'hours': 0, 'batt_v': 1}, 'f': {
        'source': {'sq': [1, 0], 'p': 400, 'duty': 0.75}, 'run': {'sq': [1, 0], 'p': 400, 'duty': 0.75}, 'rpm': sin(1500, 12, 40), 'volt': sin(398, 4, 60), 'hz': sin(50, 0.2, 50), 'kw': sin(260, 40, 100), 'load_pct': sin(62, 12, 110),
        'fuel': sin(54, 4, 600), 'oil_bar': sin(4.2, 0.2, 90), 'coolant': sin(82, 5, 140), 'hours': {'cnt': 0.0003, 'start': 2412}, 'batt_v': sin(13.1, 0.2, 100)}}}},
})

# ============================================================ TRẠM VIỄN THÔNG / BTS ĐỘC LẬP
SPECS.append({
    'id': 'bts', 'title': 'Trạm viễn thông độc lập', 'icon': 'cloud', 'style': 'glass', 'themeColor': '#1d4ed8',
    'palette': pal(['#e5ecfa', '#ffffff', '#0e1d44', '#52628c', '#c3d0ee', '#1d4ed8'], ['#070f24', '#0e1b3d', '#e4ebff', '#8ea0d0', '#1d3266', '#60a5fa']),
    'metrics': [
        m('mains', 'Điện lưới', '', ['mains'], agg='min', map={'0': 'MẤT LƯỚI', '1': 'Có lưới'}, lv={'0': 'bad', '1': 'ok'}), m('gen', 'Máy phát', '', ['gen'], **RUN),
        m('batt', 'Pin dự phòng', '%', ['batt_pct'], agg='min', dec=0, min=0, max=100, th=th(40, 20)), m('battv', 'Điện áp DC', 'V', ['batt_v'], agg='avg', dec=1, min=40, max=58, th=th(47, 45)),
        m('hrs', 'Dự phòng còn', 'giờ', ['backup_h'], agg='min', dec=1, th=th(3, 1.5)), m('temp', 'Nhiệt độ tủ', '°C', ['temp_c'], agg='max', dec=0, min=15, max=60, th=th(None, None, 35, 45)),
        m('door', 'Cửa tủ', '', ['door'], agg='max', map={'0': 'Đóng', '1': 'MỞ'}, lv={'0': 'ok', '1': 'warn'}), m('load', 'Tải DC', 'A', ['load_a'], agg='sum', dec=0),
        m('rssi', 'Sóng 4G', 'dBm', ['rssi'], agg='min', dec=0, th=th(-100, -108)),
    ],
    'overview': [
        {'type': 'alarms'},
        {'type': 'map', 'title': 'Vị trí các trạm', 'lat': 'lat', 'lon': 'lon', 'state': 'mains'},
        {'type': 'tiles', 'title': 'Các trạm', 'main': 'batt', 'subs': ['mains', 'temp', 'door']},
        {'type': 'kpis', 'items': ['battv', 'hrs', 'load', 'temp']},
        {'type': 'state', 'items': ['mains', 'gen', 'door']},
    ],
    'tabs': [{'id': 'power', 'label': 'Nguồn điện', 'title': 'Nguồn điện & ắc quy', 'icon': 'bolt', 'blocks': [{'type': 'gauges', 'items': ['batt', 'battv']}, {'type': 'trend', 'metric': 'battv', 'title': 'Điện áp DC'}, {'type': 'bars', 'items': ['hrs', 'rssi']}]}],
    'demo': {'devices': {
        't1': {'title': 'Trạm Củ Chi', 'dec': {'batt_pct': 0, 'batt_v': 1, 'backup_h': 1, 'temp_c': 0, 'load_a': 0, 'rssi': 0, 'lat': 5, 'lon': 5}, 'f': {'lat': 10.97, 'lon': 106.49, 'mains': 1, 'gen': 0, 'batt_pct': sin(96, 2, 300), 'batt_v': sin(53.5, 0.2, 200), 'backup_h': sin(9, 0.3, 300), 'temp_c': sin(31, 2, 200), 'door': 0, 'load_a': sin(42, 4, 120), 'rssi': sin(-82, 3, 150)}},
        't2': {'title': 'Trạm Bình Chánh', 'dec': {'batt_pct': 0, 'batt_v': 1, 'backup_h': 1, 'temp_c': 0, 'load_a': 0, 'rssi': 0, 'lat': 5, 'lon': 5}, 'f': {'lat': 10.67, 'lon': 106.57, 'mains': {'sq': [0, 1], 'p': 500, 'duty': 0.8}, 'gen': {'sq': [1, 0], 'p': 500, 'duty': 0.8}, 'batt_pct': sin(62, 18, 250), 'batt_v': sin(50.5, 1.5, 250), 'backup_h': sin(5, 2, 250), 'temp_c': sin(36, 3, 180), 'door': {'sq': [0, 1], 'p': 200, 'duty': 0.1}, 'load_a': sin(48, 5, 120), 'rssi': sin(-90, 4, 140)}},
        't3': {'title': 'Trạm Nhà Bè', 'dec': {'batt_pct': 0, 'batt_v': 1, 'backup_h': 1, 'temp_c': 0, 'load_a': 0, 'rssi': 0, 'lat': 5, 'lon': 5}, 'f': {'lat': 10.64, 'lon': 106.74, 'mains': 1, 'gen': 0, 'batt_pct': sin(88, 4, 280), 'batt_v': sin(52.8, 0.3, 230), 'backup_h': sin(8, 0.5, 280), 'temp_c': sin(33, 2, 190), 'door': 0, 'load_a': sin(38, 4, 120), 'rssi': sin(-96, 3, 160)}},
    }},
})

# ============================================================ TRẠM KHÍ TƯỢNG / THỦY VĂN
SPECS.append({
    'id': 'weather', 'title': 'Trạm khí tượng & thủy văn', 'icon': 'wind', 'style': 'soft', 'themeColor': '#0284c7',
    'palette': pal(['#e2f1fa', '#ffffff', '#0a2538', '#4c6a80', '#bcd7e8', '#0284c7'], ['#061520', '#0c2638', '#e0f2fd', '#86adc4', '#1a4260', '#38bdf8']),
    'metrics': [
        m('rain', 'Mưa hôm nay', 'mm', ['rain_mm'], agg='sum', dec=1), m('rate', 'Cường độ mưa', 'mm/h', ['rain_rate'], agg='max', dec=1, min=0, max=60, th=th(None, None, 20, 40)),
        m('level', 'Mực nước sông', 'cm', ['river_cm'], agg='max', dec=0, min=0, max=500, th=th(None, None, 300, 400)),
        m('ws', 'Tốc độ gió', 'm/s', ['wind_ms'], agg='max', dec=1, min=0, max=30, th=th(None, None, 14, 20)), m('wd', 'Hướng gió', '°', ['wind_deg'], agg='last', dec=0),
        m('temp', 'Nhiệt độ', '°C', ['temp_c'], agg='avg', dec=1), m('hum', 'Độ ẩm', '%', ['hum_pct'], agg='avg', dec=0), m('pres', 'Khí áp', 'hPa', ['pres_hpa'], agg='avg', dec=0, min=980, max=1040),
        m('bat', 'Pin trạm', 'V', ['batt_v'], agg='min', dec=1, th=th(12, 11.5)),
    ],
    'overview': [
        {'type': 'alarms'},
        {'type': 'wind', 'title': 'Gió', 'dir': 'wd', 'speed': 'ws'},
        {'type': 'kpis', 'items': ['temp', 'hum', 'rain', 'pres']},
        {'type': 'bars', 'title': 'Mực nước sông (cảnh báo lũ)', 'items': ['level', 'rate']},
        {'type': 'tiles', 'title': 'Các trạm', 'main': 'level', 'subs': ['rain', 'ws', 'bat']},
        {'type': 'trend', 'metric': 'level', 'title': 'Mực nước'},
    ],
    'tabs': [{'id': 'rain', 'label': 'Mưa & lũ', 'title': 'Mưa và mực nước', 'icon': 'drop', 'blocks': [{'type': 'kpis', 'items': ['rain', 'rate', 'level']}, {'type': 'trend', 'metric': 'rate', 'title': 'Cường độ mưa'}, {'type': 'trend', 'metric': 'level', 'title': 'Mực nước'}]}],
    'demo': {'devices': {
        'w1': {'title': 'Trạm sông A', 'dec': {'rain_mm': 1, 'rain_rate': 1, 'river_cm': 0, 'wind_ms': 1, 'wind_deg': 0, 'temp_c': 1, 'hum_pct': 0, 'pres_hpa': 0, 'batt_v': 1}, 'f': {'rain_mm': {'cnt': 0.004, 'start': 6.2}, 'rain_rate': sin(6, 5, 150), 'river_cm': sin(262, 40, 400), 'wind_ms': sin(5, 2, 90), 'wind_deg': {'sin': [220, 60, 300]}, 'temp_c': sin(28, 1.5, 500), 'hum_pct': sin(82, 4, 300), 'pres_hpa': sin(1008, 1.5, 600), 'batt_v': sin(12.9, 0.1, 200)}},
        'w2': {'title': 'Trạm đồi B', 'dec': {'rain_mm': 1, 'rain_rate': 1, 'river_cm': 0, 'wind_ms': 1, 'wind_deg': 0, 'temp_c': 1, 'hum_pct': 0, 'pres_hpa': 0, 'batt_v': 1}, 'f': {'rain_mm': {'cnt': 0.006, 'start': 9.8}, 'rain_rate': sin(10, 8, 130, 20), 'river_cm': sin(180, 30, 420, 60), 'wind_ms': sin(8, 3, 80), 'wind_deg': {'sin': [200, 50, 280]}, 'temp_c': sin(26, 1.5, 480), 'hum_pct': sin(86, 4, 290), 'pres_hpa': sin(1006, 1.5, 600), 'batt_v': sin(12.4, 0.2, 200)}},
    }},
})

# ============================================================ XỬ LÝ NƯỚC THẢI NHỎ
SPECS.append({
    'id': 'wwtp', 'title': 'Trạm xử lý nước thải', 'icon': 'wave', 'style': 'soft', 'themeColor': '#0f766e',
    'palette': pal(['#e1f0ea', '#ffffff', '#0b2a22', '#4a6c60', '#bcd8cc', '#0f766e'], ['#06180f', '#0c2a1d', '#dff5e8', '#86b39a', '#1a4630', '#34d399']),
    'metrics': [
        m('eq', 'Bể điều hòa', '%', ['lvl_eq'], agg='avg', dec=0, min=0, max=100, th=th(15, 8, 90, 96)), m('do', 'DO bể hiếu khí', 'mg/L', ['do_mgl'], agg='avg', dec=1, min=0, max=8, th=th(1.5, 0.8, 5)),
        m('sludge', 'Bùn bể lắng', '%', ['sludge'], agg='avg', dec=0, min=0, max=100, th=th(None, None, 70, 85)), m('ph', 'pH nước ra', '', ['ph_out'], agg='avg', dec=1, min=4, max=10, th=th(6, 5.5, 8.5, 9)),
        m('cod', 'COD nước ra', 'mg/L', ['cod_out'], agg='avg', dec=0, min=0, max=200, th=th(None, None, 100, 150)), m('flow', 'Lưu lượng', 'm³/h', ['flow'], agg='sum', dec=1),
        m('pump', 'Bơm nước thải', '', ['pump'], **RUN), m('blower', 'Máy thổi khí', '', ['blower'], **RUN), m('kwh', 'Điện hôm nay', 'kWh', ['kwh'], agg='sum', dec=0),
    ],
    'overview': [
        {'type': 'pid', 'w': 140, 'h': 64,
         'pipes': [{'pts': [[23, 26], [55, 26]], 'on': 'pump', 'color': 'var(--acc)'}, {'pts': [[77, 26], [92, 26]], 'on': 'pump', 'color': 'var(--acc)'}, {'pts': [[112, 26], [136, 26]], 'on': 'pump', 'color': 'var(--ok)'}, {'pts': [[66, 50], [66, 38]], 'on': 'blower', 'color': 'var(--warn)'}],
         'nodes': [{'kind': 'tank', 'x': 14, 'y': 12, 'w': 18, 'h': 28, 'metric': 'eq', 'label': 'Bể điều hòa'}, {'kind': 'pump', 'x': 40, 'y': 26, 'metric': 'pump', 'label': 'Bơm'},
                   {'kind': 'vessel', 'x': 66, 'y': 12, 'w': 22, 'h': 26, 'metric': 'do', 'label': 'Hiếu khí (DO)'}, {'kind': 'pump', 'x': 66, 'y': 52, 'metric': 'blower', 'label': 'Thổi khí'},
                   {'kind': 'vessel', 'x': 102, 'y': 12, 'w': 20, 'h': 26, 'metric': 'sludge', 'label': 'Bể lắng (bùn)'}, {'kind': 'sensor', 'x': 128, 'y': 44, 'metric': 'cod', 'label': 'COD ra'}]},
        {'type': 'gauges', 'items': ['do', 'ph', 'cod']},
        {'type': 'kpis', 'items': ['flow', 'eq', 'sludge', 'kwh']},
        {'type': 'state', 'items': ['pump', 'blower']},
        {'type': 'alarms'},
    ],
    'tabs': [{'id': 'quality', 'label': 'Chất lượng', 'title': 'Chất lượng nước ra', 'icon': 'drop', 'blocks': [{'type': 'bars', 'items': ['ph', 'cod', 'do']}, {'type': 'trend', 'metric': 'cod', 'title': 'COD nước ra'}, {'type': 'trend', 'metric': 'do', 'title': 'DO bể hiếu khí'}]}],
    'demo': {'devices': {'w1': {'title': 'Trạm XLNT 50 m³/ngày', 'dec': {'lvl_eq': 0, 'do_mgl': 1, 'sludge': 0, 'ph_out': 1, 'cod_out': 0, 'flow': 1, 'kwh': 0}, 'f': {
        'lvl_eq': sin(58, 18, 260), 'do_mgl': sin(3, 1.3, 150), 'sludge': sin(52, 10, 400), 'ph_out': sin(7.3, 0.4, 200), 'cod_out': sin(62, 25, 220), 'flow': sin(2.4, 0.6, 120),
        'pump': {'sq': [0, 1], 'p': 200, 'duty': 0.7}, 'blower': {'sq': [0, 1], 'p': 260, 'duty': 0.8}, 'kwh': {'cnt': 0.0015, 'start': 32}}}}},
})

# ============================================================ LÒ SẤY
SPECS.append({
    'id': 'dryer', 'title': 'Lò sấy & kho sấy', 'icon': 'thermo', 'style': 'soft', 'themeColor': '#c2410c',
    'palette': pal(['#f7e7dc', '#ffffff', '#2d1308', '#7a5640', '#e8cbb9', '#c2410c'], ['#170c06', '#2a170c', '#fdeadc', '#c9a58d', '#47291a', '#fb923c']),
    'metrics': [
        m('temp', 'Nhiệt độ buồng', '°C', ['temp_c'], agg='avg', dec=0, min=20, max=120, th=th(None, None, 75, 85)), m('sp', 'Nhiệt độ cài đặt', '°C', ['setpoint'], agg='avg', dec=0),
        m('hum', 'Độ ẩm buồng', '%', ['hum_pct'], agg='avg', dec=0, min=0, max=100), m('moist', 'Độ ẩm sản phẩm', '%', ['moisture'], agg='avg', dec=1, min=0, max=30),
        m('fan', 'Quạt', '', ['fan'], **RUN), m('heater', 'Gia nhiệt', '', ['heater'], **RUN), m('door', 'Cửa', '', ['door'], agg='max', map={'0': 'Đóng', '1': 'MỞ'}, lv={'0': 'ok', '1': 'warn'}),
        m('el', 'Đã sấy', 'phút', ['elapsed'], agg='max', dec=0), m('tot', 'Thời gian mẻ', 'phút', ['total_min'], agg='max', dec=0), m('kw', 'Công suất', 'kW', ['kw'], agg='sum', dec=1),
    ],
    'overview': [
        {'type': 'gauges', 'items': ['temp', 'hum', 'moist']},
        {'type': 'progress', 'title': 'Tiến độ mẻ sấy', 'items': [{'actual': 'el', 'target': 'tot', 'label': 'Thời gian đã sấy'}]},
        {'type': 'state', 'items': ['heater', 'fan', 'door']},
        {'type': 'kpis', 'items': ['temp', 'sp', 'moist', 'kw']},
        {'type': 'alarms'},
        {'type': 'trend', 'metric': 'temp', 'title': 'Đường cong nhiệt độ'},
    ],
    'tabs': [{'id': 'curve', 'label': 'Đường cong', 'title': 'Đường cong sấy', 'icon': 'chart', 'blocks': [{'type': 'trend', 'metric': 'temp', 'title': 'Nhiệt độ buồng'}, {'type': 'trend', 'metric': 'hum', 'title': 'Độ ẩm buồng'}, {'type': 'trend', 'metric': 'moist', 'title': 'Độ ẩm sản phẩm'}]}],
    'demo': {'devices': {'d1': {'title': 'Lò sấy 1', 'dec': {'temp_c': 0, 'setpoint': 0, 'hum_pct': 0, 'moisture': 1, 'elapsed': 0, 'total_min': 0, 'kw': 1}, 'f': {
        'temp_c': sin(62, 6, 180), 'setpoint': 62, 'hum_pct': sin(38, 8, 200), 'moisture': sin(14, 4, 500), 'fan': 1, 'heater': {'sq': [0, 1], 'p': 90, 'duty': 0.6}, 'door': 0, 'elapsed': {'cnt': 0.05, 'start': 190}, 'total_min': 360, 'kw': sin(14, 4, 90)}}}},
})

# ============================================================ TRẠM BƠM ĐỘC LẬP (PIN MẶT TRỜI)
SPECS.append({
    'id': 'pumpstn', 'title': 'Trạm bơm độc lập (pin mặt trời)', 'icon': 'drop', 'style': 'soft', 'themeColor': '#0891b2',
    'palette': pal(['#e1f3f6', '#ffffff', '#082c33', '#4a707a', '#bcdde4', '#0891b2'], ['#061a1f', '#0b2c34', '#dff6fa', '#86b5c0', '#194a57', '#22d3ee']),
    'metrics': [
        m('lvl', 'Mức bể', '%', ['level_pct'], agg='avg', dec=0, min=0, max=100, th=th(20, 10, 95, 98)), m('pump', 'Bơm', '', ['pump'], **RUN),
        m('batt', 'Pin', '%', ['batt_pct'], agg='min', dec=0, min=0, max=100, th=th(30, 15)), m('pv', 'Pin mặt trời', 'W', ['pv_w'], agg='sum', dec=0, min=0, max=800),
        m('flow', 'Lưu lượng', 'm³/h', ['flow'], agg='sum', dec=1), m('press', 'Áp suất', 'bar', ['press_bar'], agg='avg', dec=1), m('vol', 'Nước hôm nay', 'm³', ['vol_m3'], agg='sum', dec=1),
        m('dry', 'Bơm chạy khô', '', ['dry'], agg='max', map={'0': 'Bình thường', '1': 'CHẠY KHÔ'}, lv={'0': 'ok', '1': 'bad'}),
    ],
    'overview': [
        {'type': 'alarms'},
        {'type': 'tank', 'title': 'Bể chứa', 'items': ['lvl']},
        {'type': 'gauges', 'items': ['batt', 'pv', 'press']},
        {'type': 'state', 'items': ['pump', 'dry']},
        {'type': 'kpis', 'items': ['flow', 'vol', 'pv', 'batt']},
        {'type': 'trend', 'metric': 'pv', 'title': 'Công suất mặt trời'},
    ],
    'tabs': [{'id': 'stations', 'label': 'Các trạm', 'title': 'Các trạm bơm', 'icon': 'drop', 'blocks': [{'type': 'tiles', 'main': 'lvl', 'subs': ['batt', 'pv', 'pump']}]}],
    'demo': {'devices': {
        'p1': {'title': 'Trạm bơm Ấp 1', 'dec': {'level_pct': 0, 'batt_pct': 0, 'pv_w': 0, 'flow': 1, 'press_bar': 1, 'vol_m3': 1}, 'f': {'level_pct': sin(62, 20, 300), 'pump': {'sq': [0, 1], 'p': 200, 'duty': 0.5}, 'batt_pct': sin(70, 18, 500), 'pv_w': sin(420, 260, 600), 'flow': sin(6, 1.5, 100), 'press_bar': sin(2.2, 0.3, 90), 'vol_m3': {'cnt': 0.002, 'start': 18}, 'dry': 0}},
        'p2': {'title': 'Trạm bơm Ấp 2', 'dec': {'level_pct': 0, 'batt_pct': 0, 'pv_w': 0, 'flow': 1, 'press_bar': 1, 'vol_m3': 1}, 'f': {'level_pct': sin(34, 18, 320, 50), 'pump': {'sq': [0, 1], 'p': 240, 'duty': 0.4}, 'batt_pct': sin(38, 14, 480), 'pv_w': sin(380, 240, 600, 40), 'flow': sin(5, 1.4, 110), 'press_bar': sin(1.9, 0.3, 90), 'vol_m3': {'cnt': 0.0015, 'start': 11}, 'dry': {'sq': [1, 0], 'p': 800, 'duty': 0.98}}},
    }},
})
