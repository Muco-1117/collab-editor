# 最新开题报告与任务书实施记录

本轮依据 `D:/bishe/docs/20235102034-柯佳伟-开题报告.docx` 和同目录任务书（两份文件于 2026-10-15 更新），将项目名称与系统实现对齐为“基于SpringBoot的协同编辑系统设计与实现”。本轮交付是源代码、可运行构建、工程说明和测试记录，未修改已有论文或答辩材料。

## 需求与实现对照

| 最新材料的要求 | 本轮结果 | 主要位置 |
|---|---|---|
| 统一元素模型支持文本、图片、卡片 | 新增 `IMAGE`，三应用复用同一个 `STATE`、快照和日志链路 | `engine/ElementType`、`DocState`、`Op` |
| Lamport 时间戳与操作 ID、元素级 LWW | 正式客户端发送完整元素状态，比较 `(counter, replicaId, opId)`；旧日志兼容 | `DocState`、`collabState.js`、`useCollabSocket.js` |
| 去重、确认、广播、重连补偿 | 复用统一 WebSocket；STATE 冲突操作保留日志，重启后重传仍幂等 | `CollabRoom`、`CollabMessage`、`OpStore` |
| 文档图片插入、替换、删除及顺序调整 | 与段落按共同 `order` 排列，图片可上移/下移；历史可预览及恢复图片 | `DocumentEditor.vue`、`HistoryDialog.vue` |
| 白板图片位置、尺寸、层级及引用同步 | 图片与卡片共用移动、缩放、键盘位移和层级操作，支持替换及删除 | `BoardEditor.vue` |
| 看板任务封面或附件图 | 支持封面上传、替换、移除，名称/引用/任务关联随任务流转 | `KanbanEditor.vue` |
| REST 上传、服务端格式/大小/权限检查 | PNG/JPEG/GIF，8MB、单边 10000 像素、总计 2400 万像素；校验实际解码格式；资源读取继承空间权限 | `ImageAssetController`、`ImageAssetRepo`、`image_asset` |
| 使用标准 JWT 库 | Auth0 java-jwt 4.5.0 处理签发、签名与有效期验证，自行保留业务载荷检查和权限流程 | `JwtUtil`、`AccessService` |
| MySQL 日志/快照、历史回放、重启恢复 | 新版完整字段对象可持久化、重建、恢复；图片文件独立保存，旧文件保留用于回放 | `OpStore`、`HistoryService`、`SchemaMigrationRunner` |
| 内容检索与统计 | 原有可见范围检索/日志统计继续使用，增加图片名称和封面名称检索，显示 STATE 操作分类 | `ProductController`、`StatsPanel.vue` |
| 按内容类型多格式导出 | 见下表；服务端按最新已提交状态生成，图片缺失返回错误 | `ContentExportService`、`WorkspaceSession.vue` |
| 多用户、图片、断线、导出及性能测试 | JUnit、Vitest、三用户 Playwright、实际进程重启及新版并发负载均完成 | 测试与证据见下文 |

## 实际导出范围

| 应用 | 格式 | 内容与图片 |
|---|---|---|
| 文档 | Word `.docx` | 标题、段落顺序、文本、内嵌图片及图片名称 |
| 文档 | HTML、Markdown | 标题、文本、顺序、内嵌图片 Data URI |
| 文档 | 纯文本 `.txt` | 标题、文本、图片名称和资源引用，纯文本不承载图片二进制 |
| 白板 | PNG、SVG | 按位置、尺寸与层级生成静态布局；SVG 内嵌图片 |
| 白板 | Markdown | 文本卡片与内嵌图片 |
| 看板 | CSV、XLSX | 列表、空列表、任务、排序、未分配任务、封面名称、引用及资源 ID |
| 看板 | Markdown | 列表/任务和内嵌封面图 |

最新材料允许具体格式以实现和测试结果为准。当前没有提供直接 PDF 导出。GIF 在 Word 与 PNG 等静态输出中使用首帧；CSV/XLSX 交付封面元数据，不嵌入封面二进制。图片资源访问需要空间权限；Word/HTML/Markdown/SVG 的内嵌图片可随导出文件独立打开。

## 协议与数据迁移

正式 Vue 客户端使用 `STATE` 完整元素更新。元素快照保留原有 `fields` 结构，`#version` 记录获胜操作 ID，每个业务字段记录同一获胜时钟。同元素的并发更改可能整项覆盖；不同元素独立合并，不承诺保留全部并发输入。

兼容旧 `ADD/PUT/DELETE` 日志。元素一旦迁移到 `STATE`，旧字段写不再影响它，旧客户端写入会收到 `UPGRADE_REQUIRED`，需刷新到当前 Vue 客户端。DOC 根标题继续走 REST 权威元数据和旧版投影。所有接受的新版状态操作都保留日志，包括未获胜的并发状态；重复 clock/opId 且载荷相同则仅确认，不新增版本。

`SchemaMigrationRunner` 启动时幂等新增 `image_asset`，不要求删除开发库。图片本体保存在 `UPLOAD_DIR`（默认 `./data/uploads`）；数据库和文件目录必须一起备份。替换/删除元素保留旧图片用于历史恢复。当前采用单实例服务和本地持久目录，未实现多节点共享存储。

## 验证结果

验证日期为 2026-10-17，时间按 Asia/Shanghai。环境为 Windows 11 专业工作站版 10.0.26300、AMD Ryzen 5 5500U（6 核/12 线程）、约 13.85GiB 可见内存、JDK 21.0.10（编译目标 Java 17）、Maven 3.9.14、MySQL 8.0.45、Node.js 24.14.1、Playwright 1.55.1。

| 检查 | 结果 | 覆盖内容 |
|---|---|---|
| Maven 全量 + 最后针对性回归 | 52/52，失败/错误/跳过均为 0 | engine 15、server 37；旧功能、JWT、STATE、图片、导出、持久化与权限 |
| Vitest | 28/28，9 个文件 | 新旧协议、完整状态替换、墓碑、同版本操作 ID 裁决、连接状态 |
| 前后端构建 | 通过 | `server/target/server-0.1.0.jar`、`frontend/dist/` |
| Playwright | 20/20 | 三个独立身份和浏览器 context、三应用、图片、历史、导出、统计、规范化业务状态及版本一致 |
| 断线恢复 | 实际阻断 30012ms，通过 | 恢复同步并刷新验证持久化 |
| 响应式检查 | 通过 | 320/390/414/768/1440px，无全局横向溢出 |
| 页面诊断 | 通过 | pageerror=0、consoleErrors=0、HTTP 5xx=0 |
| 真实服务进程重启 | 通过 | 两次启动间版本、完整业务状态、图片和含图 HTML SHA-256 一致，重传幂等 |

新增核心测试 `ElementStateTest` 验证文本、图片、卡片的完整状态在乱序、重复和快照合并下收敛，并验证迁移后迟到旧字段写被忽略。`ImageAndExportTest` 验证真实图片上传、伪造格式、超大文件、只读/跨空间访问、跨内容资源引用、WebSocket 重传、快照重建、历史恢复和所有公开格式的内容完整性。

真实重启脚本为 `tests/e2e-ui/restart-smoke.mjs`，在 8082 端口启动测试 JAR，先上传图片和写入 STATE，再关闭 Java 进程并重新启动，验证 welcome、资源读取、导出和重复确认。它复用固定的本轮临时密钥，但不把密钥或账号密码写入证据。

## 性能实测与适用边界

浏览器测量使用 3 个独立用户，1 个写入者，20 次串行输入，文本载荷约 266–267 个 ASCII 字符。起点为 owner 页面的 DOM input 事件，终点为 editor 页面的 textarea 值在下一动画帧已应用；浏览器与服务端运行在同一机器。实测 P50=28ms、P95=39ms、最大=47ms，错误=0。该口径包括浏览器应用，不能解释为公网延迟或高并发容量上限。

新版 `ConcurrentLoadTest` 使用同房间 10/50/100 个 WebSocket 客户端，各发送 20 条 STATE，正文为 256 个 ASCII 字符，完整 JSON 帧为 424–432 字节，每客户端最多 1 条未确认操作。发送到自身 applied 的耗时包含服务端持久化；吞吐计算包含该轮广播排空。每个订阅者都检查完整广播，数据库检查操作数、唯一 ID 和连续 seq。

| 连接数 | 操作数 | P50 | P95 | P99 | 最大 | 吞吐 | 丢失/重复 |
|---|---|---|---|---|---|---|---|
| 10 | 200 | 25.31ms | 34.50ms | 43.21ms | 46.44ms | 388 ops/s | 0/0 |
| 50 | 1000 | 74.36ms | 121.26ms | 143.41ms | 172.91ms | 612 ops/s | 0/0 |
| 100 | 2000 | 173.27ms | 258.52ms | 302.51ms | 406.55ms | 543 ops/s | 0/0 |

50 连接 P95 小于 200ms 的既有质量门通过；100 连接下延迟上升，未宣称其满足该阈值。矩阵使用同一账号的多个协议连接，不能替代三个独立用户的 UI/权限测试；后者由 Playwright 单独覆盖。图片压力不在此矩阵内，图片功能与完整性由其他用例验证。

## 证据与复现

- 汇总与原始 JUnit XML：`artifacts/report-alignment-20261017/summary.json` 及 `engine/`、`server/` 子目录。
- 本轮负载原始日志：`artifacts/report-alignment-20261017/report-alignment-final-maven.log`。
- 最后针对性回归：`artifacts/report-alignment-20261017/report-alignment-focused.log`。
- 浏览器最终批次：`artifacts/e2e-vue/2026-10-17T06-10-49-713Z-mvbzzunlgquu/`；包含 summary、三份 trace、桌面/移动端截图、含图下载和 `browser-latency.json`。
- 真进程重启：`artifacts/report-alignment-20261017/restart-summary.json`；原始服务日志在 `artifacts/runtime/restart-smoke/`。
- 证据 SHA-256：`artifacts/report-alignment-20261017/SHA256SUMS.txt`。

先按 [README](../README.md) 配置数据库与依赖，然后执行：

```powershell
mvn.cmd clean package
Set-Location frontend
npm.cmd test
npm.cmd run build
```

JUnit 必须连接独立 `collab_editor_test`；测试配置保护器会拒绝其他库名。Playwright 需要已运行的 JAR 与 Vite，执行 `tests/e2e-ui` 下 `npm.cmd test`。`npm.cmd run test:restart` 会自行在 8082 启停测试进程，使用环境变量中的 `DB_USER/DB_PASSWORD`，强制连接独立测试库。JUnit 会重建测试表，不能与使用该库的端到端服务同时运行。

2026-09-20 的旧版记录保留为历史证据，本轮范围和结论以本文及对应原始结果为准。
