# -*- coding: utf-8 -*-
"""生成畅聊 App 图标与启动图：深蓝渐变底 + 白色对话气泡 + 橙色圆点"""
from PIL import Image, ImageDraw

TOP = (30, 58, 138)     # 深蓝
BOTTOM = (59, 130, 246)  # 亮蓝
ORANGE = (249, 115, 22)
WHITE = (255, 255, 255)


def gradient(size):
    img = Image.new('RGB', (size, size))
    d = ImageDraw.Draw(img)
    for y in range(size):
        t = y / size
        color = tuple(int(a + (b - a) * t) for a, b in zip(TOP, BOTTOM))
        d.line([(0, y), (size, y)], fill=color)
    return img


def draw_bubble(d, s, scale=1.0):
    """居中气泡：圆角矩形 + 尾巴 + 三个橙点；scale 控制相对画布大小"""
    cx = s / 2
    w, h = 640 * scale, 414 * scale
    top = cx - h / 2 - 40 * scale
    box = (cx - w / 2, top, cx + w / 2, top + h)
    d.rounded_rectangle(box, radius=min(w, h) * 0.28, fill=WHITE)
    tail = [(cx - w * 0.22, box[3] - 4), (cx - w * 0.02, box[3] - 4), (cx - w * 0.24, box[3] + 110 * scale)]
    d.polygon(tail, fill=WHITE)
    dot_y = top + h / 2
    for i, off in enumerate([-0.125, 0, 0.125]):
        r = 34 * scale
        dx = cx + w * off
        d.ellipse([dx - r, dot_y - r, dx + r, dot_y + r], fill=ORANGE)


def make_logo(path, size=1024):
    img = gradient(size).convert('RGBA')
    d = ImageDraw.Draw(img)
    draw_bubble(d, size)
    mask = Image.new('L', (size, size), 0)
    ImageDraw.Draw(mask).rounded_rectangle([0, 0, size, size], radius=size * 0.22, fill=255)
    out = Image.new('RGBA', (size, size), (0, 0, 0, 0))
    out.paste(img, (0, 0), mask)
    out.save(path)


def make_icon(path, size=1024):
    img = gradient(size)
    d = ImageDraw.Draw(img)
    draw_bubble(d, size)
    img.save(path, quality=95)


def make_splash(path, size=2732):
    img = gradient(size)
    icon = Image.open('assets/icon-source.png').convert('RGB')
    inner = int(size * 0.38)
    icon = icon.resize((inner, inner), Image.LANCZOS)
    mask = Image.new('L', (inner, inner), 0)
    ImageDraw.Draw(mask).rounded_rectangle([0, 0, inner, inner], radius=inner * 0.22, fill=255)
    pos = ((size - inner) // 2, (size - inner) // 2)
    img.paste(icon, pos, mask)
    img.save(path, quality=90)


import os
os.makedirs('assets', exist_ok=True)
make_logo('assets/logo.png')
make_icon('assets/icon-source.png')
make_icon('assets/icon.png')
make_splash('assets/splash.png')
print('assets generated')
