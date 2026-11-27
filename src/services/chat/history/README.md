# 聊天备份格式与恢复

面向使用者的备份、换机与重试步骤见[使用指南](../../../../docs/guides/user-guide.md#备份导入与恢复)。

## 识别归档

两种归档的第一个 ZIP 条目均为 `manifest.json`，按清单字段识别来源。

| 来源 | 识别字段 | 当前用途 |
| --- | --- | --- |
| DeepSeek 官方备份 | `export_format_version: 3` | 读取导出的消息树、索引和可用的图片。 |
| FreeSeek 备份 | `freeseek_backup_version` | 读取格式 1 到 9。格式 1 到 8 用于全量或部分备份，格式 9 用于从侧边栏导出的单个会话。 |

单会话 ZIP 包含该会话的消息、分支、已保存原件及关联工程。导入采用合并，发现相同编号时可选择保留哪一份。全局人设库与价格设置由目标设备继续管理。旧版客户端需要升级到支持格式 9 的版本才能读取单会话 ZIP。

## FreeSeek 备份

归档路径以清单为准。会话与附件原件分别存储，文件按本地 ID 去重。

| 位置 | 内容 |
| --- | --- |
| `manifest.json` | 会话编号、长会话分段数、文件编号、大小与类型、自建人设、默认人设和定价。部分备份可记录跳过的会话和缺少的原件。 |
| `freeseek/sessions/` | 会话 JSON 与长会话的分段。记录消息与所选分支、置顶、历史摘要、用量、模型引用、角色配音数据和任务信息。 |
| `freeseek/files/` | 可读取的附件、任务成果和配音样本原件。 |
| `freeseek/workspaces/` | 已备份的 Agent 工程文件。 |

备份排除 API 密钥、请求头和连接配置。只有文件信息的条目仍可显示文件名与大小。迁移后可从本机重新选取缺失的原件。合并到已有历史时沿用本机人设与价格设置，新设备可以恢复归档中的人设和价格。

## DeepSeek 官方备份

- 读取 `chat_sessions/{session_id}.json`、`chat_session_index.json` 和会话目录中的图片。支持按会话交错排列图片、将索引放在末尾。清单后可有 `user.json`，导入跳过该文件。
- 消息树使用 `id` 与 `parent_id` 校验节点编号、父子关系、角色交替与环路。`current_message_id` 可用时保留打开位置，缺失或失效时恢复一个可用的末尾分支。
- 正文、可用图片与支持的工具步骤转换为本机格式。引用、工具、错误、附件等在两种格式中可保留的字段不同。原归档文件保留在用户选取的位置。
- 有些会话无法还原时，界面给出可恢复与跳过数量，确认后才导入可用记录。

## 校验与合并

1. 识别格式后逐条读取并验证归档路径、压缩方法、大小、CRC 及消息结构。会话和原件进入暂存区。
2. 按会话编号识别重复项，同名的不同会话分别保存。默认保留本机版，用户可为重复项选择备份版。
3. 一次事务提交会话、原件和索引。与已有数据冲突的原件 ID 会在合并中重新分配。提交前取消、校验错误或写入失败时保留原有会话。
4. 导出优先保存可读取的数据。遇到缺少原件或无法备份的个别会话时，保存的 ZIP 可标记为部分备份，界面显示对应数量。

导入支持单卷 ZIP32、ZIP64 与 STORE、DEFLATE，导出使用 ZIP32 STORE。归档路径按 NFC 规范化。超大备份能否导入还取决于单条数据的复杂度和可用空间，解压后的单条会话数据读取上限为 256 MiB，索引和清单为 128 MiB。使用未加密、非分卷、UTF-8 文件名的归档。

## 实现入口

| 文件 | 职责 |
| --- | --- |
| [format.ts](format.ts)、[schema.ts](schema.ts) | DeepSeek 归档字段和校验 |
| [toLocal.ts](toLocal.ts)、[importArchive.ts](importArchive.ts) | DeepSeek 数据读取和本机消息转换 |
| [nativeArchive.ts](nativeArchive.ts)、[nativeSchema.ts](nativeSchema.ts) | FreeSeek 归档的写入、还原和字段校验 |
| [readJson.ts](readJson.ts)、[zipReader.ts](zipReader.ts)、[zipWriter.ts](zipWriter.ts) | 分块读取和 ZIP 校验、写出 |
| [backup.ts](../backup.ts)、[import-cases.mjs](../../../../scripts/test/import-cases.mjs) | 串行任务、合并入口及验证用例 |
