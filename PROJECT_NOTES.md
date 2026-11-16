# 畅聊 FreeSeek — 项目决策笔记

> 本文件是跨会话的持久决策记录（本会话 Hindsight 记忆后端 401 不可用，以此替代）。

## 背景调研结论（2026-11-16）

- DeepSeek 于 **2026-11-12** 开源 [deepseek-ai/chat-demo](https://github.com/deepseek-ai/chat-demo)：纯静态 BYOK 聊天前端（React18 + Zustand + rspack + idb），MIT。**不是服务端**，浏览器直连 api.deepseek.com（Anthropic 兼容 Messages/Files API + ASR/TTS）。
- **2026-11-15/16**：官方 App/网页限额上热搜：>7 天不活跃的长对话不再支持、单次输入约 4 万字、每日额度；5 月底起修改/重生成限次（3~7 次）。来源：IT之家 ithome.com/1/027/597.htm、澎湃 thepaper.cn/newsDetail_forward_34490312、知乎问题 2105339969564827779。App Store 中国区评分 3.8/5。
- 用户需求（App Store 评论原文提炼）：次数自由（反复重生成找灵感是核心玩法）、上下文连续/可继承、大输入、无每日额度、手动模式控制、数据本地可迁移。

## 产品决策

- 定位：**自带 Key 的无限制官方同源客户端**，不做绕过官方限制的灰色手段。
- 用户选择：仅 DeepSeek 官方 API；Android APK + iOS 工程；基于 chat-demo 二开（MIT，保留 LICENSE 并致谢）。
- 品牌名：畅聊 / FreeSeek；包名 `app.freeseek.chat`（可在 capacitor.config.ts 改）。

## 实现要点（截至当前）

- `freeseek/` 独立 git 仓库，baseline commit fc8da2f（fork 自 chat-demo@0.1.1）。
- 存储 key 前缀 `freeseek:`，IndexedDB 名 `freeseek`（与官方 demo 共存不冲突）。
- build 脚本改为跨平台（原 `rm -rf`+`NODE_ENV=` 在 Windows 挂）；rspack.config 用 argv 判断 dev/build。
- **对话接续**：`Session.inherited` 快照（types.ts），`toRequestMessages` 追加 `inheritedMessages` 参数把继承轮次置于最前（reply.ts）；store.ts `startInheritSession/cancelInherit/inheritFrom` 状态；SessionItem 菜单「从这里继续」+ Welcome 提示 chip。ZIP 导出不包含该字段（导入后降级，schema 是白名单校验）。
- **人设库**：`services/personas.ts`（builtin- 前缀不可删改，localStorage `freeseek:personas` + `freeseek:default-persona`）；`Session.persona` 快照，store.ts 请求时 `system: persona.prompt || SYSTEM_PROMPT`；Welcome 选择 chips + `components/personas/PersonaManager` 管理。
- **用量费用**：`services/usage.ts`（db.loadAllSessions 遍历 assistant.usage；北京时区判高峰=工作日9-12/14-18；价格可编辑存 `freeseek:pricing`，默认=2026-11 官方刊例 flash 空闲0.02/1/4 高峰0.04/2/8 元每百万 + 搜索5元/千次）；`components/usage/UsagePanel`（Sider 底部入口）。
- Android：Capacitor 8.6.2，compileSdk 36（本机 SDK 齐全），Manifest 加 RECORD_AUDIO；图标 scripts/make_icons.py 生成 + @capacitor/assets。
- CI：.github/workflows/android.yml（自动 debug APK）、ios.yml（macos runner 出未签名 xcarchive + 工程 zip）。
- 验证：每步 pnpm type/lint/build 全绿；真机 API 联调待用户提供 Key 后进行。

## 品牌与 v1.1.0 UI 重做（2026-11-17）

- 软件名统一英文 **FreeSeek**（zh/en appName、标题、Android 应用名、文档、Release）；包名 `app.freeseek.chat` 不变。
- 新图标：一蓝一粉两只像素小鲸鱼（`scripts/make_icons.py` 用 32 网格 + NEAREST 放大），`@capacitor/assets` 生成 Android 全套；应用内欢迎页复用 `src/assets/logo.png`（rspack 增加 png asset 规则 + env.d.ts 声明）。
- 动效 Token 在 `global.css`：`--fs-duration-fast/base/slow`、`--fs-ease-out/ease-in-out/spring`、`--fs-brand`；支持 `prefers-reduced-motion`。
- 欢迎页：品牌 logo + 问候语 + 单行横向人设条（mask 渐隐）+ 卡片式接续提示 + 分层入场动画。
- 聊天页：SessionView 页面淡入；UserMessage/AssistantMessage 按 `createdAt < 800ms` 播放一次入场；MessageList 增加“回到底部”悬浮按钮（scroll 状态、平滑滚动）。
- 弹窗：Modal 重写为带开合动画的居中对话框，移动端自动变底部 Sheet；`openModals` 改为 `{close}` 数组并导出 `hasOpenModal/closeTopModal` 供返回键使用。
- 抽屉：MobileSider 增加 open/closing 相位，滑出动画结束后卸载；遮罩渐变。
- 返回键：`@capacitor/app` 监听 backButton，优先级 弹窗 → 搜索面板 → 抽屉 → 欢迎页 → exitApp。
- v1.1.0：package.json 1.1.0、Android versionCode 2 / versionName 1.1.0；APK 已在本地构建并发布 GitHub Release。
- 文档：README.zh-CN 全面重写（截图/FAQ/签名）、新增 CHANGELOG.md；截图存 `docs/screenshots/`。

## v1.1.1 官方化改版（2026-11-17）

- 用户反馈三点：启动自动弹设置、上下不沉浸、设置界面需完善；并提供官方 App 截图（首页/抽屉/设置）作为参考。
- **去掉启动自动弹设置**：App.tsx 不再调用 ensureApiKey；首页未配置 Key 时显示轻量 CTA，发送/附件时仍会引导到设置。
- **沉浸式**：index.html 加 `viewport-fit=cover`；capacitor.config 配 `plugins.SystemBars { insetsHandling: 'css' }`（Capacitor 8 内置，注入 `--safe-area-inset-*`）；global.css 定义 `--fs-safe-top/bottom = max(env(), var())`；App 用 SystemBars.setStyle 跟随主题切换状态栏/导航栏图标颜色。
- **设置页重做**：全屏分组卡片（返回圆钮+居中标题），分组 账户/应用/数据/关于；关于含版本（meta application-version）、项目主页/更新日志/许可/上游/反馈；桌面端居中卡片+遮罩。旧 SettingsDialog 的 tab 结构移除。
- **首页**：鲸鱼标识+问候居中，底部输入卡片；提示语「发消息或按住说话」；人设条保留（差异化功能）。
- **抽屉**：移动端全宽，顶部标题搜索框，底部头像用户区（用量/设置）。
- 已知：设置 About 中版本取自构建 meta，dev server 启动时缓存旧版本号，正式构建正确。

## v1.1.2 审核纠偏（2026-11-17）

- 用户审核意见：抽屉不应全屏、按钮太小、设置堆在一页且统一性差、位置信息无必要、私有仓库链接不应出现在应用内。
- **抽屉**：`.drawer` 改为 `min(86vw, 360px)`，右侧圆角 + 阴影，遮罩可点关闭；不再全屏。
- **设置多级**：`settingsDialogState` 改为 `SettingsPageId = home | account | appearance | language | voice | data | about`；SettingsDialog 用路由栈渲染，一级只放导航行，二级页独立标题与返回；`openSettings()` 默认首页。
- **删除位置设置**：移除 LocationSetting 及 location 相关 UI（services/location 仍用于 latestReminder）。
- **移除私有仓库入口**：删除 REPO/CHANGELOG/LICENSE/ISSUES 外链；关于页改为品牌 + 版本 + 本地隐私说明 + 上游 MIT 致谢 + 应用内 MIT 全文（`src/assets/licenseText.ts`）；仅保留 DeepSeek 开放平台外链（申请 Key 必需）。
- **弹窗规范**：Modal 增加 `centered` 变体，删除全部/覆盖导入用居中对话框；Sheet 仅用于人设、用量等。
- **触控**：设置返回 44、发送 40、回到底部 44、人设 Chip 36、抽屉用户操作 44。
- **验证**：E2E 18/18（含半宽抽屉、返回按钮 44、无 GitHub 链接、二级页导航、内嵌许可证）。
- v1.1.2 已构建签名 APK 并发布。

## 已知取舍


- 人设 prompt 整体替换官方 SYSTEM_PROMPT（角色扮演需要）；默认助手=官方原 prompt。
- 继承上下文会整段进入请求（token 花费自理，看板可见）；不做自动摘要。
- iOS 无法在 Windows 本地出包，走 CI + 本地签名（免费 Apple ID 7 天）。
