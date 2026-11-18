# -*- coding: utf-8 -*-
"""Khai báo các giải pháp ngành (mỗi mục → solutions/<id>/ do gen.py sinh ra). Chỉ khác GIAO DIỆN: đăng nhập, quét QR, cài đặt, chat… là mã bản cơ bản."""


def m(id, label, unit='', keys=None, **kw):
    d = {'id': id, 'label': label}
    if unit:
        d['unit'] = unit
    if keys:
        d['keys'] = keys
    d.update(kw)
    return d


def th(lo=None, loLo=None, hi=None, hiHi=None):
    return {k: v for k, v in {'lo': lo, 'loLo': loLo, 'hi': hi, 'hiHi': hiHi}.items() if v is not None}


def sin(base, amp, per=60, ph=0):
    return [base, amp, per, ph]


RUN = {'map': {'0': 'Dừng', '1': 'Chạy'}, 'lv': {'0': 'off', '1': 'ok'}, 'agg': 'max'}
FAULT = {'map': {'0': 'Không', '1': 'Lỗi'}, 'lv': {'0': 'ok', '1': 'bad'}, 'agg': 'max'}


def pal(light, dark):
    keys = ['bg', 'card', 'fg', 'mut', 'line', 'acc']
    return {'light': dict(zip(keys, light)), 'dark': dict(zip(keys, dark))}


SPECS = []

# ---------------------------------------------------------------- 1. Cấp nước / trạm bơm
SPECS.append({
    'id': 'water', 'title': 'Cấp nước & trạm bơm', 'icon': 'drop', 'style': 'soft', 'themeColor': '#0a7ea4',
    'palette': pal(['#e6f4f8', '#ffffff', '#0c2a36', '#4c6a78', '#c3dde6', '#0a7ea4'], ['#071c26', '#0d2f3f', '#e3f3f9', '#8db3c4', '#1e4a5e', '#38bdf8']),
    'metrics': [
        m('flow', 'Lưu lượng', 'm³/h', ['flow_m3h', 'flow'], agg='sum', min=0, max=300),
        m('pressure', 'Áp suất', 'bar', ['pressure_bar', 'pressure'], agg='avg', min=0, max=10, th=th(1.5, 0.8, 7, 9)),
        m('level', 'Mức bể chứa', '%', ['level_pct', 'level'], agg='avg', min=0, max=100, dec=0, th=th(20, 10, 95, 98)),
        m('chlorine', 'Clo dư', 'mg/L', ['cl_mgl', 'chlorine'], agg='avg', min=0, max=3, th=th(0.3, 0.1, 1.5, 2.5)),
        m('turbidity', 'Độ đục', 'NTU', ['ntu', 'turbidity'], agg='avg', min=0, max=5, th=th(None, None, 1, 4)),
        m('ph', 'pH', '', ['ph'], agg='avg', min=5, max=10, th=th(6.5, 6, 8.5, 9)),
        m('total', 'Tổng sản lượng', 'm³', ['total_m3'], agg='sum', dec=0),
        m('pump_kw', 'Công suất bơm', 'kW', ['pump_kw'], agg='sum'),
        m('kwhm3', 'Điện năng riêng', 'kWh/m³', expr='pump_kw / flow', dec=2, th=th(None, None, 0.35, 0.6)),   # tính ngay tại webapp/gateway từ 2 cảm biến
        m('p1', 'Bơm 1', '', ['pump1_run'], **RUN),
        m('p2', 'Bơm 2', '', ['pump2_run'], **RUN),
        m('fault', 'Sự cố', '', ['fault'], **FAULT),
    ],
    'overview': [
        {'type': 'kpis', 'items': ['flow', 'total', 'kwhm3', 'pressure']},
        {'type': 'tank', 'title': 'Bể chứa', 'items': ['level']},
        {'type': 'gauges', 'title': 'Áp lực & chất lượng', 'items': ['pressure', 'chlorine', 'turbidity']},
        {'type': 'state', 'title': 'Máy bơm', 'items': ['p1', 'p2', 'fault']},
        {'type': 'trend', 'metric': 'flow', 'title': 'Lưu lượng gần đây'},
    ],
    'tabs': [
        {'id': 'quality', 'label': 'Chất lượng', 'title': 'Chất lượng nước', 'icon': 'drop', 'blocks': [
            {'type': 'bars', 'items': ['chlorine', 'turbidity', 'ph']}, {'type': 'trend', 'metric': 'ph', 'title': 'pH'}, {'type': 'alarms', 'title': 'Vượt ngưỡng'}]},
        {'id': 'pumps', 'label': 'Trạm bơm', 'title': 'Các trạm bơm', 'icon': 'gear', 'blocks': [
            {'type': 'tiles', 'main': 'flow', 'subs': ['pressure', 'level', 'pump_kw']}]},
    ],
    'demo': {'devices': {
        'ts1': {'title': 'Trạm bơm 1', 'dec': {'ph': 2, 'cl_mgl': 2, 'ntu': 2, 'total_m3': 0}, 'f': {
            'flow_m3h': sin(120, 25, 50), 'pressure_bar': sin(5.2, 0.5, 40), 'level_pct': sin(62, 12, 200), 'cl_mgl': sin(0.8, 0.1, 90), 'ntu': sin(0.4, 0.12, 70),
            'ph': sin(7.3, 0.15, 120), 'total_m3': {'cnt': 0.03, 'start': 18200}, 'pump_kw': sin(11, 1.5, 60), 'pump1_run': {'sq': [0, 1], 'p': 300, 'duty': 0.85}, 'pump2_run': {'sq': [0, 1], 'p': 200, 'duty': 0.4, 'ph': 50}, 'fault': 0}},
        'ts2': {'title': 'Trạm bơm 2', 'f': {
            'flow_m3h': sin(85, 18, 65, 5), 'pressure_bar': sin(4.4, 0.6, 55), 'level_pct': sin(46, 14, 240), 'cl_mgl': sin(0.7, 0.1, 100), 'ntu': sin(0.5, 0.15, 80),
            'ph': sin(7.1, 0.12, 140), 'total_m3': {'cnt': 0.02, 'start': 9400}, 'pump_kw': sin(7.5, 1, 70), 'pump1_run': {'sq': [0, 1], 'p': 250, 'duty': 0.9}, 'pump2_run': 0, 'fault': 0}},
    }},
})

# ---------------------------------------------------------------- 2. Nông nghiệp nhà kính
SPECS.append({
    'id': 'agri', 'title': 'Nông nghiệp nhà kính', 'icon': 'leaf', 'style': 'soft', 'themeColor': '#2f7d32',
    'palette': pal(['#eaf4e4', '#ffffff', '#16301a', '#587058', '#cbdcc2', '#2f7d32'], ['#0c1a0e', '#142a17', '#e4f3e3', '#97b59a', '#26442a', '#6fd46f']),
    'metrics': [
        m('temp', 'Nhiệt độ', '°C', ['temp_c', 'temp'], agg='avg', min=0, max=50, th=th(16, 10, 32, 38)),
        m('hum', 'Độ ẩm KK', '%', ['hum_pct', 'hum'], agg='avg', min=0, max=100, dec=0, th=th(45, 30, 90, 96)),
        m('soil', 'Độ ẩm đất', '%', ['soil_pct', 'soil'], agg='avg', min=0, max=100, dec=0, th=th(30, 20, 85, 92)),
        m('light', 'Ánh sáng', 'lux', ['light_lux', 'lux'], agg='avg', min=0, max=60000, dec=0),
        m('co2', 'CO₂', 'ppm', ['co2_ppm', 'co2'], agg='avg', min=300, max=2000, dec=0, th=th(None, None, 1500, 1900)),
        m('ec', 'EC', 'mS/cm', ['ec'], agg='avg'),
        m('ph', 'pH dung dịch', '', ['ph'], agg='avg', min=4, max=9, th=th(5.5, 5, 6.8, 7.5)),
        m('water', 'Nước đã tưới', 'L', ['water_l'], agg='sum', dec=0),
        m('fan', 'Quạt', '', ['fan'], **RUN), m('mist', 'Phun sương', '', ['mist'], **RUN),
        m('pump', 'Bơm tưới', '', ['pump'], **RUN), m('shade', 'Lưới che', '', ['shade'], map={'0': 'Mở', '1': 'Đóng'}, lv={'0': 'off', '1': 'ok'}, agg='max'),
    ],
    'overview': [
        {'type': 'kpis', 'items': ['temp', 'hum', 'light', 'co2']},
        {'type': 'tiles', 'title': 'Các vùng trồng', 'main': 'soil', 'subs': ['temp', 'hum', 'light']},
        {'type': 'state', 'title': 'Thiết bị chấp hành', 'items': ['fan', 'mist', 'pump', 'shade']},
        {'type': 'trend', 'metric': 'temp', 'title': 'Nhiệt độ'},
    ],
    'tabs': [
        {'id': 'climate', 'label': 'Khí hậu', 'title': 'Khí hậu nhà kính', 'icon': 'thermo', 'blocks': [
            {'type': 'gauges', 'items': ['temp', 'hum', 'co2']}, {'type': 'trend', 'metric': 'hum', 'title': 'Độ ẩm không khí'}, {'type': 'trend', 'metric': 'co2', 'title': 'CO₂'}]},
        {'id': 'irrig', 'label': 'Tưới', 'title': 'Tưới & dinh dưỡng', 'icon': 'drop', 'blocks': [
            {'type': 'state', 'items': ['pump', 'mist']}, {'type': 'bars', 'items': ['soil', 'ec', 'ph']}, {'type': 'kpis', 'items': ['water', 'ec', 'ph']}]},
    ],
    'demo': {'devices': {
        'gh1': {'title': 'Nhà kính A', 'f': {'temp_c': sin(27, 3, 120), 'hum_pct': sin(72, 6, 150), 'soil_pct': sin(58, 8, 220), 'light_lux': sin(32000, 9000, 300), 'co2_ppm': sin(820, 120, 160), 'ec': sin(1.8, 0.1, 90), 'ph': sin(6.1, 0.1, 100),
                'water_l': {'cnt': 0.4, 'start': 1200}, 'fan': {'sq': [0, 1], 'p': 120, 'duty': 0.6}, 'mist': {'sq': [0, 1], 'p': 90, 'duty': 0.3}, 'pump': {'sq': [0, 1], 'p': 180, 'duty': 0.25}, 'shade': 0}, 'dec': {'light_lux': 0, 'co2_ppm': 0, 'hum_pct': 0, 'soil_pct': 0}},
        'gh2': {'title': 'Nhà kính B', 'f': {'temp_c': sin(29, 4, 130, 20), 'hum_pct': sin(66, 7, 140), 'soil_pct': sin(36, 9, 200), 'light_lux': sin(30000, 8000, 300), 'co2_ppm': sin(900, 100, 170), 'ec': sin(2.1, 0.1, 80), 'ph': sin(6.3, 0.1, 110),
                'water_l': {'cnt': 0.3, 'start': 900}, 'fan': 1, 'mist': 0, 'pump': {'sq': [0, 1], 'p': 200, 'duty': 0.3, 'ph': 30}, 'shade': 1}, 'dec': {'light_lux': 0, 'co2_ppm': 0, 'hum_pct': 0, 'soil_pct': 0}},
        'gh3': {'title': 'Vườn ngoài trời', 'f': {'temp_c': sin(31, 5, 140, 40), 'hum_pct': sin(58, 8, 160), 'soil_pct': sin(44, 7, 240), 'light_lux': sin(48000, 12000, 300), 'co2_ppm': sin(430, 20, 170),
                'water_l': {'cnt': 0.2, 'start': 500}, 'fan': 0, 'mist': 0, 'pump': 0, 'shade': 0}, 'dec': {'light_lux': 0, 'co2_ppm': 0, 'hum_pct': 0, 'soil_pct': 0}},
    }},
})

# ---------------------------------------------------------------- 3. Kho lạnh
SPECS.append({
    'id': 'coldchain', 'title': 'Kho lạnh & chuỗi lạnh', 'icon': 'snow', 'style': 'sharp', 'themeColor': '#0e7490',
    'palette': pal(['#e3f2f7', '#ffffff', '#0b2530', '#4a6874', '#bcd8e2', '#0e7490'], ['#06161d', '#0c2630', '#e0f3f8', '#86b0bf', '#1b4252', '#22d3ee']),
    'metrics': [
        m('temp', 'Nhiệt độ kho', '°C', ['temp_c', 'temp'], agg='max', dec=1, min=-30, max=10, th=th(None, None, -15, -10)),
        m('hum', 'Độ ẩm', '%', ['hum_pct', 'hum'], agg='avg', dec=0),
        m('margin', 'Dự phòng tới ngưỡng -15°C', '°C', expr='-15 - temp', dec=1, th=th(3, 0)),
        m('door', 'Cửa', '', ['door'], agg='max', map={'0': 'Đóng', '1': 'MỞ'}, lv={'0': 'ok', '1': 'warn'}),
        m('comp', 'Máy nén', '', ['comp'], **RUN),
        m('defrost', 'Xả đá', '', ['defrost'], agg='max', map={'0': 'Không', '1': 'Đang xả đá'}, lv={'0': 'ok', '1': 'warn'}),
        m('power', 'Công suất', 'kW', ['power_kw', 'kw'], agg='sum'),
        m('kwh', 'Điện năng', 'kWh', ['kwh'], agg='sum', dec=0),
        m('alarm', 'Báo động', '', ['alarm'], agg='max', map={'0': 'Bình thường', '1': 'BÁO ĐỘNG'}, lv={'0': 'ok', '1': 'bad'}),
    ],
    'overview': [
        {'type': 'alarms'},
        {'type': 'tiles', 'title': 'Các phòng lạnh', 'main': 'temp', 'subs': ['hum', 'comp', 'door']},
        {'type': 'kpis', 'items': ['temp', 'margin', 'power', 'kwh']},
        {'type': 'state', 'items': ['comp', 'defrost', 'door', 'alarm']},
        {'type': 'trend', 'metric': 'temp', 'title': 'Nhiệt độ cao nhất các kho'},
    ],
    'tabs': [
        {'id': 'energy', 'label': 'Điện năng', 'title': 'Điện năng & máy nén', 'icon': 'bolt', 'blocks': [
            {'type': 'kpis', 'items': ['power', 'kwh']}, {'type': 'trend', 'metric': 'power', 'title': 'Công suất'}, {'type': 'state', 'items': ['comp', 'defrost']}]},
    ],
    'demo': {'devices': {
        'k1': {'title': 'Kho đông A', 'f': {'temp_c': sin(-19, 1.2, 260), 'hum_pct': sin(82, 3, 200), 'door': {'sq': [1, 0], 'p': 400, 'duty': 0.96}, 'comp': {'sq': [0, 1], 'p': 150, 'duty': 0.7}, 'defrost': 0, 'power_kw': sin(6.4, 1.2, 80), 'kwh': {'cnt': 0.002, 'start': 4120}, 'alarm': 0}},
        'k2': {'title': 'Kho đông B', 'f': {'temp_c': sin(-17.5, 1.0, 230, 30), 'hum_pct': sin(80, 3, 210), 'door': 0, 'comp': 1, 'defrost': {'sq': [1, 0], 'p': 500, 'duty': 0.93}, 'power_kw': sin(5.8, 1, 90), 'kwh': {'cnt': 0.002, 'start': 3550}, 'alarm': 0}},
        'k3': {'title': 'Phòng đệm', 'f': {'temp_c': sin(-13.5, 2.5, 180, 10), 'hum_pct': sin(70, 4, 190), 'door': {'sq': [0, 1], 'p': 90, 'duty': 0.8}, 'comp': {'sq': [0, 1], 'p': 100, 'duty': 0.6}, 'defrost': 0, 'power_kw': sin(2.2, 0.5, 70), 'kwh': {'cnt': 0.001, 'start': 1300}, 'alarm': 0}},
    }},
})

# ---------------------------------------------------------------- 4. HVAC / Tòa nhà
SPECS.append({
    'id': 'hvac', 'title': 'Tòa nhà & điều hòa HVAC', 'icon': 'building', 'style': 'glass', 'themeColor': '#0f766e',
    'palette': pal(['#e6f3f1', '#ffffff', '#10302d', '#52726e', '#c2dbd7', '#0f766e'], ['#071a18', '#0e2a27', '#e2f5f2', '#8fb8b2', '#1d4a45', '#2dd4bf']),
    'metrics': [
        m('temp', 'Nhiệt độ', '°C', ['temp_c', 'temp'], agg='avg', dec=1, min=15, max=35, th=th(19, 16, 27, 30)),
        m('sp', 'Cài đặt', '°C', ['setpoint', 'sp'], agg='avg', dec=1),
        m('delta', 'Lệch so với cài đặt', '°C', expr='temp - sp', dec=1, th=th(-2.5, None, 2.5, 4)),
        m('hum', 'Độ ẩm', '%', ['hum_pct', 'hum'], agg='avg', dec=0, th=th(30, None, 70, 80)),
        m('co2', 'CO₂', 'ppm', ['co2_ppm', 'co2'], agg='max', dec=0, min=400, max=2000, th=th(None, None, 1000, 1500)),
        m('fan', 'Quạt', '', ['fan'], agg='max', map={'0': 'Tắt', '1': 'Thấp', '2': 'Vừa', '3': 'Cao'}, lv={'0': 'off', '1': 'ok', '2': 'ok', '3': 'ok'}),
        m('kw', 'Công suất', 'kW', ['kw', 'power_kw'], agg='sum'),
        m('kwh', 'Điện năng', 'kWh', ['kwh'], agg='sum', dec=0),
        m('cop', 'COP', '', ['cop'], agg='avg', dec=1, min=0, max=6, th=th(2, 1.5)),
        m('oat', 'Ngoài trời', '°C', ['oat'], agg='avg', dec=1),
    ],
    'overview': [
        {'type': 'kpis', 'items': ['temp', 'delta', 'co2', 'kw']},
        {'type': 'tiles', 'title': 'Khu vực', 'main': 'temp', 'subs': ['sp', 'delta', 'fan']},
        {'type': 'gauges', 'items': ['cop', 'kw', 'oat']},
        {'type': 'trend', 'metric': 'kw', 'title': 'Công suất tiêu thụ'},
    ],
    'tabs': [
        {'id': 'energy', 'label': 'Tiêu thụ', 'title': 'Năng lượng tòa nhà', 'icon': 'bolt', 'blocks': [
            {'type': 'kpis', 'items': ['kw', 'kwh', 'cop']}, {'type': 'trend', 'metric': 'kw', 'title': 'Công suất'}, {'type': 'trend', 'metric': 'oat', 'title': 'Nhiệt độ ngoài trời'}]},
        {'id': 'air', 'label': 'Không khí', 'title': 'Chất lượng không khí', 'icon': 'wind', 'blocks': [
            {'type': 'bars', 'items': ['co2', 'hum']}, {'type': 'trend', 'metric': 'co2', 'title': 'CO₂'}]},
    ],
    'demo': {'devices': {
        'z1': {'title': 'Tầng 1 - Sảnh', 'f': {'temp_c': sin(24.5, 0.8, 150), 'setpoint': 24, 'hum_pct': sin(58, 4, 170), 'co2_ppm': sin(720, 120, 140), 'fan': 2, 'kw': sin(8, 1.5, 80), 'kwh': {'cnt': 0.002, 'start': 9300}, 'cop': sin(3.6, 0.2, 100), 'oat': sin(32, 1, 400)}, 'dec': {'co2_ppm': 0, 'hum_pct': 0}},
        'z2': {'title': 'Tầng 2 - Văn phòng', 'f': {'temp_c': sin(25.5, 1.2, 140, 20), 'setpoint': 24, 'hum_pct': sin(55, 4, 160), 'co2_ppm': sin(980, 220, 120), 'fan': 3, 'kw': sin(12, 2, 70), 'kwh': {'cnt': 0.003, 'start': 14700}, 'cop': sin(3.2, 0.2, 90)}, 'dec': {'co2_ppm': 0, 'hum_pct': 0}},
        'z3': {'title': 'Phòng họp', 'f': {'temp_c': sin(23.5, 0.6, 130, 40), 'setpoint': 23, 'hum_pct': sin(52, 3, 150), 'co2_ppm': sin(1080, 260, 110), 'fan': 1, 'kw': sin(3, 0.8, 90), 'kwh': {'cnt': 0.001, 'start': 2100}}, 'dec': {'co2_ppm': 0, 'hum_pct': 0}},
        'z4': {'title': 'Phòng máy chủ', 'f': {'temp_c': sin(21.5, 1.0, 120, 10), 'setpoint': 21, 'hum_pct': sin(45, 3, 140), 'co2_ppm': sin(520, 40, 130), 'fan': 3, 'kw': sin(5, 0.6, 60), 'kwh': {'cnt': 0.0015, 'start': 8800}}, 'dec': {'co2_ppm': 0, 'hum_pct': 0}},
    }},
})

# ---------------------------------------------------------------- 5. Sản xuất / OEE
SPECS.append({
    'id': 'factory', 'title': 'Sản xuất & OEE', 'icon': 'factory', 'style': 'sharp', 'themeColor': '#3730a3',
    'palette': pal(['#ecebf7', '#ffffff', '#1a1840', '#5b5a82', '#cdcbe6', '#3730a3'], ['#0e0d26', '#18173b', '#ebeaff', '#9d9cc7', '#2e2c5c', '#fb923c']),
    'metrics': [
        m('oee', 'OEE', '%', ['oee'], agg='avg', dec=0, min=0, max=100, th=th(60, 40)),
        m('avail', 'Sẵn sàng', '%', ['avail'], agg='avg', dec=0, min=0, max=100, th=th(75, 60)),
        m('perf', 'Hiệu suất', '%', ['perf'], agg='avg', dec=0, min=0, max=100, th=th(75, 60)),
        m('qual', 'Chất lượng', '%', ['qual'], agg='avg', dec=1, min=0, max=100, th=th(95, 90)),
        m('count', 'Sản lượng ca', 'sp', ['count'], agg='max', dec=0),
        m('reject', 'Phế phẩm', 'sp', ['reject'], agg='sum', dec=0),
        m('scrap', 'Tỷ lệ phế phẩm', '%', expr='reject / count * 100', dec=1, th=th(None, None, 3, 6)),
        m('speed', 'Tốc độ', 'sp/ph', ['speed'], agg='avg', dec=0, min=0, max=100),
        m('state', 'Trạng thái', '', ['state'], agg='max', map={'0': 'Dừng', '1': 'Chạy', '2': 'LỖI', '3': 'Chờ'}, lv={'0': 'off', '1': 'ok', '2': 'bad', '3': 'warn'}),
        m('down', 'Dừng máy', 'phút', ['down'], agg='sum', dec=0),
        m('kw', 'Công suất', 'kW', ['kw'], agg='sum'),
    ],
    'overview': [
        {'type': 'ring', 'main': 'oee', 'subs': ['avail', 'perf', 'qual']},
        {'type': 'kpis', 'items': ['count', 'reject', 'scrap', 'kw']},
        {'type': 'line', 'title': 'Dây chuyền', 'state': 'state', 'sub': 'speed'},
        {'type': 'alarms'},
        {'type': 'trend', 'metric': 'oee', 'title': 'OEE'},
    ],
    'tabs': [
        {'id': 'lines', 'label': 'Công đoạn', 'title': 'Các công đoạn', 'icon': 'gear', 'blocks': [
            {'type': 'tiles', 'main': 'state', 'subs': ['count', 'speed', 'reject']}]},
        {'id': 'quality', 'label': 'Chất lượng', 'title': 'Chất lượng & dừng máy', 'icon': 'chart', 'blocks': [
            {'type': 'bars', 'items': ['avail', 'perf', 'qual']}, {'type': 'kpis', 'items': ['reject', 'down']}, {'type': 'trend', 'metric': 'reject', 'title': 'Phế phẩm'}]},
    ],
    'demo': {'devices': {
        'st1': {'title': 'Cắt', 'dec': {'oee': 0, 'avail': 0, 'perf': 0, 'qual': 1, 'speed': 0, 'count': 0}, 'f': {'oee': sin(78, 4, 140), 'avail': sin(91, 2, 160), 'perf': sin(87, 3, 130), 'qual': sin(98.6, 0.3, 120), 'count': {'cnt': 1.0, 'start': 2400}, 'reject': {'cnt': 0.02, 'start': 20}, 'speed': sin(60, 5, 70), 'state': 1, 'down': {'cnt': 0.002, 'start': 22}, 'kw': sin(14, 2, 80)}},
        'st2': {'title': 'Hàn', 'dec': {'oee': 0, 'avail': 0, 'perf': 0, 'qual': 1, 'speed': 0, 'count': 0}, 'f': {'oee': sin(74, 5, 150, 10), 'avail': sin(88, 2, 170), 'perf': sin(84, 3, 140), 'qual': sin(98.2, 0.3, 130), 'count': {'cnt': 0.96, 'start': 2300}, 'reject': {'cnt': 0.03, 'start': 31}, 'speed': sin(58, 5, 75), 'state': {'sq': [3, 1], 'p': 300, 'duty': 0.9}, 'down': {'cnt': 0.003, 'start': 34}, 'kw': sin(22, 3, 90)}},
        'st3': {'title': 'Sơn', 'dec': {'oee': 0, 'avail': 0, 'perf': 0, 'qual': 1, 'speed': 0, 'count': 0}, 'f': {'oee': sin(70, 6, 160, 20), 'avail': sin(84, 3, 180), 'perf': sin(82, 3, 150), 'qual': sin(97.4, 0.5, 140), 'count': {'cnt': 0.9, 'start': 2150}, 'reject': {'cnt': 0.05, 'start': 52}, 'speed': sin(55, 4, 80), 'state': {'sq': [2, 1], 'p': 360, 'duty': 0.92}, 'down': {'cnt': 0.004, 'start': 47}, 'kw': sin(30, 3, 100)}},
        'st4': {'title': 'Lắp ráp', 'dec': {'oee': 0, 'avail': 0, 'perf': 0, 'qual': 1, 'speed': 0, 'count': 0}, 'f': {'oee': sin(80, 4, 130, 30), 'avail': sin(93, 2, 150), 'perf': sin(88, 3, 120), 'qual': sin(99, 0.2, 110), 'count': {'cnt': 0.9, 'start': 2100}, 'reject': {'cnt': 0.01, 'start': 11}, 'speed': sin(52, 4, 90), 'state': 1, 'down': {'cnt': 0.001, 'start': 12}, 'kw': sin(9, 1, 70)}},
        'st5': {'title': 'Đóng gói', 'dec': {'oee': 0, 'avail': 0, 'perf': 0, 'qual': 1, 'speed': 0, 'count': 0}, 'f': {'oee': sin(83, 3, 120, 40), 'avail': sin(95, 1.5, 140), 'perf': sin(90, 2, 110), 'qual': sin(99.5, 0.2, 100), 'count': {'cnt': 0.88, 'start': 2050}, 'reject': {'cnt': 0.005, 'start': 6}, 'speed': sin(50, 3, 100), 'state': {'sq': [0, 1], 'p': 500, 'duty': 0.95}, 'down': {'cnt': 0.001, 'start': 8}, 'kw': sin(6, 0.8, 60)}},
    }},
})

# ---------------------------------------------------------------- 6. Điện năng 3 pha
SPECS.append({
    'id': 'energy', 'title': 'Giám sát điện năng 3 pha', 'icon': 'bolt', 'style': 'dense', 'themeColor': '#a16207',
    'palette': pal(['#f6f0dc', '#fffdf5', '#2a2208', '#6c6034', '#e0d4a6', '#a16207'], ['#15110a', '#221c0d', '#fbf2d2', '#bfae7a', '#3d3416', '#facc15']),
    'metrics': [
        m('v1', 'Điện áp L1', 'V', ['v_l1', 'v1', 'ua'], agg='avg', dec=0, min=180, max=260, th=th(207, 198, 245, 253)),
        m('v2', 'Điện áp L2', 'V', ['v_l2', 'v2', 'ub'], agg='avg', dec=0, min=180, max=260, th=th(207, 198, 245, 253)),
        m('v3', 'Điện áp L3', 'V', ['v_l3', 'v3', 'uc'], agg='avg', dec=0, min=180, max=260, th=th(207, 198, 245, 253)),
        m('i1', 'Dòng L1', 'A', ['i_l1', 'i1', 'ia'], agg='sum', dec=1, min=0, max=100, th=th(None, None, 80, 95)),
        m('i2', 'Dòng L2', 'A', ['i_l2', 'i2', 'ib'], agg='sum', dec=1, min=0, max=100, th=th(None, None, 80, 95)),
        m('i3', 'Dòng L3', 'A', ['i_l3', 'i3', 'ic'], agg='sum', dec=1, min=0, max=100, th=th(None, None, 80, 95)),
        m('kw', 'Công suất P', 'kW', ['kw', 'p_kw'], agg='sum', dec=1),
        m('kvar', 'Phản kháng Q', 'kVAr', ['kvar', 'q_kvar'], agg='sum', dec=1),
        m('kva', 'Biểu kiến S', 'kVA', expr='sqrt(kw*kw + kvar*kvar)', dec=1),
        m('pf', 'Hệ số công suất', '', ['pf', 'cosphi'], agg='avg', dec=2, min=0, max=1, th=th(0.85, 0.7)),
        m('hz', 'Tần số', 'Hz', ['hz', 'freq'], agg='avg', dec=2, min=49, max=51, th=th(49.5, 49.2, 50.5, 50.8)),
        m('kwh', 'Điện năng', 'kWh', ['kwh', 'e_total'], agg='sum', dec=0),
    ],
    'overview': [
        {'type': 'kpis', 'items': ['kw', 'kvar', 'kva', 'pf']},
        {'type': 'bars', 'title': 'Điện áp pha', 'items': ['v1', 'v2', 'v3']},
        {'type': 'bars', 'title': 'Dòng điện pha', 'items': ['i1', 'i2', 'i3']},
        {'type': 'gauges', 'items': ['pf', 'hz']},
        {'type': 'trend', 'metric': 'kw', 'title': 'Công suất P'},
    ],
    'tabs': [
        {'id': 'quality', 'label': 'Chất lượng', 'title': 'Chất lượng điện', 'icon': 'chart', 'blocks': [
            {'type': 'gauges', 'items': ['hz', 'pf']}, {'type': 'trend', 'metric': 'pf', 'title': 'Hệ số công suất'}, {'type': 'trend', 'metric': 'v1', 'title': 'Điện áp L1'}, {'type': 'alarms'}]},
        {'id': 'meters', 'label': 'Công tơ', 'title': 'Các công tơ', 'icon': 'gear', 'blocks': [{'type': 'tiles', 'main': 'kw', 'subs': ['pf', 'i1', 'kwh']}]},
    ],
    'demo': {'devices': {
        'm1': {'title': 'Tủ điện tổng', 'dec': {'v_l1': 1, 'v_l2': 1, 'v_l3': 1, 'i_l1': 1, 'i_l2': 1, 'i_l3': 1, 'kw': 1, 'kvar': 1, 'pf': 2, 'hz': 2, 'kwh': 0}, 'f': {
            'v_l1': sin(230, 3, 70), 'v_l2': sin(228, 3, 80, 10), 'v_l3': sin(231, 4, 90, 20), 'i_l1': sin(52, 8, 60), 'i_l2': sin(48, 9, 70, 5), 'i_l3': sin(55, 10, 65, 9),
            'kw': sin(33, 5, 60), 'kvar': sin(11, 2, 70), 'pf': sin(0.94, 0.02, 100), 'hz': sin(50, 0.08, 40), 'kwh': {'cnt': 0.009, 'start': 128400}}},
        'm2': {'title': 'Tủ máy sản xuất', 'dec': {'v_l1': 1, 'v_l2': 1, 'v_l3': 1, 'i_l1': 1, 'i_l2': 1, 'i_l3': 1, 'kw': 1, 'kvar': 1, 'pf': 2, 'hz': 2, 'kwh': 0}, 'f': {
            'v_l1': sin(229, 3, 75), 'v_l2': sin(227, 3, 85), 'v_l3': sin(230, 3, 95), 'i_l1': sin(30, 6, 55), 'i_l2': sin(28, 6, 65), 'i_l3': sin(33, 7, 60),
            'kw': sin(19, 4, 60), 'kvar': sin(9, 2, 70), 'pf': sin(0.9, 0.03, 90), 'hz': sin(50, 0.07, 45), 'kwh': {'cnt': 0.005, 'start': 70100}}},
    }},
})

# ---------------------------------------------------------------- 7. Trạm sạc xe điện
SPECS.append({
    'id': 'ev', 'title': 'Trạm sạc xe điện', 'icon': 'plug', 'style': 'glass', 'themeColor': '#6d28d9',
    'palette': pal(['#efe9fb', '#ffffff', '#221546', '#66598a', '#d6cbf0', '#6d28d9'], ['#120a26', '#201440', '#eee8ff', '#a99bd4', '#392a66', '#34d399']),
    'metrics': [
        m('state', 'Trạng thái', '', ['state'], agg='max', map={'0': 'Rảnh', '1': 'Đang sạc', '2': 'LỖI', '3': 'Đã cắm'}, lv={'0': 'off', '1': 'ok', '2': 'bad', '3': 'warn'}),
        m('kw', 'Công suất', 'kW', ['kw'], agg='sum', dec=1, min=0, max=150),
        m('kwh', 'Điện sạc hôm nay', 'kWh', ['kwh_today', 'kwh'], agg='sum', dec=0),
        m('soc', 'SOC xe', '%', ['soc'], agg='avg', dec=0, min=0, max=100),
        m('sessions', 'Phiên sạc', '', ['sessions'], agg='sum', dec=0),
        m('rev', 'Doanh thu', 'k₫', ['rev_k', 'rev'], agg='sum', dec=0),
        m('temp', 'Nhiệt độ trụ', '°C', ['temp'], agg='max', dec=0, th=th(None, None, 60, 75)),
        m('busy', 'Trụ đang sạc', '', ['state'], agg='count', dec=0),
    ],
    'overview': [
        {'type': 'kpis', 'items': ['kw', 'kwh', 'sessions', 'rev']},
        {'type': 'tiles', 'title': 'Các trụ sạc', 'main': 'state', 'subs': ['kw', 'soc', 'temp']},
        {'type': 'alarms'},
        {'type': 'trend', 'metric': 'kw', 'title': 'Công suất cả trạm'},
    ],
    'tabs': [
        {'id': 'sessions', 'label': 'Phiên sạc', 'title': 'Phiên sạc & doanh thu', 'icon': 'chart', 'blocks': [
            {'type': 'kpis', 'items': ['sessions', 'kwh', 'rev']}, {'type': 'bars', 'items': ['soc']}, {'type': 'trend', 'metric': 'kwh', 'title': 'Điện năng đã sạc'}]},
    ],
    'demo': {'devices': {
        'c1': {'title': 'Trụ AC-01', 'dec': {'kw': 1}, 'f': {'state': {'sq': [0, 1], 'p': 240, 'duty': 0.7}, 'kw': sin(6.8, 0.4, 50), 'kwh_today': {'cnt': 0.02, 'start': 38}, 'soc': sin(58, 25, 300), 'sessions': 9, 'rev_k': {'cnt': 0.05, 'start': 120}, 'temp': sin(34, 3, 90)}},
        'c2': {'title': 'Trụ DC-02', 'dec': {'kw': 1}, 'f': {'state': 1, 'kw': sin(62, 8, 70, 10), 'kwh_today': {'cnt': 0.2, 'start': 210}, 'soc': sin(68, 22, 260), 'sessions': 14, 'rev_k': {'cnt': 0.5, 'start': 790}, 'temp': sin(52, 6, 90)}},
        'c3': {'title': 'Trụ DC-03', 'dec': {'kw': 1}, 'f': {'state': {'sq': [3, 0], 'p': 200, 'duty': 0.5}, 'kw': 0, 'kwh_today': {'cnt': 0.0, 'start': 164}, 'soc': 0, 'sessions': 11, 'rev_k': 590, 'temp': sin(30, 2, 100)}},
        'c4': {'title': 'Trụ AC-04', 'dec': {'kw': 1}, 'f': {'state': {'sq': [2, 1], 'p': 280, 'duty': 0.9}, 'kw': sin(7, 0.3, 50), 'kwh_today': {'cnt': 0.02, 'start': 52}, 'soc': sin(40, 15, 200), 'sessions': 7, 'rev_k': {'cnt': 0.04, 'start': 160}, 'temp': sin(36, 3, 90)}},
    }},
})

# ---------------------------------------------------------------- 8. Thủy sản
SPECS.append({
    'id': 'aqua', 'title': 'Nuôi trồng thủy sản', 'icon': 'fish', 'style': 'soft', 'themeColor': '#0369a1',
    'palette': pal(['#e1f0fb', '#ffffff', '#0a2a45', '#4f6f8a', '#bcd6ea', '#0369a1'], ['#06162a', '#0b2a47', '#e0f0ff', '#88aed0', '#1a4468', '#5eead4']),
    'metrics': [
        m('do', 'Oxy hòa tan', 'mg/L', ['do_mgl', 'do'], agg='min', dec=1, min=0, max=12, th=th(4.5, 3)),
        m('ph', 'pH', '', ['ph'], agg='avg', dec=2, min=5, max=10, th=th(6.8, 6.5, 8.8, 9.2)),
        m('temp', 'Nhiệt độ', '°C', ['temp_c', 'temp'], agg='avg', dec=1, min=15, max=40, th=th(22, 18, 32, 35)),
        m('sal', 'Độ mặn', '‰', ['sal'], agg='avg', dec=1),
        m('nh3', 'NH₃', 'mg/L', ['nh3'], agg='max', dec=2, min=0, max=1.5, th=th(None, None, 0.5, 1)),
        m('level', 'Mực nước', 'cm', ['level_cm'], agg='avg', dec=0, min=0, max=200, th=th(80, 60)),
        m('aer', 'Quạt nước', '', ['aerator'], **RUN),
        m('feed', 'Thức ăn hôm nay', 'kg', ['feed_kg'], agg='sum', dec=1),
    ],
    'overview': [
        {'type': 'gauges', 'items': ['do', 'ph', 'temp']},
        {'type': 'kpis', 'items': ['sal', 'nh3', 'level', 'feed']},
        {'type': 'state', 'title': 'Thiết bị', 'items': ['aer']},
        {'type': 'alarms'},
        {'type': 'trend', 'metric': 'do', 'title': 'Oxy hòa tan (thấp nhất các ao)'},
    ],
    'tabs': [
        {'id': 'ponds', 'label': 'Ao nuôi', 'title': 'Các ao nuôi', 'icon': 'wave', 'blocks': [{'type': 'tiles', 'main': 'do', 'subs': ['ph', 'temp', 'aer']}]},
        {'id': 'water', 'label': 'Nước', 'title': 'Chất lượng nước', 'icon': 'drop', 'blocks': [
            {'type': 'bars', 'items': ['do', 'ph', 'nh3', 'sal']}, {'type': 'tanks', 'main': 'level'}, {'type': 'trend', 'metric': 'temp', 'title': 'Nhiệt độ nước'}]},
    ],
    'demo': {'devices': {
        'p1': {'title': 'Ao 1', 'dec': {'do_mgl': 1, 'ph': 2}, 'f': {'do_mgl': sin(6.2, 1.0, 180), 'ph': sin(7.8, 0.2, 200), 'temp_c': sin(29, 1.5, 300), 'sal': sin(12, 0.4, 400), 'nh3': sin(0.15, 0.05, 150), 'level_cm': sin(135, 4, 500), 'aerator': {'sq': [0, 1], 'p': 200, 'duty': 0.6}, 'feed_kg': {'cnt': 0.005, 'start': 18}}},
        'p2': {'title': 'Ao 2', 'dec': {'do_mgl': 1, 'ph': 2}, 'f': {'do_mgl': sin(5.6, 1.1, 170, 20), 'ph': sin(8.0, 0.25, 210), 'temp_c': sin(30, 1.5, 320), 'sal': sin(13, 0.4, 420), 'nh3': sin(0.2, 0.06, 160), 'level_cm': sin(128, 4, 520), 'aerator': 1, 'feed_kg': {'cnt': 0.005, 'start': 16}}},
        'p3': {'title': 'Ao 3', 'dec': {'do_mgl': 1, 'ph': 2}, 'f': {'do_mgl': sin(4.8, 1.3, 150, 40), 'ph': sin(8.4, 0.3, 190), 'temp_c': sin(31, 1.6, 300), 'sal': sin(11, 0.4, 380), 'nh3': sin(0.35, 0.1, 140), 'level_cm': sin(110, 5, 500), 'aerator': {'sq': [0, 1], 'p': 160, 'duty': 0.4}, 'feed_kg': {'cnt': 0.004, 'start': 14}}},
    }},
})

# ---------------------------------------------------------------- 9. Bồn bể xăng dầu / hóa chất
SPECS.append({
    'id': 'tank', 'title': 'Bồn bể xăng dầu & hóa chất', 'icon': 'level', 'style': 'sharp', 'themeColor': '#c2410c',
    'palette': pal(['#f4e9e1', '#ffffff', '#2b1708', '#765c48', '#e0cbbb', '#c2410c'], ['#17100b', '#26190f', '#fbeee3', '#c2a58c', '#46301f', '#fb923c']),
    'metrics': [
        m('level', 'Mức bồn', '%', ['level_pct', 'level'], agg='avg', dec=0, min=0, max=100, th=th(15, 8, 90, 95)),
        m('vol', 'Tồn kho', 'L', ['volume_l', 'vol'], agg='sum', dec=0),
        m('temp', 'Nhiệt độ', '°C', ['temp_c', 'temp'], agg='max', dec=1, th=th(None, None, 45, 55)),
        m('press', 'Áp suất', 'bar', ['press_bar', 'press'], agg='max', dec=2),
        m('flow', 'Lưu lượng', 'L/ph', ['flow_lpm', 'flow'], agg='sum', dec=0),
        m('leak', 'Rò rỉ', '', ['leak'], agg='max', map={'0': 'Không', '1': 'RÒ RỈ'}, lv={'0': 'ok', '1': 'bad'}),
        m('valve', 'Van xuất', '', ['valve'], agg='max', map={'0': 'Đóng', '1': 'Mở'}, lv={'0': 'off', '1': 'ok'}),
    ],
    'overview': [
        {'type': 'alarms'},
        {'type': 'tanks', 'title': 'Các bồn chứa', 'main': 'level'},
        {'type': 'kpis', 'items': ['vol', 'flow', 'temp', 'press']},
        {'type': 'state', 'items': ['leak', 'valve']},
        {'type': 'trend', 'metric': 'level', 'title': 'Mức bồn trung bình'},
    ],
    'tabs': [
        {'id': 'stock', 'label': 'Tồn kho', 'title': 'Tồn kho từng bồn', 'icon': 'fuel', 'blocks': [{'type': 'tiles', 'main': 'vol', 'subs': ['level', 'temp', 'press']}]},
        {'id': 'safety', 'label': 'An toàn', 'title': 'An toàn bồn chứa', 'icon': 'bell', 'blocks': [{'type': 'state', 'items': ['leak', 'valve']}, {'type': 'bars', 'items': ['level', 'temp', 'press']}, {'type': 'alarms'}]},
    ],
    'demo': {'devices': {
        'b1': {'title': 'Bồn A - Dầu DO', 'dec': {'level_pct': 0, 'volume_l': 0, 'flow_lpm': 0}, 'f': {'level_pct': sin(68, 6, 400), 'volume_l': sin(34000, 3000, 400), 'temp_c': sin(31, 2, 300), 'press_bar': sin(1.1, 0.05, 90), 'flow_lpm': sin(180, 40, 120), 'leak': 0, 'valve': {'sq': [0, 1], 'p': 240, 'duty': 0.5}}},
        'b2': {'title': 'Bồn B - Xăng A95', 'dec': {'level_pct': 0, 'volume_l': 0, 'flow_lpm': 0}, 'f': {'level_pct': sin(52, 7, 380, 40), 'volume_l': sin(26000, 3500, 380, 40), 'temp_c': sin(33, 2, 280), 'press_bar': sin(1.2, 0.06, 80), 'flow_lpm': sin(150, 30, 110), 'leak': 0, 'valve': 1}},
        'b3': {'title': 'Bồn C - Hóa chất', 'dec': {'level_pct': 0, 'volume_l': 0, 'flow_lpm': 0}, 'f': {'level_pct': sin(14, 3, 300, 10), 'volume_l': sin(2800, 600, 300, 10), 'temp_c': sin(38, 3, 260), 'press_bar': sin(1.5, 0.08, 70), 'flow_lpm': sin(30, 10, 90), 'leak': {'sq': [1, 0], 'p': 600, 'duty': 0.97}, 'valve': 0}},
    }},
})

# ---------------------------------------------------------------- 10. Chiếu sáng thông minh
SPECS.append({
    'id': 'lighting', 'title': 'Chiếu sáng thông minh', 'icon': 'bulb', 'style': 'soft', 'themeColor': '#1d4ed8',
    'palette': pal(['#e8edf8', '#ffffff', '#101b3a', '#56628a', '#c6d0ea', '#1d4ed8'], ['#0a1022', '#121c3c', '#e6ecff', '#93a2d0', '#243566', '#fbbf24']),
    'metrics': [
        m('dim', 'Độ sáng', '%', ['dim_pct', 'dim'], agg='avg', dec=0, min=0, max=100),
        m('lux', 'Ánh sáng tự nhiên', 'lux', ['lux'], agg='avg', dec=0, min=0, max=1000),
        m('on', 'Đèn đang bật', 'đèn', ['lamps_on'], agg='sum', dec=0),
        m('lamps', 'Tổng số đèn', 'đèn', ['lamps'], agg='sum', dec=0),
        m('fault', 'Đèn lỗi', 'đèn', ['lamps_fault'], agg='sum', dec=0, th=th(None, None, 1, 5)),
        m('kw', 'Công suất', 'kW', ['kw'], agg='sum', dec=1),
        m('kwh', 'Điện năng', 'kWh', ['kwh'], agg='sum', dec=0),
        m('saved', 'Tiết kiệm', '%', ['saved_pct'], agg='avg', dec=0),
    ],
    'overview': [
        {'type': 'gauges', 'items': ['dim', 'lux']},
        {'type': 'kpis', 'items': ['on', 'lamps', 'kw', 'saved']},
        {'type': 'tiles', 'title': 'Các tuyến đèn', 'main': 'dim', 'subs': ['kw', 'lux', 'fault']},
        {'type': 'trend', 'metric': 'kw', 'title': 'Công suất chiếu sáng'},
    ],
    'tabs': [
        {'id': 'saving', 'label': 'Tiết kiệm', 'title': 'Tiết kiệm điện', 'icon': 'bolt', 'blocks': [
            {'type': 'kpis', 'items': ['kwh', 'saved', 'kw']}, {'type': 'bars', 'items': ['dim', 'saved']}, {'type': 'trend', 'metric': 'dim', 'title': 'Độ sáng theo lịch'}]},
        {'id': 'faults', 'label': 'Đèn lỗi', 'title': 'Đèn lỗi', 'icon': 'bell', 'blocks': [{'type': 'kpis', 'items': ['fault', 'on']}, {'type': 'alarms'}]},
    ],
    'demo': {'devices': {
        'r1': {'title': 'Đường Nguyễn Huệ', 'dec': {'dim_pct': 0, 'lux': 0, 'kw': 1}, 'f': {'dim_pct': sin(72, 18, 240), 'lux': sin(25, 20, 400), 'lamps_on': 118, 'lamps': 120, 'lamps_fault': {'sq': [2, 1], 'p': 300, 'duty': 0.8}, 'kw': sin(9.4, 1.4, 120), 'kwh': {'cnt': 0.003, 'start': 5300}, 'saved_pct': 34}},
        'r2': {'title': 'Đường Lê Lợi', 'dec': {'dim_pct': 0, 'lux': 0, 'kw': 1}, 'f': {'dim_pct': sin(65, 20, 260, 30), 'lux': sin(30, 22, 420), 'lamps_on': 92, 'lamps': 96, 'lamps_fault': 4, 'kw': sin(7.1, 1.2, 130), 'kwh': {'cnt': 0.002, 'start': 4100}, 'saved_pct': 29}},
        'r3': {'title': 'Công viên trung tâm', 'dec': {'dim_pct': 0, 'lux': 0, 'kw': 1}, 'f': {'dim_pct': sin(50, 22, 280, 60), 'lux': sin(22, 18, 380), 'lamps_on': 58, 'lamps': 60, 'lamps_fault': 0, 'kw': sin(3.2, 0.8, 150), 'kwh': {'cnt': 0.001, 'start': 2200}, 'saved_pct': 41}},
    }},
})

# ---------------------------------------------------------------- 11. Quan trắc môi trường
SPECS.append({
    'id': 'env', 'title': 'Quan trắc môi trường', 'icon': 'wind', 'style': 'glass', 'themeColor': '#4d7c0f',
    'palette': pal(['#edf3e2', '#ffffff', '#1c2a0a', '#5f7340', '#d3deb8', '#4d7c0f'], ['#0f170a', '#1a2810', '#eaf5d8', '#a3b97e', '#2f4420', '#a3e635']),
    'metrics': [
        m('aqi', 'Chỉ số AQI', '', ['aqi'], agg='max', dec=0, min=0, max=300, th=th(None, None, 100, 150)),
        m('pm25', 'Bụi PM2.5', 'µg/m³', ['pm25', 'pm2_5'], agg='max', dec=0, min=0, max=150, th=th(None, None, 35, 75)),
        m('pm10', 'Bụi PM10', 'µg/m³', ['pm10'], agg='max', dec=0, min=0, max=250, th=th(None, None, 50, 100)),
        m('co2', 'CO₂', 'ppm', ['co2'], agg='max', dec=0, min=300, max=2000, th=th(None, None, 1000, 1500)),
        m('temp', 'Nhiệt độ', '°C', ['temp_c', 'temp'], agg='avg', dec=1),
        m('hum', 'Độ ẩm', '%', ['hum_pct', 'hum'], agg='avg', dec=0),
        m('noise', 'Tiếng ồn', 'dB', ['noise_db', 'noise'], agg='max', dec=0, min=30, max=110, th=th(None, None, 70, 85)),
        m('uv', 'Chỉ số UV', '', ['uv'], agg='max', dec=0, min=0, max=12, th=th(None, None, 6, 9)),
    ],
    'overview': [
        {'type': 'ring', 'main': 'aqi', 'subs': ['pm25', 'pm10', 'noise']},
        {'type': 'kpis', 'items': ['temp', 'hum', 'co2', 'uv']},
        {'type': 'tiles', 'title': 'Các trạm quan trắc', 'main': 'pm25', 'subs': ['pm10', 'noise', 'temp']},
        {'type': 'alarms'},
        {'type': 'trend', 'metric': 'pm25', 'title': 'Bụi PM2.5'},
    ],
    'tabs': [
        {'id': 'air', 'label': 'Không khí', 'title': 'Chất lượng không khí', 'icon': 'wind', 'blocks': [
            {'type': 'bars', 'items': ['pm25', 'pm10', 'co2']}, {'type': 'trend', 'metric': 'pm10', 'title': 'PM10'}, {'type': 'trend', 'metric': 'co2', 'title': 'CO₂'}]},
        {'id': 'noise', 'label': 'Tiếng ồn', 'title': 'Tiếng ồn & UV', 'icon': 'bell', 'blocks': [{'type': 'gauges', 'items': ['noise', 'uv']}, {'type': 'trend', 'metric': 'noise', 'title': 'Tiếng ồn'}]},
    ],
    'demo': {'devices': {
        's1': {'title': 'Trạm KCN', 'dec': {'aqi': 0, 'pm25': 0, 'pm10': 0, 'co2': 0, 'noise_db': 0, 'uv': 0}, 'f': {'aqi': sin(92, 25, 220), 'pm25': sin(32, 10, 200), 'pm10': sin(55, 14, 210), 'co2': sin(620, 90, 240), 'temp_c': sin(33, 1.5, 400), 'hum_pct': sin(62, 5, 300), 'noise_db': sin(68, 7, 130), 'uv': sin(6, 2, 500)}},
        's2': {'title': 'Trạm khu dân cư', 'dec': {'aqi': 0, 'pm25': 0, 'pm10': 0, 'co2': 0, 'noise_db': 0, 'uv': 0}, 'f': {'aqi': sin(58, 14, 240, 40), 'pm25': sin(18, 6, 220), 'pm10': sin(32, 8, 230), 'co2': sin(520, 50, 250), 'temp_c': sin(32, 1.2, 420), 'hum_pct': sin(66, 4, 310), 'noise_db': sin(54, 5, 140), 'uv': sin(6, 2, 500)}},
        's3': {'title': 'Trạm ven đường', 'dec': {'aqi': 0, 'pm25': 0, 'pm10': 0, 'co2': 0, 'noise_db': 0, 'uv': 0}, 'f': {'aqi': sin(120, 30, 200, 80), 'pm25': sin(46, 14, 190), 'pm10': sin(82, 18, 200), 'co2': sin(760, 110, 230), 'temp_c': sin(34, 1.6, 410), 'hum_pct': sin(60, 5, 290), 'noise_db': sin(78, 8, 120), 'uv': sin(7, 2, 500)}},
    }},
})

# ---------------------------------------------------------------- 12. Khí nén
SPECS.append({
    'id': 'compressor', 'title': 'Khí nén & máy nén', 'icon': 'compressor', 'style': 'dense', 'themeColor': '#334155',
    'palette': pal(['#e6eaf0', '#ffffff', '#141c28', '#566377', '#c5ced9', '#334155'], ['#0b1018', '#151d2a', '#e4eaf3', '#94a3b8', '#283548', '#38bdf8']),
    'metrics': [
        m('pressure', 'Áp suất', 'bar', ['pressure_bar', 'pressure'], agg='avg', dec=1, min=0, max=12, th=th(5.5, 4.5, 8.5, 9.5)),
        m('flow', 'Lưu lượng', 'm³/ph', ['flow_m3min', 'flow'], agg='sum', dec=1),
        m('kw', 'Công suất', 'kW', ['kw'], agg='sum', dec=1),
        m('load', 'Tải', '%', ['load_pct'], agg='avg', dec=0, min=0, max=100),
        m('temp', 'Nhiệt độ đầu nén', '°C', ['temp_c', 'temp'], agg='max', dec=0, min=20, max=120, th=th(None, None, 95, 105)),
        m('run', 'Trạng thái', '', ['run'], agg='max', map={'0': 'Dừng', '1': 'Chạy tải', '2': 'Không tải', '3': 'LỖI'}, lv={'0': 'off', '1': 'ok', '2': 'warn', '3': 'bad'}),
        m('sp', 'Công suất riêng', 'kW/(m³/ph)', ['sp'], agg='avg', dec=1),
        m('hours', 'Giờ chạy', 'h', ['hours'], agg='sum', dec=0),
        m('dew', 'Điểm sương', '°C', ['dewpoint'], agg='max', dec=0, th=th(None, None, 5, 10)),
    ],
    'overview': [
        {'type': 'gauges', 'items': ['pressure', 'temp', 'load']},
        {'type': 'kpis', 'items': ['flow', 'kw', 'sp', 'hours']},
        {'type': 'tiles', 'title': 'Các máy nén', 'main': 'run', 'subs': ['pressure', 'kw', 'temp']},
        {'type': 'alarms'},
        {'type': 'trend', 'metric': 'pressure', 'title': 'Áp suất mạng khí'},
    ],
    'tabs': [
        {'id': 'eff', 'label': 'Hiệu suất', 'title': 'Hiệu suất năng lượng', 'icon': 'bolt', 'blocks': [{'type': 'kpis', 'items': ['kw', 'sp', 'flow']}, {'type': 'bars', 'items': ['load', 'dew']}, {'type': 'trend', 'metric': 'kw', 'title': 'Công suất'}]},
        {'id': 'maint', 'label': 'Bảo trì', 'title': 'Bảo trì', 'icon': 'gear', 'blocks': [{'type': 'kpis', 'items': ['hours', 'temp']}, {'type': 'alarms'}]},
    ],
    'demo': {'devices': {
        'cp1': {'title': 'Máy nén 1', 'dec': {'pressure_bar': 1, 'flow_m3min': 1, 'kw': 1, 'sp': 1, 'load_pct': 0, 'temp_c': 0, 'hours': 0, 'dewpoint': 0}, 'f': {'pressure_bar': sin(7.2, 0.4, 70), 'flow_m3min': sin(14, 2, 90), 'kw': sin(75, 8, 80), 'load_pct': sin(72, 12, 120), 'temp_c': sin(84, 4, 150), 'run': {'sq': [2, 1], 'p': 200, 'duty': 0.7}, 'sp': sin(5.4, 0.2, 100), 'hours': {'cnt': 0.0003, 'start': 21480}, 'dewpoint': sin(3, 1, 200)}},
        'cp2': {'title': 'Máy nén 2', 'dec': {'pressure_bar': 1, 'flow_m3min': 1, 'kw': 1, 'sp': 1, 'load_pct': 0, 'temp_c': 0, 'hours': 0, 'dewpoint': 0}, 'f': {'pressure_bar': sin(7.1, 0.4, 75, 10), 'flow_m3min': sin(11, 2, 95, 5), 'kw': sin(60, 7, 85), 'load_pct': sin(60, 12, 130), 'temp_c': sin(88, 5, 160), 'run': {'sq': [0, 1], 'p': 300, 'duty': 0.8}, 'sp': sin(5.6, 0.2, 110), 'hours': {'cnt': 0.0003, 'start': 17200}, 'dewpoint': sin(4, 1, 210)}},
    }},
})
