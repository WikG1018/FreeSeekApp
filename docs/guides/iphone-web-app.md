# iPhone / iPad：用网页 App 版

FreeSeek 的网页版是一套纯静态站点（`pnpm build` 生成的 `dist`）。把它放到任意 HTTPS 静态托管上，iPhone 就能在 Safari 里「添加到主屏幕」，获得全屏、带图标、可离线的网页 App——不需要 Apple 签名，也不需要 Mac。

## 1. 部署

本仓库自带 GitHub Pages 工作流 [`pages.yml`](../../.github/workflows/pages.yml)，推送到 `master` 即发布：

1. 仓库 **Settings → Pages → Build and deployment → Source** 选择 **GitHub Actions**（公开仓库免费）。
2. 推送到 `master`，或在 Actions 页面手动运行 **Deploy GitHub Pages**。
3. 站点地址形如 `https://<用户名>.github.io/<仓库名>/`。

构建产物里与网页 App 相关的部分：

| 文件 | 作用 |
| --- | --- |
| `manifest.webmanifest` | 应用名、图标、`display: standalone`、`start_url`/`scope` |
| `sw.js` | 离线外壳：预缓存首页，静态产物缓存优先、后台更新 |
| `icons/icon-192.png`、`icons/icon-512.png`、`icons/icon-maskable-512.png` | 主屏幕与启动画面图标 |
| `apple-touch-icon.png` | iOS「添加到主屏幕」用的 180×180 图标 |
| `web-version.json` | 页面内更新检查清单（永不经过 Service Worker 缓存） |

站点可以部署在子路径下（`/仓库名/`）：manifest 的 `start_url`、`scope` 与所有资源路径都是相对路径，不需要改配置。

图标与 manifest 的源文件在 `src/pwa/`，由 `rspack.config.ts` 的拷贝规则原样放进 `dist`。

## 2. 在 iPhone 上安装

1. 用 **Safari** 打开站点地址。必须是 Safari：iOS 上的 Chrome、Edge 只是 Safari 的外壳，不能安装网页 App。
2. 点底部「分享」→「添加到主屏幕」→「添加」。
3. 从主屏幕图标打开就是全屏、无地址栏的 FreeSeek。

第一次在 Safari 里打开时，页面会在首次使用须知之后弹一次「把 FreeSeek 添加到主屏幕」的提示，点「知道了」后不再出现。已经是主屏幕图标打开（standalone）时不会弹。

## 3. 网页版的边界

- **不需要签名**：改完推送即生效。相比之下 [`ios.yml`](../../.github/workflows/ios.yml) 生成的是未签名 `.xcarchive`，要装到设备仍需 Mac + Apple 账号（免费账号 7 天）。
- **没有原生通知**：iOS 只在「已添加到主屏幕」且系统 16.4 以上时支持 Web Push，还需要自建推送服务；当前版本不提供。
- **没有后台任务**：切到后台后请求可能被系统暂停。
- **数据在站点存储里**：聊天、附件和密钥保存在本站点的浏览器存储（IndexedDB / localStorage）。卸载网页 App 或清除 Safari 数据会丢失；没有添加到主屏幕的站点长期不用会被系统清理。建议在「数据管理」定期导出备份。
- **更新方式是刷新**：打开时由 `web-version.json` 提示新版本，刷新即生效，没有安装包升级流程。
- **原生能力降级**：通知、系统保存器、原生分享等在网页端改用浏览器等价能力或直接跳过。
- **模型服务需要允许 CORS**：Android 原生壳走原生网络，网页版受浏览器跨域限制。官方 `api.deepseek.com` 的预检允许 `authorization`、`content-type`，可以直接用；第三方或自建网关要自己配 CORS。

## 4. 相关实现位置

- `src/index.html`：head 里的 manifest / 图标 / iOS meta，Service Worker 注册，iOS 安装引导。原生壳（`Capacitor.isNativePlatform()`）、`file://` 与 http 页面都不注册 Service Worker，避免缓存住旧安装包。
- `src/pwa/sw.js`：导航联网优先、静态产物缓存优先、`web-version.json` 与 `Range` 请求不接管。
- `src/pwa/manifest.webmanifest`、`src/pwa/icons/`、`src/pwa/apple-touch-icon.png`：图标由 `src/assets/logo.png` 生成（白底 + 双鲸，与 Android launcher 一致）。
