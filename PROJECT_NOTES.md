# 项目维护说明

FreeSeek 基于 DeepSeek 官方开源 chat-demo 开发。当前公开版本的安装方式、API 设置和备份导入方法见 [使用说明](README.md)。各版本已发布的变化见 [更新日志](CHANGELOG.md)。

## 本地构建与验证

按 README 的构建章节安装 Node.js、pnpm 和 Android 工具。先执行类型检查和 Lint，再按需运行冒烟测试和端到端回归。构建网页资源后同步到 Android 工程。

[验收记录](docs/reviews/)记载了各次验收的环境和覆盖范围。模拟器与模拟接口的结果以记录中的范围为准。

## 数据与更新

对话数据由应用在本机管理。迁移或清除本机数据前可使用「数据管理」导出备份。API 请求由应用发往当前配置的服务。

发布记录与 APK 下载在 [GitHub Releases](https://github.com/WikG1018/FreeSeekApp/releases)，正式包的签名配置保存在本地。
