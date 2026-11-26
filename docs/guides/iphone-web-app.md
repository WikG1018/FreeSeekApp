# 在 iPhone 和 iPad 使用 FreeSeek

[使用指南](user-guide.md) · [Open the English guide](user-guide.en.md#install-and-update)

1. 在 Safari 打开 [FreeSeek 网页版](https://wikg1018.github.io/FreeSeekApp/)。
2. 从页面菜单打开「共享」，点「添加到主屏幕」。部分 Safari 布局直接提供共享按钮。如果列表中没有这项，可在底部「编辑操作」添加。
3. 系统显示「作为网页 App 打开」时开启它，然后点「添加」。
4. 从主屏幕图标打开 FreeSeek。在「设置 → API 服务」配置模型，也可以先在「数据管理」导入聊天 ZIP。

按钮位置随 Safari 布局及系统版本变化。[Apple 的 iPhone 添加说明](https://support.apple.com/zh-cn/guide/iphone/iphea86e5236/27/ios/27) · [Apple 的 iPad 添加说明](https://support.apple.com/zh-hans/guide/ipad/ipad8f1f7a29/27/ipados/27)

## 存储与更新

- 聊天、附件和密钥保存在当前站点的浏览器存储。换设备、浏览器或托管地址，先在原入口导出 ZIP，再从新入口导入，密钥重新填写。
- 再次打开时如果提示有更新，完成当前对话后刷新。网页外壳可以缓存，聊天、语音和联网工具仍需要访问相应服务。
- 模型地址需要接受来自该站点的跨域请求。系统保存、分享、通知和后台工作取决于浏览器与系统支持。
- 如果存储空间紧张或清除了 Safari 网站数据，请用已有备份恢复。长时间运行任务时宜保持前台。

自建站点请参考[网页版构建和托管](development.md#网页与静态部署)。在外部访问时使用 HTTPS，并上传完整的构建目录。
