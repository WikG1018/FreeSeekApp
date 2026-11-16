# FreeSeek

[English](README.md) | **简体中文** · [更新日志](CHANGELOG.md)

**使用自己的 DeepSeek API Key，没有次数限制、没有每日额度、没有“7 天不活跃砍会话”的本地聊天 App。**

基于 DeepSeek 官方开源的 [chat-demo](https://github.com/deepseek-ai/chat-demo)（MIT 协议）二次开发，界面与官方 App 同源，数据全部保存在你的设备上。

<p>
  <img src="docs/screenshots/desktop-welcome.png" width="49%" alt="欢迎页（浅色）" />
  <img src="docs/screenshots/dark-welcome.png" width="49%" alt="欢迎页（深色）" />
</p>
<p>
  <img src="docs/screenshots/mobile-welcome.png" width="24%" alt="手机版首页" />
  <img src="docs/screenshots/mobile-sider.png" width="24%" alt="半宽抽屉与搜索" />
  <img src="docs/screenshots/mobile-settings.png" width="24%" alt="设置一级目录" />
  <img src="docs/screenshots/desktop-about.png" width="24%" alt="关于页（本地许可）" />
</p>

## 为什么做这个

2026 年 11 月 15-16 日起，DeepSeek 官方 App 与网页版因算力紧张实施限额：长对话（超过 7 天不活跃不再支持）、每日使用额度、单次输入约 4 万字上限；此前 5 月底起修改/重新生成次数也被限制到个位数。大量用户在社交平台表达了不满。

FreeSeek 的思路很简单：**自己带 Key，按 token 计费，把限制的权力拿回自己手里。** 没有次数墙、没有每日额度、会话永久保存在本地、随时导出迁移。

## v1.1.2 更新了什么

按 UI 审核报告完成结构纠偏：

- **侧边栏恢复半宽抽屉**：`min(86vw, 360px)` + 右侧圆角，保留可点击遮罩，不再是全屏页面替换
- **设置改为多级页面**：一级目录只放导航行（API 服务 / 外观 / 语言 / 朗读音色 / 数据管理 / 关于），各项进入独立二级页面
- **移除位置信息**设置项
- **移除私有仓库入口**：关于页改为本地隐私说明 + 上游致谢 + 应用内 MIT 许可证全文，不再跳转 GitHub
- 删除/覆盖等危险确认改为居中对话框，不再使用底部 Sheet
- 触控尺寸统一：返回 44、发送 40、回到底部 44、人设选项 36、抽屉底部操作 44

上一版 v1.1.1 带来了沉浸式布局、官方风格首页与设置页初版，详见 [CHANGELOG](CHANGELOG.md)。

## v1.1.3 更新了什么

- **返回键修复**：设置页逐级返回、会话页先回欢迎页、欢迎页双击才退出；不再一按就回桌面
- **会话恢复**：重启 App 回到上次打开的对话
- **图标重绘**：真正的一蓝一粉鲸鱼（横向尾鳍、胸鳍、喷水孔、安全边距）
- **MiSans 字体**：界面全局改用 MiSans（400/500/600 三档），新增「字体大小」设置（小/标准/大/特大）
- **设置细节**：语言选项补图标；API 服务页支持显示/隐藏与清除 Key，并展示当前模型与计费方式

## v1.1.4 更新了什么

- **修复小字体白条**：网页端改为容器等比缩放并补偿尺寸；Android 端使用原生 `WebView.textZoom`（只缩放文字，布局与触控尺寸不变）
- **Token 用量统计**：设置 → 数据 → 用量与费用；会话标题栏显示累计 token；每条回复显示本条消耗
- **API 页登录入口**：新增「登录 DeepSeek 开放平台」，在系统浏览器完成官方登录后回填 API Key（应用不接触账号密码）

## v1.1.5 更新了什么

参考 [dsh-Go](https://github.com/ccch1mneyyy/dsh-Go) 的玻璃悬浮界面：

- 输入栏玻璃材质与展开动效（聚焦时圆角收紧、上浮，多行平滑增高）
- 顶栏改为浮动玻璃胶囊 + 圆键，滚动内容从下方穿过
- 侧边栏玻璃面板、列表边缘渐隐、底部圆键
- 登录说明：dsh-Go 的官方登录依赖其本地 DSH 引擎的 OAuth 回调与账号模型路由，纯静态客户端无法复刻，本应用保留官方平台登录入口

## v1.1.6 更新了什么

- 顶栏改为「静止无渐隐、滚动后浮现」的悬浮玻璃件（桌面与移动端一致）
- 会话页标题胶囊、新对话圆键、会话 token 与单条 token
- 抽屉改为实底 + 右侧圆角 + 列表边缘渐隐，修复背景文字透出
- API 页入口改为「前往 DeepSeek 开放平台创建 API Key」（登录功能暂缓）

## 功能

**继承自官方 chat-demo 的全部能力：**

- 多会话、自动标题、重命名与删除；编辑提问、重新生成与**消息分支**（一个回答可反复生成多个版本，随时切回）
- 流式回答、深度思考、智能搜索（联网）、链接阅读与来源引用
- 附件上传（图/文/PDF 等）、语音输入、回复朗读
- Markdown、代码高亮、KaTeX 公式、Mermaid 图表
- 中英文、深浅色主题、移动端布局、历史记录 ZIP 导入导出

**FreeSeek 新增：**

| 功能 | 说明 |
| --- | --- |
| 🔄 对话接续 | 任意会话菜单里选「从这里继续」，新对话自动携带其全部上下文——官方“对话长度到顶只能割裂重开”的痛点在这里不存在 |
| 🎭 人设与提示词库 | 内置写作助手、翻译专家、编程助手、小红书文案、头脑风暴等人设，可自建；新对话按人设开场 |
| 💰 用量与费用看板 | 按天统计 token 用量与联网搜索次数，按官方刊例价（区分高峰/空闲时段）估算费用，单价可自行修改 |
| 🔓 无限制 | 提问/回答/修改/重新生成次数不限；无每日额度；不清理不活跃会话；输入长度只受 API 上下文（1M tokens）约束 |

> 提醒：无限制 ≠ 免费。FreeSeek 直连 DeepSeek 官方 API，按 token 计费从你的账户余额扣除（flash 模型空闲时段输入约 1 元/百万 tokens，详见 App 内「用量与费用」）。量大的话请留意费用看板。

## 快速开始

### 1. 申请 API Key（约 3 分钟）

1. 打开 [platform.deepseek.com](https://platform.deepseek.com/)，注册并完成实名；
2. 充值（最低充值金额以平台为准，日常聊天几块钱可用很久）；
3. 左侧「API Keys」→ 创建，复制保存（只显示一次）。

### 2. 安装

- **Android**：前往 [Releases](https://github.com/WikG1018/freeseek/releases) 下载 `freeseek-v1.1.6-release.apk` 直接安装（允许未知来源即可）。要求 Android 7.0+。
- **iOS**：需要 Mac + Xcode + Apple ID（免费账号可 7 天自签，付费账号长期使用）。用 GitHub Actions 的 iOS 工作流生成工程后本地签名安装，详见 [iOS 构建说明](#ios-构建说明)。
- **网页版（免安装）**：`pnpm install && pnpm build`，把 `dist/` 部署到任意静态服务器，或直接双击 `dist/index.html`。

### 3. 使用

首次打开 → 设置 → 填入 API Key → 开始聊天。所有数据（会话、附件、Key）仅保存在本机（IndexedDB / localStorage），不会上传到任何第三方服务器；发送对话时内容仅提交给 DeepSeek API。

## 自行构建

需要 Node.js 22.12+、pnpm 10、JDK 21 与 Android SDK（compileSdk 36）。

```sh
pnpm install
pnpm build          # 产出 dist/
npx cap sync android
cd android && gradlew assembleDebug   # Windows 用 .\gradlew.bat
# APK: android/app/build/outputs/apk/debug/app-debug.apk
```

发布正式包（需先配置签名，见下）：

```sh
cd android && gradlew assembleRelease
# APK: android/app/build/outputs/apk/release/app-release.apk
```

### 发布签名（可选）

在 `android/keystore.properties`（**已被 .gitignore 忽略，严禁入库**）中填写：

```properties
storeFile=C:\\path\\to\\release.jks
storePassword=你的密码
keyAlias=你的别名
keyPassword=你的密码
```

存在该文件时 `assembleRelease` 自动使用它签名；否则输出未签名包。

### iOS 构建说明

iOS 平台的生成与签名必须在 macOS 上进行（本仓库未提交 `ios/` 目录）：

- **有 Mac**：`pnpm build && npx cap add ios`，打开 `ios/App/App.xcworkspace`，选择你的开发者团队后运行到 iPhone。
- **没有 Mac**：把仓库推到 GitHub，手动触发 `.github/workflows/ios.yml`，产出未签名 `.xcarchive` 与完整 iOS 工程；再借一台 Mac 用 Xcode 打开签名安装。免费 Apple ID 签名 7 天有效，付费账号（$99/年）可长期使用。

## 数据与隐私

- 会话与附件原件存 IndexedDB，API Key 与设置存 localStorage，全部在本机；
- 历史导入导出（ZIP）不包含 API Key；
- 不内置任何统计、崩溃上报或第三方 SDK。

## 常见问题

**Q：会不会有次数限制？**
A：没有。FreeSeek 只是 DeepSeek API 的客户端，限制只来自 API 的用量计费与并发限制，不再有 App 端的每日额度、修改次数墙或长对话清理。

**Q：对话越聊越长会不会超上下文？**
A：DeepSeek 当前模型上下文为 1M tokens。FreeSeek 的「从这里继续」可以把一个会话的上下文带入新会话，避免单会话无限增长的界面管理问题。

**Q：数据会丢吗？**
A：数据存在浏览器/WebView 的本地存储中。建议定期在「设置 → 数据管理」导出 ZIP 备份；卸载 App 或清除存储会删除本地数据。

**Q：iOS 能像安卓一样直接装 APK 吗？**
A：不能。iOS 必须经过 Apple 签名（免费账号 7 天、付费账号长期），这是系统限制，不是 App 的问题。

## 字体与第三方许可

- 界面字体为 [MiSans](https://hyperos.mi.com/font/)（小米），按《MiSans 字体知识产权许可协议》使用，本应用已在「设置 → 关于」中注明；许可原文见 [docs/fonts/MiSans-License.pdf](docs/fonts/MiSans-License.pdf)。
- 代码基于 DeepSeek 官方开源 chat-demo（MIT），详见 [LICENSE](LICENSE) 与 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)。

**Q：为什么没有“账号登录”？怎么登录 DeepSeek 官方？**
A：本应用基于官方开源的 chat-demo，它本身不包含账号体系（BYOK，直接用 API Key）。官方 App 的登录是其私有账号系统（手机号等），并未开源。因此我们提供「登录 DeepSeek 开放平台」入口：用系统浏览器打开官方页面完成登录/注册，在控制台创建 API Key 后粘贴回来。应用不接触、不保存你的账号密码。

**Q：字体大小在哪些地方生效？**
A：Android App 使用原生 `textZoom`，只缩放文字、不改变布局，触控尺寸保持不变；网页预览为整体等比缩放。

**Q：token 用量在哪里看？**
A：设置 → 数据 → 用量与费用（每日统计、费用估算、价格设置）；会话标题栏显示该会话累计 token；每条回复的操作区显示本条消耗。

## 与官方 chat-demo 的关系 & 许可

本项目 fork 自 [deepseek-ai/chat-demo](https://github.com/deepseek-ai/chat-demo)（MIT License），感谢 DeepSeek 开源。依 MIT 协议分发时保留原许可证（见 [LICENSE](LICENSE)，构建产物中亦会复制到 `dist/LICENSE`）。FreeSeek 为个人自用客户端，与 DeepSeek 官方无隶属关系；请遵守 DeepSeek API 服务条款使用。
