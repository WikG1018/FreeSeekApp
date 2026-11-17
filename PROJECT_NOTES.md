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

## v1.1.3 细节修复（2026-11-17）

- 用户反馈：Android 返回键直接回桌面、重进不恢复界面、图标像金鱼、缺字体大小、要求全局 MiSans、语言页缺图标、API 页细节不足。
- **返回键**：App.tsx 保留双击退出；设置页内新增 Capacitor backButton 监听，栈式 pop；确认弹窗优先关闭。根因：此前设置页打开时 App 直接 return，未处理返回；且欢迎页返回即 exitApp。
- **会话恢复**：store.ts 新增 `freeseek:active-session`，initChat 恢复 activeId 并 ensureSessionLoaded；subscribe 同步写入。
- **图标**：scripts/make_icons.py 改为 640 平滑绘制 → 64 格 BOX 量化 → alpha 二值化 → 4 格安全边距 → 1024 NEAREST；尾鳍横向双瓣、胸鳍、喷水孔。
- **MiSans**：官方 zip（hyperos.mi.com/font-download/MiSans.zip）提取 woff2 Regular/Medium/Semibold 到 src/assets/fonts；theme.css @font-face + 字体栈；许可 PDF 存 docs/fonts，THIRD_PARTY_NOTICES.md 声明。
- **字体大小**：settings.fontScale（0.85–1.25），body zoom 变量；设置「字体大小」二级页，四档。
- **API 页**：显示/隐藏、清除 Key（确认）、模型/计费说明；语言两行均带图标。
- 验证：E2E 23/23（MiSans check、zoom=1.1、API 掩码/清除、设置返回栈）。

## v1.1.4 缩放修复与用量（2026-11-17）

- 用户反馈：小字体界面有 bug（截图底部大白条）、缺 token 用量显示、API 页要加登录官方。
- **缩放根因**：body zoom 缩小固定定位层；移动端 `.frame` 高度用 100dvh 不随容器缩放。方案：main.tsx 包 `.app-scaler`（fixed + width/height 1/scale + transform scale），移动端 `.frame` 高度改 `100%`；Android 端改用原生 `WebView.textZoom`（FontScalePlugin），CSS 缩放只在非 Android 生效。
- **用量**：UsagePanel 拆出 UsageContent；设置新增 usage 页；SessionView 标题栏累计 token；AssistantMessage 单条 token。
- **登录官方**：新增 @capacitor/browser + openExternal；API 页「登录 DeepSeek 开放平台」；chat-demo 无账号体系，官方 App 登录为其私有账号，未开源；应用不接触密码。
- 验证：E2E 26/26（小字体满屏、缩放无留白、用量入口、API 清除）。

## v1.2.0 可读性与语音权限（2026-11-17）

- 用户真机反馈四点：悬浮层太透明看不清、顶栏左右按钮要加胶囊、回复底部（引用/用量/三个按钮）缩小并合并一行、设置里的价格设置要独立二级页；另加一条「安卓麦克风根本无法开启」。
- **麦克风根因（关键）**：Capacitor `BridgeWebChromeClient.onPermissionRequest` 收到 `AUDIO_CAPTURE` 时同时申请 `RECORD_AUDIO` + `MODIFY_AUDIO_SETTINGS`，`permissionCallback` 要求**全部** granted 才 `request.grant`。Manifest 之前只声明了 RECORD_AUDIO，未声明的 MODIFY_AUDIO_SETTINGS 必然返回 denied → 整体 deny → `getUserMedia` 直接 `NotAllowedError`。修复：Manifest 补 `MODIFY_AUDIO_SETTINGS`，并加原生 `MicPermissionPlugin`（check/request/openSettings）在录音前显式申请，被拒时弹「去设置」而不是只 toast。改权限后必须重新安装 APK（覆盖升级不会自动补权限）。
- **玻璃件可读性**：WebView 对 `backdrop-filter` 支持不稳定，仅靠模糊会让正文透过输入栏/标题。改为在 `global.css` 定义 `--fs-glass-bg/strong/border/shadow`（浅 0.95/0.985、深 0.95），输入栏、顶栏胶囊统一引用；手机端输入栏再升到 strong。设计上仍保留玻璃观感（描边 + 阴影 + 轻模糊），但可读性优先。
- **顶栏渐隐**：由「58% 实色渐变」改为「`inset: 0 0 -16px` 实底 + mask 只渐隐溢出部分」，保证胶囊所在区域永远是实底；滚动时正文不会压在胶囊上。
- **回复底部工具行**：`AssistantMessage` 的 `.footer` 单行 flex（引用 chip / 用量 chip / 操作按钮，`margin-left:auto`）；用量胶囊高 26、字号 11，摘要改为「20.1k tok · ¥0.043」（`usageMessageCompact`），展开仍给 4 项明细，用 `order:10` + `flex-basis:100%` 保证明细换行而不挤走操作按钮。触屏（<768px）操作按钮常显，避免历史消息无法复制。
- **价格设置二级页**：`PricingForm`（`components/usage`）按空闲/高峰/联网搜索分组，输入失焦即写入 `freeseek:pricing` 并 toast「已保存」，底部「恢复默认」；用量页只留一行入口（官方默认 / 自定义），弹窗版用量面板也跳转到该二级页，不再内联表单。
- 验证：E2E 26/26 + 用量 18/18；APK `aapt dump permissions` 已确认 RECORD_AUDIO + MODIFY_AUDIO_SETTINGS；versionCode 12 / versionName 1.2.0。

## v1.2.1 全面 UI/动效审查（2026-11-17）

用户要求全面审查完善，重点前端 UI 与动效。逐组件过一遍后的结论与修复：

- **动效体系**：此前只有入场动画（Modal dialogIn/sheetIn、Settings pageIn、Toast enter、Drawer drawerIn），关闭全部瞬间消失。v1.2.1 补全退出：Modal 内部 `closing` 状态（`requestClose` 播放 200ms 退出后调 `onClose`，`openModals` 栈走同一入口，Esc/遮罩/返回键都有动画；父组件直接卸载仍瞬时）；Settings 加 `closing` 相位 + `finishCloseSettings`（onAnimationEnd + target 判断，pageBodyIn 冒泡不算）；Toast 在 toastState 里带 `duration`，CSS `toastOut` 用 `--toast-exit-delay` 变量延迟到时前 180ms 渐隐。
- **触觉/焦点反馈**：所有可点元素统一 `:active` 缩放（Button 0.97 / IconButton 0.92 / 胶囊 0.96-0.97）+ `:focus-visible` 2px 焦点环。验证方式：Playwright 连按 Tab 检查 `document.activeElement` 的 computed boxShadow。
- **真 bug 两处**：Settings `.apiKeyInput` 重复定义（后者把 `padding-right:38px` 覆盖成 12px，文字压在眼睛按钮下）；MobileHeader `.title` 用 flex 容器导致 `text-overflow: ellipsis` 无效（长标题不省略），改 `display:block; line-height:42px`。
- **触屏可达性**：UserMessage `.actions` 此前 hover 才显示（触屏历史消息无法编辑/复制），加 `@media not all and (min-width:768px) { opacity:1 }`，与 AssistantMessage 一致。
- **一致性**：底部工具行三件统一 28px；抽屉用户区圆键改 `--fs-glass-*` token；PersonaManager 按钮 ≥32px；桌面 Settings 显示细滚动条；搜索面板移动端 slide-in（panelIn）。
- **验证脚本**：`.e2e/motion-check.mjs`（7 项：Sheet 抓手/退出动画、用量弹窗退出、Settings 退出、Toast 样式）与 `.e2e/ui-audit.mjs`（12 项：溢出、省略号裁剪、玻璃不透明度、工具行对齐、遮挡间距、焦点环、深浅色）。注意省略号断言：`scrollWidth > clientWidth` 在 overflow:hidden 下是正常裁剪，不能当失败，要断言 `overflowX==='hidden' && textOverflow==='ellipsis'` 且元素不撑破父容器。
- 截图像素体检：PIL 算均值/方差防白屏（当前模型无图像输入，用此法 + DOM 计算样式审计替代肉眼看图）。

## v1.2.2 顶栏对齐修复与项目信息更新（2026-11-17）

- 用户反馈（附截图）：手机版「顶部标题和胶囊错位」，且明确**手机版是重点、不在乎网页版**；要求把项目信息更新好。
- **根因**：v1.2.1 修省略号时把 `.title` 改成 `display:block; line-height:42px`，但 `line-height` 声明在 `font: var(--dsw-font-s-strong-14)` **之前**——`font` 简写会重置 line-height 为 token 的小值，于是 14px 文字按小行高排、贴在 44px 胶囊顶部，看起来就是"标题和胶囊错位"。教训：**`font` 简写必须放在 line-height 之前，或干脆不用简写**。
- **修复**：`.title` 用 `display:flex; align-items:center`，文字放内层 `span.titleText`（`min-width:0 + overflow:hidden + text-overflow:ellipsis`）——垂直居中不依赖 font 简写顺序，省略号在内层 span 上生效。Playwright 实测：文字中心 = 胶囊中心 = 左右圆键中心 = 29px，偏差 0。
- **项目信息**：README 中/英把 v1.1.2~v1.1.8 的逐版本流水换成「当前版本」摘要（CHANGELOG 有全史）；安装链接改 `releases/latest`（不再硬编码会过期的文件名）；`docs/screenshots` 用本版重拍（mobile-welcome / mobile-chat-footer / mobile-usage / mobile-pricing / dark-mobile-chat / mobile-sider / mobile-settings / desktop-chat + 备用图），删 9 张陈旧图；FAQ「token 用量在哪里看」更新为当前路径（每条回复工具行 + 设置 → 用量与费用 + 价格二级页）。
- 截图脚本陷阱再现：`.e2e/docs-shots.mjs` 里 OUT 用了相对路径 `freeseek/docs/screenshots`，而脚本在 freeseek 目录下执行 → 写到了 `freeseek/freeseek/...`。已移动并清理。**教训：脚本内输出路径一律用绝对路径或相对脚本位置解析。**
- 今后方向以手机版为第一优先级，桌面仅保持可用。

## v1.2.2 手机版三连修（2026-11-17）

用户连续三条真机反馈（带头像截图），明确「只在手机版、网页版不重要」：

1. **顶栏标题与胶囊错位**：根因是 v1.2.1 把 `line-height:42px` 写在 `font:` 简写**之前**，简写把行高重置回 token 小值，文字顶在胶囊上部。修复：`.title` 用 `display:flex; align-items:center`，文字放内层 `span.titleText` 做省略号（flex 容器自身 text-overflow 无效）。实测中心偏差 0px。
2. **用量展开面板向右突出**：`.details` 只写了 `flex: 0 0 100%`，缺 `box-sizing: border-box` → padding 24 + border 2 把面板撑出正文列 26px。加 box-sizing 后右边缘精确对齐正文列（370 = 370）。
3. **输入栏按钮过大 + 不要发送键**：用户先要求去掉发送键（回车发送），随后修正为「开始时与麦克风合并一个按钮，输入文字后变发送」。实现：手机 `.right` 只保留「附件 + 主操作槽位」，槽位按状态切换 麦克风 → 发送 → 停止；桌面保留三键。尺寸：开关 36→30、圆键 34→30/32、`functionRow` padding 12→8/12/10；`textarea` 加 `enterKeyHint="send"`。E2E 实测：空输入仅「附件+语音输入」、输入后出现「发送」、回车真的清空草稿并发消息。
4. **附件入口改为 + 展开面板**：新增 `IconAddOutline16/Camera/Image/File` 四个图标（16px 填充风格，与现有图标一致）；`+` 点击展开 拍照/相册/文件 三个等宽入口（拍照用 `capture="environment"` 直接调相机），选完或点外部（document pointerdown 判定 wrapper 外）自动收起，展开时图标变 ×、`aria-expanded` 同步。面板用 grid 三等分 + `attachIn` 入场动画。
- **CSS 顺序坑（本次踩两次）**：媒体查询**不增加优先级**，放在基础规则之前的移动端覆盖会被后面的基础规则覆盖。ChatInput/VoiceButton 的手机尺寸规则统一移到文件末尾，并注释说明。另有一次性把媒体块插进原媒体块内部导致花括号错位，已修复。
- 验证：新增 `.e2e/composer-audit.mjs`（8 项：面板不溢出、空输入/输入后/回车发送/开关高度）与 `.e2e/attach-audit.mjs`（9 项：展开三入口、aria-expanded、三个 input 的 accept/capture、点外收起、选文件收起、面板不溢出、等宽）。全量：26+18+7+12+8+9 通过。
- 文档：README 中英图库改为手机 8 图（含附件面板），删除桌面图；`docs-shots.mjs` 输出路径改为 `join(process.cwd(), 'docs/screenshots')`（此前相对路径导致写到 freeseek/freeseek）。

## v1.3 账号与计费（进行中，2026-11-17）

用户明确：**只做手机版（Android App），网页版不作为设计目标**；付费要**直接跳转支付宝**，不要二维码（二维码是网页/桌面才需要的形态）。因此：

- 支付只保留「手机网站支付 alipay.trade.wap.pay」：服务端签名出收银台 URL，App 用系统浏览器打开 → 唤起支付宝 App；不实现 precreate 二维码。
- 服务端只存账号/余额/订单/用量计数，**不保存对话内容**；上游 Key 只在服务端。
- 登录非强制：默认仍是自带 Key，登录后切换到账号额度。

## v1.3.0 账号与付费（2026-11-17）

用户需求：注册登录 + 余额付费，流量走自己的 API Key 路由，价格官方价 +10%，登录非强制，不保存云端对话，要安全。

- **产品选择（用户确认）**：支付宝**手机网站支付**（直接跳转，不做二维码——只做手机版）；本地先跑通；附件走代理计费、语音代理不计费但限每日次数。
- **架构**：新增 `server/`（Node 22+，零第三方运行时依赖：node:sqlite / node:crypto / fetch）。客户端默认仍是自带 Key 直连；登录后 `services/account.ts` 把 `apiOrigin` 切到服务端，凭证用会话令牌（复用 `x-api-key` 头），API 层无需感知两种模式（`services/api/runtime.ts` 保存运行时地址）。
- **计费**：服务端解析 SSE 的 `message_start` / `message_delta` 用量，按官方价 ×1.1（`PRICE_MARKUP`）计费，微元整数记账；请求前要求余额 > 0，流结束后在 finally 中扣费（客户端断开也照扣，符合上游实际成本）。附件本身不计费，进入上下文后按输入 token 计。
- **支付**：`alipay.trade.wap.pay` 用 RSA2 自签收银台 URL（无 SDK）；异步通知验签 + 校验 app_id/订单号/金额；`/confirm` 主动查单兜底；`creditOrder` 用 BEGIN IMMEDIATE 原子流转订单状态防重复入账。mock 模式给「模拟支付」按钮。
- **安全**：scrypt 密码哈希；令牌只存 SHA-256；对话内容不落盘（单测遍历所有表断言没有提问/回复文本）；CORS 白名单；登录/注册按 IP、对话按用户、语音按日限流；卡密只存哈希；订单/账单按 user_id 过滤。**坑**：`applyBalance` 自带事务，在 `creditOrder` 的 tx 里再调用会嵌套事务报错 → 拆出 `applyBalanceTx`。
- **客户端**：设置页「API 服务」改为「账号与 API Key」：使用方式切换（账号余额/自带 Key）、服务地址、登录/注册、余额卡、充值、卡密、账单、退出登录；欢迎页与 `ensureApiKey` 都按模式判断凭证；回复结束后自动刷新余额；401 清理会话回到 Key 模式；402/401 的错误提示在账号模式下改为「余额不足/登录过期」并给「去处理」。
- **构建期**：新增 `ACCOUNT_ORIGIN` define，打包时可预填服务端地址（`ACCOUNT_ORIGIN=https://api.x.com pnpm build`）。
- **验证**：服务端 22 项单测（计价/鉴权/幂等/验签/不保存对话/语音配额）+ 客户端新增 `account-check.mjs` 7 项（注册→模拟充值→账号模式对话→余额扣减 29.86→账单→退出）；原有 26+18+7+12+8+9 全绿。


## v1.4.0 移除账号、API 教学、打赏（2026-11-17）

用户决定去掉账号登录功能，回到纯 BYOK；API 填写页加入应用内打开官方充值/新建 API Key 页面 + 教学；新增打赏开发者。

- **移除方式**：客户端相关文件 `git checkout v1.2.2 --`（client.ts/speech.ts/store.ts/describe.ts/AssistantMessage/ChatInput/Welcome/SettingsDialog/settingsDialogState/main.tsx/env.d.ts/rspack.config.ts/i18n 中英文），删除 `src/components/account/`、`src/services/account.ts`、`src/services/api/runtime.ts`、`server/`、账号截图；杀掉 8788 本地 mock 服务。**教训：替换 old_string 里带 `<Section>` 开标签时会把开标签一起吞掉，产生语法错误——补丁后必须立刻 typecheck。**
- **教学**：`ApiTutorial` 组件（AccountPage 顶部）：四步 ol + 双按钮（应用内 Browser 打开 top_up / api_keys）；原「登录官方」单链并入这两个直达入口。
- **打赏**：About 页「支持开发者」分组 → `DonateDialog`（居中弹窗 + 二维码图片）。二维码是 PIL 生成的**占位图**（伪 QR 图案），换收款码只需替换 `src/assets/donate-qr.png`，无需改代码。
- E2E：check.mjs 扩到 31 项（四步教学文案、两个直达入口、按钮真实打开 platform.deepseek.com（网页端 window.open popup 断言）、打赏入口与二维码可见）。


## v1.4.1 打赏入口与求打赏动画（2026-11-17）

用户要求：打赏功能放在侧边栏底部按钮上方，加求打赏动画。

- `DonateDialog` 迁到独立组件 `components/donate/`（设置页 About 的入口移除，避免重复）。
- Sider `.bottom` 改纵向排列：打赏行在最上（移动端在用户区上方、桌面在用量/设置两行上方）；原 `height:64px + margin-block:auto` 居中方案改为内容高度 + padding。
- 动画两层：`.donateHeart` heartBeat 1.8s（两连跳节律）持续跑；`.donate donatePlead` 6s 周期在 4%–24% 区间 rotate ±1.6° 撒娇；`.donatePlea` pleaPulse 与撒娇同刻 1.12× 呼吸。文案「请我喝杯奶茶 🧋」（i18n donatePlea）。
- E2E：check.mjs 35 项——打赏入口存在、几何位于底部按钮上方（donateBottom ≤ usageTop）、三个动画的 computed animationName、弹窗二维码。**教训：桌面流程里不能点「打开边栏」（移动端专属按钮），断言放移动段。**


## v1.4.2 三处反馈（2026-11-17）

1. **API 页两套入口**：`ApiTutorial` 与下方「API 服务」Section 各有两个直达 Row → 删掉 Section 里那组，保留教学卡片（上下文更强）。
2. **打赏自动化**：新增原生 `DonatePlugin`：
   - `saveImage(base64)`：Android 10+ 用 MediaStore 写入 `Pictures/FreeSeek`（无需权限），低版本才申请 WRITE_EXTERNAL_STORAGE（manifest 里 maxSdkVersion=28）
   - `openApp(target)`：先按包名 `getLaunchIntentForPackage`，失败再试 scheme（alipays:// / weixin://）
   - **关键坑**：Android 11+ 包可见性——不加 `<queries>` 时 `getLaunchIntentForPackage` 恒为 null，表现为「跳转永远失败」；已加两个 package 声明。
   - 前端 `services/donate.ts` 统一封装，网页端退化为新标签页 + 长按保存提示；弹窗内分步显示「存相册/开应用」结果。
   - 为什么不能「带金额直达转账页」：个人收款码不是商户订单，没有官方深链；商户号才有的 `alipay.trade.wap.pay` 已在 v1.3 被移除。
3. **人设收起**：新增 `PersonaPicker`（一行触发 + Modal 选项栏，移动端自动成 Sheet），Welcome 删除平铺 chips 与相关 CSS；e2e 同步（motion-check 先开选择器再点管理人设；ui-audit 改为断言选择器存在）。


## v1.5.0 真实收款码 + 应用内更新（2026-11-17）

- **二维码裁切**：用户给的宣传图带绿色/蓝色外框和文字。用「暗像素行投影 + 合并头像空隙 + 以宽度定正方形」裁出二维码，再用 OpenCV `QRCodeDetector` 解码验证：
  - 微信 `wxp://f2f0z87084tDt0A_ZaDHLTX5W1J5Fb3y-8W8DCT4jaqn2HE`
  - 支付宝 `https://qr.alipay.com/fkx10702mjvxw5lrmexj364`
  解码出的就是收款页深链——比「只存图让用户自己扫」体验好得多。**教训：裁 QR 必须保留静区（约 20px）否则部分机型扫不出。**
- **更新**：`services/update.ts`（多源 + 缓存 + 语义化版本比较 + 预下载）+ 原生 `UpdatePlugin`（流式下载到 `getExternalFilesDir/updates`、FileProvider 安装、进度事件、系统下载器兜底）+ 侧边栏入口 + 关于页区块。镜像前缀按顺序回退，全部失败才报错。
- 坑：FileProvider 必须加 `<external-files-path name="updates" path="updates/"/>`，否则安装器拿不到 URI；Android 8+ 还需 `canRequestPackageInstalls` 检查并跳「安装未知应用」授权页。
- E2E：`update-check.mjs` 用 Playwright `route` 模拟 GitHub Release（v9.9.9），断言自动检查写缓存、侧边栏入口、关于页版本与更新说明弹窗；check.mjs 42 项全过。

## 已知取舍


- 人设 prompt 整体替换官方 SYSTEM_PROMPT（角色扮演需要）；默认助手=官方原 prompt。
- 继承上下文会整段进入请求（token 花费自理，看板可见）；不做自动摘要。
- iOS 无法在 Windows 本地出包，走 CI + 本地签名（免费 Apple ID 7 天）。
