# -*- coding: utf-8 -*-
"""Ghép bản xem thử giống server (webapp/ + solutions/<id>/webapp + inject) vào thư mục đích để mở bằng trình duyệt ở chế độ chạy thử.
   python tools/solution-kit/preview.py <thư_mục_đích> [id ...]   rồi:  python -m http.server 8099 -d <thư_mục_đích>"""
import json, os, re, shutil, sys

repo = os.path.abspath(os.path.join(os.path.dirname(__file__), '..', '..'))
out = os.path.abspath(sys.argv[1])
ids = sys.argv[2:] or sorted(d for d in os.listdir(os.path.join(repo, 'solutions')) if os.path.isdir(os.path.join(repo, 'solutions', d, 'webapp')))
for sid in ids:
    dest = os.path.join(out, sid)
    shutil.rmtree(dest, ignore_errors=True)
    shutil.copytree(os.path.join(repo, 'webapp'), dest)
    sd = os.path.join(repo, 'solutions', sid)
    meta = json.load(open(os.path.join(sd, 'solution.json'), encoding='utf-8'))
    for root, _, files in os.walk(os.path.join(sd, 'webapp')):
        for f in files:
            src = os.path.join(root, f)
            rel = os.path.relpath(src, os.path.join(sd, 'webapp'))
            os.makedirs(os.path.dirname(os.path.join(dest, rel)), exist_ok=True)
            shutil.copy(src, os.path.join(dest, rel))
    p = os.path.join(dest, 'index.html')
    h = open(p, encoding='utf-8').read()
    inj = meta.get('inject', {})
    css = '\n'.join(f'<link rel="stylesheet" href="{x}">' for x in inj.get('css', []))
    js = '\n'.join(f'<script src="{x}"></script>' for x in inj.get('js', []))
    h = re.sub(r'<title>[^<]*</title>', f"<title>{meta['title']}</title>", h)
    h = h.replace('</head>', css + '\n</head>').replace('</body>', js + '\n</body>')
    open(p, 'w', encoding='utf-8').write(h)
print('ok', ', '.join(ids))
