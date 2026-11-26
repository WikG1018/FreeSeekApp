# 2.5.0 界面与系统栏验收

Android 聊天画布延伸到透明状态栏与导航栏，抽屉和遮罩共享画布高度。原生窗口将四边安全距离传入页面，键盘只在原生层扣除一次。WebView 74 和新版 WebView 使用相同的边距来源，菜单、输入框和抽屉底部按钮保留触控空间。[Android 边到边布局](https://developer.android.com/develop/ui/views/layout/edge-to-edge) · [WebView 系统栏与键盘](https://developer.android.com/develop/ui/views/layout/webapps/understand-window-insets)

手机设置从目录进入二级页面，宽屏保留目录。API 页从原四步教程开始，接着配置官方密钥、选择模型，最后进入高级自定义。教程支持手动收起。界面返回时恢复父页位置，未保存的编辑可选择继续或放弃。导入、诊断分享、置顶、模型切换和已有本机偏好沿用原有数据。

本地已通过类型检查、lint、4 项 smoke 和 91 项浏览器回归。新增覆盖教程顺序及官方链接、密钥验证保存、第三方编辑返回、焦点和滚动位置恢复、宽窄屏切换、人设保存、空用量的单价入口、触控菜单与安全区。截图核对 320/390 像素手机宽度、1120 像素宽屏、深浅主题与大字号。

Android 10 / WebView 74 模拟器的 360 × 800dp 画布覆盖上下系统栏，菜单避开 24dp 状态栏，输入框和抽屉底部按钮避开 48dp 三键导航。模拟长刘海后竖屏顶部边距变为 48dp，横屏左右边距各 48dp。真实软键盘在横屏和竖屏下均保留可见输入框和发送按钮。

Android 17 / WebView 145、16KB 内存页的模拟器上，亮色和深色的聊天与抽屉实际延伸至上下窗口边缘，手势导航区的底部控件可点。滑动事件被系统合并时，松手位置取自 touchend 的 changedTouches。移动中跳过末段 move 的专门回归也已通过。

实际点入高级配置后调起系统键盘，地址输入框底边位于 385.5dp，可见视口高度为 501dp。收起键盘后按安卓返回，弹出未保存确认，放弃修改后回到 API 页。手机横屏聊天的可见高度为 121dp，发送按钮底边在 112dp。模拟器录屏包含打开、拖动、收起抽屉和滚动正文。[查看 5 秒录屏](https://github.com/WikG1018/FreeSeekApp/blob/26aa1beb902f661b478a8fb960233a845aa2b086/docs/screenshots/immersive-drawer.mp4)

## 正式发布

- 发布源代码为 `f79cac5b3444fdad084c2ada6c2064261d438051`，版本 2.5.0，版本码 35。公开仓库的 APK 构建、91 项浏览器回归和八个安卓系统镜像全部通过。每个镜像运行三项原生检查，包括画布范围、系统栏边距、原生请求以及分享文件读取。[公开构建](https://github.com/WikG1018/FreeSeekApp/actions/runs/44153662194) · [Android 10–17 矩阵](https://github.com/WikG1018/FreeSeekApp/actions/runs/44153672833)
- Android 17 模拟器从已发布的 2.4.0 正式 APK 原地升级。读回已安装的 2.5.0 APK，摘要与发布文件一致。保留了历史消息、附件引用、草稿、置顶、人设及两个显示偏好。720 × 1600px 的 WebView 覆盖整个窗口，菜单的点击区域从距顶端 74px 处开始。安卓辅助功能树能读取置顶、接续、重命名和删除，系统返回键先关闭菜单。
- APK 大小为 21,291,059 字节，SHA-256 为 `3f771d65de70853a233ffbd85795356b1464e6a3f6691c3965070ed4b7159d90`，沿用原发布证书。GitHub 直连、ghfast.top、gh-proxy.com 和 ghproxy.net 都已完整下载并比对 APK 和更新清单。后两个镜像首次连接超时，重试成功。[2.5.0 发布页](https://github.com/WikG1018/FreeSeekApp/releases/tag/v2.5.0)
- 系统版本验证均使用模拟器，反馈用户的厂商真机仍待现场确认。开发仓库的 Actions 受账号付款或额度限制未启动，公开仓库在同一提交上完成了上述构建和测试。
