# 第三方组件与许可

## 代码

- **chat-demo** — DeepSeek 官方开源聊天前端（MIT License）。本项目 fork 并二次开发，保留其版权与许可声明。见 [LICENSE](LICENSE)。
- **Agent 编程和 3D**使用 DeepSeek Harness 的 [dsh-fs-patch](https://github.com/deepseek-ai/deepseek-harness/tree/master/packages/fs/fs-patch) 解析并应用补丁，使用 QuickJS 在本机执行 JavaScript，使用 [Three.js](https://github.com/mrdoob/three.js) 生成和预览 GLB。相关 MIT 许可随安装包保存在 static/third-party。
- **工程差异**使用 [jsdiff](https://github.com/kpdecker/jsdiff) 计算和导出补丁。BSD-3-Clause 许可随安装包保存在 static/third-party。
- **Agent 网页阅读**使用 QuickJS／quickjs-emscripten（MIT）、LinkeDOM（ISC）和 es-module-lexer（MIT）。阅读器及其依赖的许可随安装包保存在 static/third-party。
- **Android 后台任务**使用 Rhino 1.7.15.1（MPL 2.0）。许可随 APK 保存在 assets/third-party/rhino.txt。[对应版本源码](https://github.com/mozilla/rhino/tree/Rhino1_7_15_1_Release)
- 网页资源中的 npm 组件遵循各自的开源许可。正式构建把实际编入客户端的组件许可及随客户端分发的运行库许可放在 `static/third-party`，按组件和版本查阅。Micromark 的对应 2.0.0 组件使用其上游 MIT 许可。
- **apksig** — Android Open Source Project 的 APK 签名验证库，Apache License 2.0；用于应用内更新包的密码学签名验证。

## 字体

- **MiSans** — 小米科技有限责任公司。本项目在界面中使用 MiSans 字体（Regular / Medium / Semibold 三档 woff2），遵循《MiSans 字体知识产权许可协议》：
  - 已在应用内「设置 → 关于」与「字体大小」页注明使用了 MiSans 字体；
  - 未对字体文件进行改编或二次开发；
  - 不单独对外分发字体文件本身，仅随应用打包使用。

  许可协议原文：[docs/fonts/MiSans-License.pdf](docs/fonts/MiSans-License.pdf)

## 图标

- 应用图标（一蓝一粉像素鲸鱼）由本项目绘制生成（`scripts/make_icons.py`），不含第三方素材。
- API 服务商模板图标来自 [Lobe Icons](https://github.com/lobehub/lobe-icons) 的 `@lobehub/icons-static-png` 2.8.0。MIT 许可和 LobeHub 版权声明随应用展示。品牌标识用于辨认服务商。
