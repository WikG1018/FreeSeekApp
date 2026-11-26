# 开发与构建

[项目首页](../../README.md) · [使用指南](user-guide.md)

## 环境

- Node.js 24、pnpm 10。项目的锁文件为 `pnpm-lock.yaml`。
- 构建 Android 还需 JDK 21 与 Android SDK 37。Gradle 版本由工程内的 Wrapper 管理。
- 构建 Windows x64 安装包请在 Windows 执行。较短的 checkout 路径有助于避免打包工具遇到路径长度限制。

## 网页与静态部署

在工程根目录安装依赖并启动开发服务器。

```sh
pnpm install --frozen-lockfile
pnpm dev
```

访问终端显示的本地地址。执行 `pnpm build` 会生成完整的 `dist/`。将整个目录部署到 HTTPS 静态站点，包括脚本、字体、图标、manifest、Service Worker 和 `web-version.json`。生产网页可部署在子路径下，资源使用相对路径。

项目提供 [GitHub Pages 工作流](../../.github/workflows/pages.yml)。自己托管时，在仓库 Pages 中选 GitHub Actions 为来源，然后运行 **Deploy GitHub Pages**。浏览器站点地址改变后会使用新的存储空间，请从旧站点导出聊天 ZIP 再迁移。模型接口的跨域授权由相应服务配置。

## Android

构建 Web 资源并同步到 Android 工程。

```sh
pnpm build
pnpm exec cap sync android
```

在 Windows 上用 PowerShell 构建调试包。

```powershell
.\android\gradlew.bat -p android :app:assembleDebug
```

在 macOS 或 Linux 上运行以下命令。

```sh
sh ./android/gradlew -p android :app:assembleDebug
```

调试 APK 在 `android/app/build/outputs/apk/debug/`。正式签名配置读取本地的 `android/keystore.properties`，字段为 `storeFile`、`storePassword`、`keyAlias` 和 `keyPassword`。配置妥当后构建 `:app:assembleRelease`，APK 输出在 `android/app/build/outputs/apk/release/`。签名文件和凭据保存在项目托管范围之外。

## Windows

```powershell
pnpm install --frozen-lockfile
pnpm build:windows
```

命令同时构建网页资源和 Electron 客户端，NSIS 安装包位于 `build/windows/`。桌面壳使用当前 Windows 用户的应用数据。测试导入或升级时可给解包后的可执行文件指定单独的 `--user-data-dir`。

## 验证

```sh
pnpm type
pnpm lint
pnpm build
pnpm test:compat
pnpm test:smoke
pnpm exec playwright install chromium
pnpm test
```

| 检查 | 内容 |
| --- | --- |
| `pnpm type` / `pnpm lint` | 类型、静态规则 |
| `pnpm test:compat` | 构建后的旧 WebView 语法和启动脚本 |
| `pnpm test:smoke` | 基础客户端逻辑 |
| `pnpm test` | 浏览器回归，包含对话、模型、导入恢复、语音和更新等流程 |

发布包可进一步校验版本号、APK 证书、安装或覆盖升级、备份恢复和 SHA-256。对于正式 Release，`scripts/update-manifest.mjs` 可按实际 APK 和本版说明生成 `update.json`。如果同时提供 Windows 安装包，清单中的 Windows 附件记录应包含正式下载 URL、大小和 SHA-256。

## 代码入口

| 路径 | 内容 |
| --- | --- |
| [`src/app/`](../../src/app) 和 [`src/components/`](../../src/components) | 应用入口、对话组件、侧边栏和设置 |
| [`src/services/`](../../src/services) | 请求协议、对话、备份、记忆、工具、语音、更新和诊断 |
| [`src/i18n/`](../../src/i18n) | 简体中文和英文界面 |
| [`src/pwa/`](../../src/pwa) | 网页 App 清单、离线外壳和图标 |
| [`android/`](../../android) 和 [`desktop/`](../../desktop) | Android 原生能力与 Windows 桌面壳 |
| [`scripts/test/`](../../scripts/test) | 合成会话与回归用例 |
| [`src/services/chat/history/README.md`](../../src/services/chat/history/README.md) | 备份格式、导入校验和兼容范围 |
