# -*- coding: utf-8 -*-
"""Bộ icon dùng chung webapp + gateway C# — nguồn duy nhất: icons.json (đại lượng đo + luật chọn) và webapp/icons.js (icon thiết bị).
gen.py gọi module này để sinh:
  webapp/metric-icons.js            PlcQIcons.svg / forMetric / forField (cũng gộp vào webapp/industry-engine.js)
  tools/GatewayApp/Ui/IconData.g.cs  cùng dữ liệu cho GatewayApp (vẽ GDI+ bằng SvgIcon.cs)
  tools/solution-kit/icon-vectors.json  vector kiểm tra chéo: C# (GatewayApp.Tests) và JS phải chọn đúng icon như Python."""
import json
import os
import re
import unicodedata

here = os.path.dirname(os.path.abspath(__file__))
repo = os.path.abspath(os.path.join(here, '..', '..'))
ICONS = json.load(open(os.path.join(here, 'icons.json'), encoding='utf-8'))


def _strip(s):
    s = unicodedata.normalize('NFD', str('' if s is None else s).lower())
    return ''.join(c for c in s if unicodedata.category(c) != 'Mn').replace('đ', 'd')


def norm(s):
    """Nhãn/khoá: thường, bỏ dấu, đ→d, ký tự khác chữ/số → một khoảng trắng (giống hệt JS/C#)."""
    return ' '.join(re.sub(r'[^a-z0-9]+', ' ', _strip(s)).split())


def unorm(s):
    """Đơn vị: thường, bỏ dấu, bỏ khoảng trắng (giữ ký hiệu ° ³ µ / %)."""
    return re.sub(r'\s+', '', _strip(s))


def icon_for(m):
    """Mã icon đại lượng cho một chỉ số {id,label,unit,keys,map} — luật icons.json theo thứ tự, khớp đầu tiên thắng."""
    keys = ' '.join((k[0] if isinstance(k, list) else k) for k in (m.get('keys') or []))
    f = {'label': norm(m.get('label')), 'key': norm(keys), 'unit': unorm(m.get('unit')),
         'map': norm(' '.join((m.get('map') or {}).values()))}
    f['any'] = ' '.join(x for x in (f['label'], f['key'], norm(m.get('id'))) if x)
    f['state'] = f['any'] if m.get('map') else ''
    for fld, rx, ic in ICONS['rules']:
        if f[fld] and re.search(rx, f[fld]):
            return ic
    return 'chart'


def device_icons():
    """Icon THIẾT BỊ (nét 48×48) lấy nguyên từ webapp/icons.js để gateway vẽ đúng hình như webapp."""
    src = open(os.path.join(repo, 'webapp', 'icons.js'), encoding='utf-8').read()
    block = src[src.index('const DEVICE = {'):src.index('const CATALOG')]
    return {m.group(1): m.group(2) for m in re.finditer(r"^\s{4}(\w+): \(\) => S\(`(.*?)`\),?\s*$", block, re.M)}


def metric_icons_js():
    q = json.dumps(ICONS['q'], ensure_ascii=False, separators=(',', ':'))
    rules = json.dumps(ICONS['rules'], ensure_ascii=False, separators=(',', ':'))
    return ("/* Bộ icon ĐẠI LƯỢNG ĐO dùng chung webapp + gateway C# (sinh bởi tools/solution-kit/gen.py từ icons.json — đừng sửa tay).\n"
            " * PlcQIcons.svg(id) → <svg> nét 24×24, màu theo currentColor; PlcQIcons.forMetric({id,label,unit,keys,map}) → mã icon;\n"
            " * PlcQIcons.forField(key, unit, label, kind) cho widget thường. Luật giống hệt bản C# (tools/GatewayApp/Ui/IconData.g.cs). */\n"
            "(function () {\n"
            "  if (window.PlcQIcons) return;\n"
            f"  const Q = {q};\n"
            f"  const RULES = {rules}.map(([f, r, i]) => [f, new RegExp(r), i]);\n"
            "  const strip = (s) => String(s == null ? '' : s).toLowerCase().normalize('NFD').replace(/[\\u0300-\\u036f]/g, '').replace(/đ/g, 'd');\n"
            "  const norm = (s) => strip(s).replace(/[^a-z0-9]+/g, ' ').trim();\n"
            "  const unorm = (s) => strip(s).replace(/\\s+/g, '');\n"
            "  function forMetric(m) {\n"
            "    m = m || {};\n"
            "    const keys = (m.keys || []).map((k) => (Array.isArray(k) ? k[0] : k)).join(' ');\n"
            "    const f = { label: norm(m.label), key: norm(keys), unit: unorm(m.unit), map: norm(Object.values(m.map || {}).join(' ')) };\n"
            "    f.any = [f.label, f.key, norm(m.id)].filter(Boolean).join(' ');\n"
            "    f.state = m.map ? f.any : '';\n"
            "    for (const [fld, re, ic] of RULES) if (f[fld] && re.test(f[fld])) return ic;\n"
            "    return 'chart';\n"
            "  }\n"
            "  const forField = (key, unit, label, kind) => forMetric({ id: key, label, unit, keys: [key], map: kind === 'toggle' ? { 0: 'tắt', 1: 'bật' } : null });\n"
            "  const svg = (id, cls) => `<svg class=\"qi${cls ? ' ' + cls : ''}\" viewBox=\"0 0 24 24\" fill=\"none\" stroke=\"currentColor\" stroke-width=\"1.8\" "
            "stroke-linecap=\"round\" stroke-linejoin=\"round\" aria-hidden=\"true\">${Q[id] || Q.chart}</svg>`;\n"
            "  window.PlcQIcons = { svg, forMetric, forField, has: (id) => !!Q[id], names: Object.keys(Q) };\n"
            "}());\n")


def icon_data_cs():
    def lit(s):
        return '"' + s.replace('\\', '\\\\').replace('"', '\\"') + '"'
    q = ''.join(f'        [{lit(k)}] = {lit(v)},\n' for k, v in ICONS['q'].items())
    dv = ''.join(f'        [{lit(k)}] = {lit(v)},\n' for k, v in device_icons().items())
    rules = ''.join(f'        ({lit(f)}, new Regex({lit(r)}, RegexOptions.CultureInvariant), {lit(i)}),\n' for f, r, i in ICONS['rules'])
    return ("// <auto-generated> Sinh bởi tools/solution-kit/gen.py (icons_gen.py) từ icons.json + webapp/icons.js — đừng sửa tay. </auto-generated>\n"
            "using System.Text.RegularExpressions;\n\nnamespace GatewayApp.Ui;\n\n"
            "/// <summary>Dữ liệu icon dùng chung với webapp: đại lượng đo (nét 24×24), thiết bị (nét 48×48, giống webapp/icons.js) và luật chọn icon.</summary>\n"
            "static partial class IconData\n{\n"
            "    public static readonly Dictionary<string, string> Q = new()\n    {\n" + q + "    };\n\n"
            "    public static readonly Dictionary<string, string> Device = new()\n    {\n" + dv + "    };\n\n"
            "    public static readonly (string Field, Regex Re, string Icon)[] Rules =\n    {\n" + rules + "    };\n}\n")


def vectors(specs):
    out = []
    for spec in specs:
        for mt in spec['metrics']:
            out.append({'m': {k: mt[k] for k in ('id', 'label', 'unit', 'keys', 'map') if k in mt}, 'icon': icon_for(mt)})
    return out
