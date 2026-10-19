"""Generate PNG app icons (iOS needs PNG for the home-screen icon). Run: python tools/make_icons.py"""
from PIL import Image, ImageDraw
import os

OUT = os.path.join(os.path.dirname(__file__), '..', 'webapp')

def icon(size, maskable=False):
    s = size * 4
    k = s / 128
    img = Image.new('RGB', (s, s), '#0f766e')      # full-bleed square: iOS rounds it itself
    d = ImageDraw.Draw(img)
    pad = 12 * k if maskable else 0                # extra safe zone for Android maskable
    def P(x, y): return (pad + x * k * (1 - 2 * pad / s), pad + y * k * (1 - 2 * pad / s))
    d.rounded_rectangle([*P(24, 30), *P(104, 98)], radius=8 * k, outline='white', width=int(7 * k))
    for cx, col in ((46, 'white'), (82, '#5eead4')):
        x, y = P(cx, 52); r = 7 * k
        d.ellipse([x - r, y - r, x + r, y + r], fill=col)
    pts = [P(*p) for p in ((38, 80), (54, 80), (62, 68), (72, 88), (80, 80), (90, 80))]
    d.line(pts, fill='white', width=int(6 * k), joint='curve')
    return img.resize((size, size), Image.LANCZOS)

for name, size, m in (('icon-180.png', 180, False), ('icon-192.png', 192, False),
                      ('icon-512.png', 512, False), ('icon-maskable-512.png', 512, True)):
    icon(size, m).save(os.path.join(OUT, name))
    print('wrote', name)
