"""Generate the provisioned Grafana dashboard (edge/grafana/dashboards/plciot.json).

Data schema written by the Node-RED flow into InfluxDB (bucket plc):
  measurement plc         tags site, device   fields inputs, outputs, alarms, mode, run_req, target, conveyor, count, total,
                                              run_s, pump_starts, x0..x7, y0..y7, estop, level_fault
  measurement plc_status  tags site, device   fields online (1/0)
Run:  python tools/gen_grafana.py
"""
import json, os

DS = {'type': 'influxdb', 'uid': 'plciot-influx'}
SEL = 'r.site == "${site}" and r.device == "${device}"'


def flux(field, tail=''):
    return (f'from(bucket: "${{bucket}}") |> range(start: v.timeRangeStart, stop: v.timeRangeStop) '
            f'|> filter(fn: (r) => r._measurement == "plc" and r._field == "{field}" and {SEL}) {tail}')


def panel(id, title, type, x, y, w, h, targets, **extra):
    p = {'id': id, 'title': title, 'type': type, 'datasource': DS, 'gridPos': {'x': x, 'y': y, 'w': w, 'h': h},
         'targets': [{'refId': chr(65 + i), 'datasource': DS, 'query': q} for i, q in enumerate(targets)],
         'fieldConfig': {'defaults': {}, 'overrides': []}, 'options': {}}
    p.update(extra)
    return p


def stat(id, title, x, y, w, field, mappings=None, unit=None, color='text'):
    p = panel(id, title, 'stat', x, y, w, 4, [flux(field, '|> last()')])
    d = p['fieldConfig']['defaults']
    d['color'] = {'mode': 'fixed', 'fixedColor': color}
    if unit: d['unit'] = unit
    if mappings: d['mappings'] = [{'type': 'value', 'options': mappings}]
    p['options'] = {'reduceOptions': {'calcs': ['lastNotNull'], 'values': False}, 'textMode': 'value', 'colorMode': 'value', 'graphMode': 'none'}
    return p


panels = []
i = 1
panels.append(panel(i, 'PLC', 'stat', 0, 0, 4, 4, [
    f'from(bucket: "${{bucket}}") |> range(start: -2m) |> filter(fn: (r) => r._measurement == "plc_status" and r._field == "online" and {SEL}) |> last()'],
    fieldConfig={'defaults': {'mappings': [{'type': 'value', 'options': {'0': {'text': 'Mất kết nối', 'color': 'red'}, '1': {'text': 'Online', 'color': 'green'}}}],
                              'noValue': 'Mất kết nối', 'thresholds': {'mode': 'absolute', 'steps': [{'color': 'red', 'value': None}]}}, 'overrides': []},
    options={'reduceOptions': {'calcs': ['lastNotNull'], 'values': False}, 'colorMode': 'background', 'graphMode': 'none', 'textMode': 'value'})); i += 1
panels.append(stat(i, 'Băng tải', 4, 0, 4, 'conveyor', {'0': {'text': 'Dừng'}, '1': {'text': 'Chạy', 'color': 'green'}, '2': {'text': 'Đủ số lượng', 'color': 'blue'}, '3': {'text': 'E-stop', 'color': 'red'}})); i += 1
panels.append(stat(i, 'Chế độ', 8, 0, 4, 'mode', {'0': {'text': 'Tự động'}, '1': {'text': 'Thủ công', 'color': 'orange'}})); i += 1
panels.append(stat(i, 'Đếm hiện tại', 12, 0, 4, 'count')); i += 1
panels.append(stat(i, 'Mục tiêu', 16, 0, 4, 'target', {'0': {'text': 'Không giới hạn'}})); i += 1
panels.append(stat(i, 'Tổng đếm', 20, 0, 4, 'total')); i += 1

# sản lượng theo giờ: PLC giữ "total" không bao giờ xoá → hiệu số theo giờ
panels.append(panel(i, 'Sản lượng theo giờ', 'barchart', 0, 4, 12, 9, [
    flux('total', '|> aggregateWindow(every: 1h, fn: last, createEmpty: false) |> difference() |> keep(columns: ["_time", "_value"])')],
    options={'xTickLabelRotation': -45, 'legend': {'showLegend': False}}, fieldConfig={'defaults': {'unit': 'short', 'min': 0}, 'overrides': []})); i += 1
panels.append(panel(i, 'Tốc độ (sản phẩm/phút)', 'timeseries', 12, 4, 12, 9, [
    flux('total', '|> aggregateWindow(every: 1m, fn: last, createEmpty: false) |> difference() |> keep(columns: ["_time", "_value"])')],
    fieldConfig={'defaults': {'unit': 'short', 'min': 0, 'custom': {'drawStyle': 'bars', 'fillOpacity': 60}}, 'overrides': []})); i += 1

# đầu vào / đầu ra: mỗi bit một series, dạng timeline
for name, prefix, x in (('Đầu vào X', 'x', 0), ('Đầu ra Y', 'y', 12)):
    flt = ' or '.join(f'r._field == "{prefix}{n}"' for n in range(8))
    q = (f'from(bucket: "${{bucket}}") |> range(start: v.timeRangeStart, stop: v.timeRangeStop) '
         f'|> filter(fn: (r) => r._measurement == "plc" and ({flt}) and {SEL}) '
         f'|> aggregateWindow(every: v.windowPeriod, fn: last, createEmpty: false) |> keep(columns: ["_time", "_value", "_field"])')
    panels.append(panel(i, name, 'state-timeline', x, 13, 12, 8, [q],
                        fieldConfig={'defaults': {'mappings': [{'type': 'value', 'options': {'0': {'text': 'OFF', 'color': 'dark-gray'}, '1': {'text': 'ON', 'color': 'green'}}}]}, 'overrides': []},
                        options={'showValue': 'never', 'mergeValues': True, 'rowHeight': 0.8, 'legend': {'showLegend': False}})); i += 1

panels.append(panel(i, 'Cảnh báo', 'state-timeline', 0, 21, 12, 5, [
    f'from(bucket: "${{bucket}}") |> range(start: v.timeRangeStart, stop: v.timeRangeStop) |> filter(fn: (r) => r._measurement == "plc" and (r._field == "estop" or r._field == "level_fault") and {SEL}) '
    '|> aggregateWindow(every: v.windowPeriod, fn: last, createEmpty: false) |> keep(columns: ["_time", "_value", "_field"])'],
    fieldConfig={'defaults': {'mappings': [{'type': 'value', 'options': {'0': {'text': 'OK', 'color': 'green'}, '1': {'text': 'LỖI', 'color': 'red'}}}]}, 'overrides': []},
    options={'showValue': 'never', 'mergeValues': True, 'legend': {'showLegend': False}})); i += 1
panels.append(panel(i, 'Thời gian chạy PLC (giờ)', 'timeseries', 12, 21, 12, 5, [
    flux('run_s', '|> map(fn: (r) => ({r with _value: float(v: r._value) / 3600.0})) |> keep(columns: ["_time", "_value"])')],
    fieldConfig={'defaults': {'unit': 'h', 'decimals': 1}, 'overrides': []})); i += 1


def var(name, label, query, **kw):
    v = {'name': name, 'label': label, 'type': 'query', 'datasource': DS, 'query': query, 'refresh': 2, 'sort': 1, 'includeAll': False, 'multi': False}
    v.update(kw)
    return v


dash = {
    'uid': 'plciot-main', 'title': 'Giám sát PLC', 'tags': ['plciot'], 'timezone': 'browser', 'schemaVersion': 39, 'version': 1,
    'refresh': '5s', 'time': {'from': 'now-6h', 'to': 'now'}, 'editable': False, 'graphTooltip': 1,
    'templating': {'list': [
        {'name': 'bucket', 'type': 'constant', 'query': 'plc', 'hide': 2},
        var('site', 'Nhà máy', 'import "influxdata/influxdb/schema"\nschema.tagValues(bucket: "${bucket}", tag: "site")'),
        var('device', 'Thiết bị', 'import "influxdata/influxdb/schema"\nschema.tagValues(bucket: "${bucket}", tag: "device", predicate: (r) => r.site == "${site}")'),
    ]},
    'panels': panels,
}
out = os.path.join(os.path.dirname(__file__), '..', 'edge', 'grafana', 'dashboards', 'plciot.json')
json.dump(dash, open(out, 'w', encoding='utf8'), ensure_ascii=False, indent=1)
print('wrote', os.path.abspath(out), len(panels), 'panels')
