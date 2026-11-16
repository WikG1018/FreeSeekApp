# -*- coding: utf-8 -*-
"""生成 FreeSeek 图标：两只简约像素小鲸鱼（一蓝一粉，相向而游）。

低分辨率 32×32 网格绘制 → NEAREST 放大到 1024，得到干净的像素边缘。
"""
from PIL import Image, ImageDraw

BLUE = (37, 99, 235)
BLUE_BELLY = (147, 197, 253)
PINK = (244, 114, 182)
PINK_BELLY = (251, 207, 232)
EYE = (15, 23, 42)
BG = (239, 246, 255)  # 极浅蓝底

GRID = 32
SCALE = 1024 // GRID


def draw_whales(d: ImageDraw.ImageDraw, ox: int = 0, oy: int = 0):
    """在 32×32 像素网格上画两只鲸鱼：蓝色朝右，粉色朝左，彼此相望。"""
    def r(x0, y0, x1, y1, color):
        d.rectangle([ox + x0, oy + y0, ox + x1 - 1, oy + y1 - 1], fill=color)

    # —— 蓝鲸（左上方，朝右）——
    d.ellipse([ox + 6, oy + 8, ox + 22, oy + 18], fill=BLUE)          # 身体
    d.polygon(                                                      # 尾鳍
        [(ox + 7, oy + 10), (ox + 3, oy + 6), (ox + 3, oy + 17), (ox + 7, oy + 14)],
        fill=BLUE,
    )
    d.ellipse([ox + 9, oy + 13, ox + 21, oy + 18], fill=BLUE_BELLY)  # 腹部
    r(18, 11, 20, 13, EYE)                                          # 眼睛
    r(11, 4, 12, 5, BLUE_BELLY)                                     # 水柱
    r(12, 2, 13, 4, BLUE_BELLY)

    # —— 粉鲸（右下方，朝左，略小）——
    d.ellipse([ox + 14, oy + 18, ox + 27, oy + 27], fill=PINK)       # 身体
    d.polygon(                                                      # 尾鳍
        [(ox + 25, oy + 19), (ox + 28, oy + 17), (ox + 28, oy + 25), (ox + 25, oy + 22)],
        fill=PINK,
    )
    d.ellipse([ox + 16, oy + 22, ox + 26, oy + 27], fill=PINK_BELLY)  # 腹部
    r(16, 20, 18, 22, EYE)                                          # 眼睛


def whale_layer(with_background: bool) -> Image.Image:
    low = Image.new('RGBA', (GRID, GRID), BG + (255,) if with_background else (0, 0, 0, 0))
    draw_whales(ImageDraw.Draw(low))
    return low.resize((1024, 1024), Image.NEAREST)


def rounded_icon(path: str, radius_ratio: float = 0.22):
    img = whale_layer(True)
    mask = Image.new('L', (1024, 1024), 0)
    ImageDraw.Draw(mask).rounded_rectangle([0, 0, 1024, 1024], radius=int(1024 * radius_ratio), fill=255)
    out = Image.new('RGBA', (1024, 1024), (0, 0, 0, 0))
    out.paste(img, (0, 0), mask)
    out.save(path)


def make_splash(path: str, size: int = 2732):
    img = Image.new('RGB', (size, size), BG)
    mark = whale_layer(False).resize((int(size * 0.42), int(size * 0.42)), Image.LANCZOS)
    mask = mark.split()[-1]
    pos = ((size - mark.width) // 2, (size - mark.height) // 2)
    img.paste(mark, pos, mask)
    img.save(path, quality=92)


import os
os.makedirs('assets', exist_ok=True)
rounded_icon('assets/icon.png')
whale_layer(False).save('assets/logo.png')
make_splash('assets/splash.png')
make_splash('assets/icon-source.png') if False else None
print('pixel whales generated')
