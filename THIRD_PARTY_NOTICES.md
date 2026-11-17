# 第三方组件与许可

## 代码

- **chat-demo** — DeepSeek 官方开源聊天前端（MIT License）。本项目 fork 并二次开发，保留其版权与许可声明。见 [LICENSE](LICENSE)。
- 其余 npm 依赖遵循各自的开源许可（见 `package.json` / `pnpm-lock.yaml`）。
- **apksig** — Android Open Source Project 的 APK 签名验证库，Apache License 2.0；用于应用内更新包的密码学签名验证。

## 字体

- **MiSans** — 小米科技有限责任公司。本项目在界面中使用 MiSans 字体（Regular / Medium / Semibold 三档 woff2），遵循《MiSans 字体知识产权许可协议》：
  - 已在应用内「设置 → 关于」与「字体大小」页注明使用了 MiSans 字体；
  - 未对字体文件进行改编或二次开发；
  - 不单独对外分发字体文件本身，仅随应用打包使用。

  许可协议原文：[docs/fonts/MiSans-License.pdf](docs/fonts/MiSans-License.pdf)

## 图标

- 应用图标（一蓝一粉像素鲸鱼）由本项目绘制生成（`scripts/make_icons.py`），不含第三方素材。
