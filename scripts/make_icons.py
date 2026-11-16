# -*- coding: utf-8 -*-
"""生成 FreeSeek 图标：两只像素小鲸鱼（一蓝一粉）。

先按 10 倍尺寸绘制平滑鲸鱼轮廓（圆头、横向双瓣尾鳍、胸鳍、喷水孔），
BOX 下采样到 64 网格形成像素块，再 NEAREST 放大到 1024，保证边缘干净。
"""
from PIL import Image, ImageDraw

BLUE = (37, 99, 235)
BLUE_DARK = (30, 64, 175)
BLUE_BELLY = (191, 219, 254)
PINK = (236, 72, 153)
PINK_DARK = (190, 24, 93)
PINK_BELLY = (251, 207, 232)
EYE = (15, 23, 42)
BG = (239, 246, 255)

GRID = 64
SS = 10  # 超采样倍率
SIZE = 1024


def draw_whales(d: ImageDraw.ImageDraw, s: int):
    def box(x0, y0, x1, y1, color):
        d.ellipse([x0 * s, y0 * s, x1 * s, y1 * s], fill=color)

    def poly(points, color):
        d.polygon([(x * s, y * s) for x, y in points], fill=color)

    def rect(x0, y0, x1, y1, color):
        d.rectangle([x0 * s, y0 * s, x1 * s - 1, y1 * s - 1], fill=color)

    # —— 蓝鲸：头朝右，左上方 ——
    box(12, 15, 44, 34, BLUE)                     # 身体
    box(34, 16, 49, 34, BLUE)                     # 圆头
    poly([(13, 22), (6, 16), (4, 18), (11, 24)], BLUE)   # 尾鳍上瓣
    poly([(13, 27), (6, 33), (4, 31), (11, 25)], BLUE)   # 尾鳍下瓣
    box(15, 24, 43, 34, BLUE_BELLY)               # 腹部
    poly([(27, 30), (34, 29), (30, 36)], BLUE_DARK)       # 胸鳍
    d.ellipse([41 * s, 21 * s, 44 * s, 24 * s], fill=EYE)  # 眼睛
    rect(39, 12, 41, 15, BLUE_BELLY)              # 喷水孔
    rect(40, 8, 42, 12, BLUE_BELLY)
    poly([(39, 8), (40, 6), (41, 8)], BLUE_BELLY)  # 水花

    # —— 粉鲸：头朝左，右下方，略小 ——
    box(24, 38, 52, 54, PINK)                     # 身体
    box(20, 40, 33, 54, PINK)                     # 圆头
    poly([(50, 44), (57, 39), (58, 42), (52, 46)], PINK)  # 尾鳍上瓣
    poly([(50, 48), (57, 53), (58, 50), (52, 46)], PINK)  # 尾鳍下瓣
    box(26, 46, 50, 54, PINK_BELLY)               # 腹部
    poly([(39, 52), (43, 51), (41, 56)], PINK_DARK)       # 胸鳍
    d.ellipse([27 * s, 45 * s, 30 * s, 48 * s], fill=EYE)  # 眼睛


def quantize() -> Image.Image:
    """平滑绘制 → 64 网格像素 → 缩到 56 格居中，四周留 4 格安全区。"""
    high = Image.new('RGBA', (GRID * SS, GRID * SS), (0, 0, 0, 0))
    draw_whales(ImageDraw.Draw(high), SS)
    low = high.resize((GRID, GRID), Image.BOX)
    bbox = low.getbbox()
    content = low.crop(bbox).resize((56, 56), Image.NEAREST)
    canvas = Image.new('RGBA', (GRID, GRID), (0, 0, 0, 0))
    canvas.paste(content, (4, 4), content)
    # 去除下采样产生的半透明杂边：alpha 二值化，保证像素块边缘干净
    px = canvas.load()
    for y in range(GRID):
        for x in range(GRID):
            r, g, b, a = px[x, y]
            px[x, y] = (r, g, b, 255) if a >= 128 else (0, 0, 0, 0)
    return canvas


def render(with_background: bool) -> Image.Image:
    content = quantize().resize((1024, 1024), Image.NEAREST)
    if not with_background:
        return content
    canvas = Image.new('RGBA', (SIZE, SIZE), BG + (255,))
    canvas.paste(content, (0, 0), content)
    return canvas


def rounded_icon(path: str, radius_ratio: float = 0.22):
    img = render(True)
    mask = Image.new('L', (SIZE, SIZE), 0)
    ImageDraw.Draw(mask).rounded_rectangle(
        [0, 0, SIZE, SIZE], radius=int(SIZE * radius_ratio), fill=255
    )
    out = Image.new('RGBA', (SIZE, SIZE), (0, 0, 0, 0))
    out.paste(img, (0, 0), mask)
    out.save(path)


def make_splash(path: str, size: int = 2732):
    img = Image.new('RGB', (size, size), BG)
    mark = render(False).resize((int(size * 0.42), int(size * 0.42)), Image.LANCZOS)
    img.paste(mark, ((size - mark.width) // 2, (size - mark.height) // 2), mark.split()[-1])
    img.save(path, quality=92)


import os

os.makedirs('assets', exist_ok=True)
rounded_icon('assets/icon.png')
render(False).save('assets/logo.png')
make_splash('assets/splash.png')
print('pixel whales generated')
