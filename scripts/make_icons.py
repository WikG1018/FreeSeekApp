# -*- coding: utf-8 -*-
"""从 assets/icon-source.png（双鲸图形，透明底）生成全套图标。

产物：
- assets/icon.png / icon-only.png：1024 方形图标（白底）
- assets/icon-foreground.png / icon-background.png：Android 自适应图标图层
- assets/logo.png、src/assets/logo.png：应用内 Logo（透明底）
- assets/splash.png：启动图（白底 + 居中图形）
- android/app/src/main/res/mipmap-*：各密度图标与自适应图层

图形本身是矢量稿导出的 PNG，脚本只做裁剪、缩放与底色合成，不重绘。
"""
from pathlib import Path

from PIL import Image, ImageDraw

ROOT = Path(__file__).resolve().parent.parent
SRC = ROOT / "assets" / "icon-source.png"
NAVY = (23, 43, 73)

# Android 密度 → 传统图标边长 / 自适应图层边长（108dp）
DENSITIES = {
    "mdpi": (48, 108),
    "hdpi": (72, 162),
    "xhdpi": (96, 216),
    "xxhdpi": (144, 324),
    "xxxhdpi": (192, 432),
}


def load_art() -> Image.Image:
    """读入源图并按 alpha 裁掉空白边。"""
    art = Image.open(SRC).convert("RGBA")
    box = art.getbbox()
    return art.crop(box) if box else art


def place(art: Image.Image, canvas: int, width_ratio: float, background) -> Image.Image:
    """把图形按目标宽度比例居中放到方形画布上。"""
    target_w = max(1, round(canvas * width_ratio))
    scale = target_w / art.width
    target_h = max(1, round(art.height * scale))
    scaled = art.resize((target_w, target_h), Image.LANCZOS)
    out = Image.new("RGBA", (canvas, canvas), background)
    out.alpha_composite(scaled, ((canvas - target_w) // 2, (canvas - target_h) // 2))
    return out


def rounded_mask(size: int, radius_ratio: float = 0.22) -> Image.Image:
    mask = Image.new("L", (size, size), 0)
    draw = ImageDraw.Draw(mask)
    radius = round(size * radius_ratio)
    draw.rounded_rectangle([0, 0, size - 1, size - 1], radius=radius, fill=255)
    return mask


def circle_mask(size: int) -> Image.Image:
    mask = Image.new("L", (size, size), 0)
    ImageDraw.Draw(mask).ellipse([0, 0, size - 1, size - 1], fill=255)
    return mask


def with_round_background(art: Image.Image, size: int, width_ratio: float, circle=False):
    """白底圆角/圆形图标：图形画在白色底上，再套形状蒙版。"""
    base = place(art, size, width_ratio, (255, 255, 255, 255))
    mask = circle_mask(size) if circle else rounded_mask(size)
    base.putalpha(mask)
    return base


def main() -> None:
    art = load_art()
    assets = ROOT / "assets"

    # 应用商店/网页用方形图标
    place(art, 1024, 0.72, (255, 255, 255, 255)).save(assets / "icon.png", optimize=True)
    place(art, 1024, 0.72, (255, 255, 255, 255)).save(assets / "icon-only.png", optimize=True)
    # 自适应图层：前景透明、图形落在 66% 安全区内；背景纯白
    place(art, 1024, 0.58, (0, 0, 0, 0)).save(assets / "icon-foreground.png", optimize=True)
    Image.new("RGBA", (1024, 1024), (255, 255, 255, 255)).save(
        assets / "icon-background.png", optimize=True
    )
    # 应用内 Logo（透明底，界面里配白/深色背景都好看）
    logo = place(art, 512, 0.92, (0, 0, 0, 0))
    logo.save(assets / "logo.png", optimize=True)
    (ROOT / "src" / "assets").mkdir(parents=True, exist_ok=True)
    logo.save(ROOT / "src" / "assets" / "logo.png", optimize=True)
    # 启动图
    place(art, 2732, 0.24, (255, 255, 255, 255)).save(assets / "splash.png", optimize=True)

    # Android 各密度
    res = ROOT / "android" / "app" / "src" / "main" / "res"
    for density, (legacy, adaptive) in DENSITIES.items():
        folder = res / f"mipmap-{density}"
        folder.mkdir(parents=True, exist_ok=True)
        with_round_background(art, legacy, 0.66).save(folder / "ic_launcher.png", optimize=True)
        with_round_background(art, legacy, 0.62, circle=True).save(
            folder / "ic_launcher_round.png", optimize=True
        )
        place(art, adaptive, 0.60, (0, 0, 0, 0)).save(
            folder / "ic_launcher_foreground.png", optimize=True
        )
        Image.new("RGBA", (adaptive, adaptive), (255, 255, 255, 255)).save(
            folder / "ic_launcher_background.png", optimize=True
        )

    # 自适应图标描述：去掉旧 inset，并加 monochrome（Android 13 主题图标）
    adaptive_xml = """<?xml version="1.0" encoding="utf-8"?>
<adaptive-icon xmlns:android="http://schemas.android.com/apk/res/android">
    <background android:drawable="@mipmap/ic_launcher_background" />
    <foreground android:drawable="@mipmap/ic_launcher_foreground" />
    <monochrome android:drawable="@mipmap/ic_launcher_foreground" />
</adaptive-icon>
"""
    anydpi = res / "mipmap-anydpi-v26"
    anydpi.mkdir(parents=True, exist_ok=True)
    (anydpi / "ic_launcher.xml").write_text(adaptive_xml, encoding="utf-8")
    (anydpi / "ic_launcher_round.xml").write_text(adaptive_xml, encoding="utf-8")

    print("icons written:", art.size)


if __name__ == "__main__":
    main()
