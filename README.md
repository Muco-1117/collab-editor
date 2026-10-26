# 基于SpringBoot的协同编辑系统设计与实现

项目完善记录见 [2026-10-22 第一轮](docs/improvements-20261022.md) 与 [第二轮功能记录](docs/improvements-20261022-round2.md)，IDEA / VS Code 的具体启动步骤见 [本地启动指南](docs/local-development.md)。

本项目按 `D:/bishe/docs/` 中 2026-10-15 更新的开题报告和任务书实现。统一 Java 协同引擎通过 Lamport 时钟、操作 ID、元素级 LWW 与墓碑状态驱动文档、白板、看板，配套 Auth0 java-jwt 认证、空间三级角色、MySQL 日志/快照、版本回放、检索和统计。

文档支持段落和图片的编辑、替换、删除与顺序调整；白板同步卡片和图片的位置、尺寸、层级及引用；看板同步列表、任务、拖拽排序、状态流转和封面图。图片通过 REST 上传，WebSocket 只传引用和元数据，读取权限继承所在空间。

点击工作台左下角的头像或名字可进入个人主页，修改昵称、上传头像或恢复默认头像。头像支持 PNG/JPEG（最大 2MB），服务端居中裁剪为 256×256 PNG，与昵称一同持久化到 MySQL；登录用户名保持不变。已有数据库启动后端时会自动补齐头像字段。

工作台采用基于 shadcn-vue（MIT）侧栏布局二次开发的浅色界面。空间首页展示三类创建入口、最多 4 项“继续工作”和最多 8 项“最近更新”，完整分类从左侧文档、白板、看板进入。文档栏目展示真实正文摘要及段落、图片数量；白板展示画布缩略图；看板展示真实列表与任务分布。栏目保留专属创建、名称查找和排序，首页不再重复类型筛选或显示方式切换。栏目与空间写入地址，支持刷新、前进后退及从编辑器返回原位置。开源来源与设计说明见 [主页 UI 设计](docs/ui-design.md)。

“继续工作”来自本机当前账号最近打开记录，只存内容键、空间、类型和时间，再与当前授权列表匹配；不存正文或标题，不展示已删除或已失去访问权限的内容。统计页面按数据库最近 7 个自然日补齐零值，成员通过账号 ID 区分同名；操作次数包含系统初始化，不代表任务完成度。

所有者可在成员管理中切换编辑/只读权限或移出成员，已打开的编辑页即时更新权限；删除内容会通知在线成员并结束该内容的协同连接。改名后各在线页面的只读标题与侧栏同步更新。暂时断线保留当前页面中未确认的修改，合法重连后按原操作身份重发；离开或刷新前提示尚未同步的修改。该保留仅限页面内存，强行关闭页面仍可能丢失未确认输入。

所有者可从当前空间“回收站”恢复误删的文档、白板和看板，保留原内容键、类型、空间、图片、历史和快照；未提供永久删除或自动清空。恢复接口为 `/api/docs/{docKey}/restore-deleted`，历史版本恢复仍使用 `/restore`。恢复后重新打开内容即可继续协作；之前因删除关闭的页面需要重新打开或刷新。

文档上方“查找”支持 `Ctrl/Cmd+F`、`Enter` 下一处、`Shift+Enter` 上一处和 `Esc` 返回原选区，按可见段落内的字面文字忽略大小写匹配；只读成员也可使用。看板卡片可通过“移至列表”直接追加到任意目标列表末尾，顶部“跳转列表”帮助浏览较宽的看板；跳转只改变本地视图。

白板支持 10%–200% 本地视图缩放、适应内容、Ctrl/Cmd + 滚轮、空格拖动、中键和触屏平移；这些操作不修改共享元素坐标。多标签页会同步退出和账号切换，先关闭旧账号编辑会话再进入新账号；同账号 token 正常换发不会重开页面。昵称和头像在重新打开个人主页时读取最新资料，暂不跨标签即时推送。

| 内容 | 已实现导出格式 | 图片处理 |
|---|---|---|
| 文档 | Word `.docx`、HTML、Markdown、纯文本 | Word/HTML/Markdown 内嵌图片；纯文本保留名称及资源引用 |
| 白板 | PNG、SVG、Markdown | 静态布局导出；SVG/Markdown 内嵌图片 |
| 看板 | CSV、XLSX、Markdown | 表格保留列表、任务、封面名称、引用与资源 ID；Markdown 内嵌封面 |

Word 图片保持原始宽高比；CSV 对以公式字符开头的单行、多行内容按文字导出。白板图片导出保留实际坐标，超过 8000 像素边长或 2400 万像素时明确提示缩小布局，不移动元素来适配限制。

新版客户端使用完整元素 `STATE` 操作，比较 `(counter, replicaId, opId)`。同一元素的并发更改可能整项覆盖；不同元素独立合并，不提供字符级自动合并。旧版 `ADD/PUT/DELETE` 日志仍可读取，元素迁移到新版后旧客户端需刷新。协议见 [WebSocket 协议](docs/websocket-protocol.md)，需求实现基线见 [2026-10-17 需求对照与验证](docs/report-alignment-20261017.md)。

## 工程结构

```text
collab-editor/
|-- engine/          自研协同引擎和 JUnit 测试
|-- server/          Spring Boot REST、WebSocket、权限与持久化
|-- frontend/        Vue 3 + Vite 正式前端
|-- db/              MySQL 8 初始化脚本
|-- scripts/         前后端启动、环境检查与演示数据脚本
|-- tests/e2e-ui/    Vue 真实页面 Playwright 测试
|-- docs/            架构、协议、部署、测试和演示文档
|-- collab-editor.code-workspace  VS Code 工作区与启动任务
`-- pom.xml          Maven 多模块父工程
```

## 环境要求

| 组件 | 要求 |
|---|---|
| JDK | Java 17；允许使用更高版本 JDK 构建，但编译目标固定为 17 |
| Maven | 3.9 或兼容版本 |
| MySQL | 8.x |
| Node.js | 完整开发和测试使用 22 LTS（至少 22.12）或 24 LTS；当前 Vitest 5 不支持 Node 18/20 |
| npm | 与 Node.js 配套 |

当前服务端使用 Spring Boot `3.5.3`，前端使用 Vue 3 和 Vite 6。先确认本机命令可用：

```powershell
java -version
mvn.cmd -version
node --version
npm.cmd --version
mysql --version
```

## 本地启动

项目目录：`D:\bishe\projects\collab-editor`。具体 IDE 步骤见 [在 IDEA 和 VS Code 中启动项目](docs/local-development.md)。本地使用时需 MySQL、后端、前端同时运行；IDEA 和 VS Code 无需连接彼此，前端通过 HTTP/WebSocket 代理访问后端。

已有数据库与 `application-local.yml` 时保留原配置。确认 MySQL 服务已启动，若 `8080` 或 `5173` 已运行本项目，无需重复启动实例。**更新本轮 Java 代码后，在 IDEA 启动或重启 `CollabServer-local`；VS Code 中运行“启动前端（Vue）”，两端就绪后访问或刷新 `http://localhost:5173`**，回收站和导出修复才会由新后端提供。已有 Vite 正在运行时直接复用。本轮不需要重新建库或添加依赖。全新环境按 [部署说明](docs/deployment.md) 初始化 `db/init.sql` 并配置数据库/JWT；不要重建现有开发库。

两个 PowerShell 终端分别运行，工作目录均为项目根目录：

```powershell
# 终端一：构建并启动后端
powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\start-backend.ps1
```

```powershell
# 终端二：启动正式 Vue 前端，首次缺依赖时执行 npm ci
powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\start-frontend.ps1
```

浏览器访问 **`http://localhost:5173`**。Vite 会把 `/api` 和 `/ws` 代理到 `http://localhost:8080`。脚本与 Vite `strictPort` 会报告端口冲突，不会自动停止已有进程或悄悄换端口。后端健康检查：

```powershell
Invoke-RestMethod http://localhost:8080/api/health
```

`-CheckOnly` 可只检查环境/端口而不启动服务。自定义端口时同时指定后端与前端代理，例如后端 `-Port 8081`，前端 `-Port 5174 -ProxyTarget http://localhost:8081`。代码未改且已有构建时才使用后端 `-SkipBuild`。

`server/src/main/resources/static/` 是早期原生页面原型，仍被 `tests/e2e-ui` 的 `test:legacy` 脚本引用，因此暂时保留；它不是当前验收或正式部署入口。当前界面验收必须使用 `frontend/`，正式发布使用 `frontend/dist/`。

### IDEA 与 VS Code

用 IDEA 打开根 `pom.xml`，选择 JDK 17/21 并导入 Maven，运行自带 **`CollabServer-local`**。用 VS Code 打开 **`collab-editor.code-workspace`**，执行“启动前端（Vue）”任务。若只使用 VS Code，则执行“同时启动前后端”任务。

IDEA 自定义运行配置的主类为 `com.bishe.server.CollabServerApplication`，模块选 `server`，工作目录为项目根目录，程序实参填写：

```text
--spring.profiles.active=local --spring.config.additional-location=optional:file:./server/src/main/resources/
```

`application-local.yml` 由外部路径加载，已被 Git 忽略并从 Maven 资源/JAR 中排除；只有 `local` 而没有外部配置路径时可能无法读取凭据。启动脚本也会检查 JAR 未夹带本地配置。本地 JWT 密钥至少 32 字节，重启时保持一致；更换后需要重新登录。

## 演示数据

先启动 MySQL 和后端，再运行 `scripts/seed-demo.mjs`。脚本通过产品 REST 和 WebSocket 正常链路创建数据，不直接写用户表或操作日志；密码只从进程环境读取，不会写入仓库或输出到终端。

```powershell
$env:DEMO_OWNER_PASSWORD = '<local-demo-owner-password>'
$env:DEMO_EDITOR_PASSWORD = '<local-demo-editor-password>'
$env:DEMO_VIEWER_PASSWORD = '<local-demo-viewer-password>'
node .\scripts\seed-demo.mjs

Remove-Item Env:DEMO_OWNER_PASSWORD,Env:DEMO_EDITOR_PASSWORD,Env:DEMO_VIEWER_PASSWORD
```

默认创建或复用以下数据：

- `demo_owner`、`demo_editor`、`demo_viewer` 三个本地演示账号；
- 空间“毕业设计协同演示”，角色分别为 `owner`、`editor`、`viewer`；
- 文档“需求评审纪要”、白板“模块关系梳理”、看板“答辩准备计划”；
- 两个文档段落、一张白板卡片、三列看板和三张任务卡片。

脚本使用稳定的 seed 操作身份，重复执行不会重复创建空间、内容或日志，也不会覆盖 seed 之后的人工编辑。账号已存在但密码不匹配、同名空间/内容不唯一或同名内容包含非 seed 操作时，脚本会停止，避免修改来源不明的数据。可用 `DEMO_API_BASE` 和三个 `DEMO_*_USERNAME` 环境变量覆盖地址或用户名；查看完整参数使用：

```powershell
node .\scripts\seed-demo.mjs --help
```

完整演示顺序见 [答辩演示指南](docs/demo-guide.md)。

## 测试

### 引擎单元测试

```powershell
mvn.cmd -q -pl engine test
```

### 服务端全量测试

Spring 集成测试会重建独立数据库 `collab_editor_test`。保护器会拒绝其他库名，但仍必须显式检查测试配置，绝不能把 `TEST_DB_URL` 或 `DB_URL` 指向开发库 `collab_editor`。

```powershell
$env:TEST_DB_USER = '<test-database-user>'
$env:TEST_DB_PASSWORD = '<test-database-password>'
mvn.cmd -q test
```

### 前端单元测试与构建

```powershell
Set-Location .\frontend
npm.cmd ci
npm.cmd test
npm.cmd run build
```

### 实际进程重启验证

配置 `DB_USER/DB_PASSWORD` 并完成 JAR 构建后，在 `tests/e2e-ui` 执行 `npm.cmd run test:restart`。脚本自行在 8082 端口先后启动两个 Java 进程，固定使用 `collab_editor_test`，验证图片、完整元素、版本、导出 SHA-256 和重传去重，随后关闭测试进程。不要与会重建该库的 JUnit 同时运行。

### Vue 多用户 Playwright

先保持目标后端和 Vite 运行，测试应使用独立测试环境；不要与会重建 `collab_editor_test` 的 JUnit/重启测试同时运行。再执行：

```powershell
Set-Location .\tests\e2e-ui
npm.cmd ci
$env:E2E_BASE_URL = 'http://localhost:5173'
npm.cmd test
```

测试脚本每次生成隔离的三账号、空间和三类内容，覆盖三角色权限、协同操作、图片、历史恢复、搜索、各类型导出、统计、三端规范化状态和版本比对，以及约 30 秒断线恢复与浏览器应用延迟；布局验收覆盖 `320/390/414/768/1440 px`。上例显式设置 `localhost`，适配 Vite 本机监听；旧脚本未设置变量时仍回退到 `127.0.0.1:5173`。可用 `E2E_BASE_URL`、`E2E_OFFLINE_MS`、`E2E_TIMEOUT`、`E2E_HEADED=1` 调整。运行证据保存在仓库根目录 `artifacts/e2e-vue/<runId>/`，不提交 Git。

历史验证见 [2026-10-17 需求对照与验证](docs/report-alignment-20261017.md)；2026-09-20 的旧版记录保留在原文档中，历史通过数不能作为当前工作树的验收结果。测试矩阵、隔离规则和证据路径见 [测试计划](docs/test-plan.md)、[双层验证记录](docs/verification-双层验证记录.md) 与 [服务端测试说明](server/src/test/README.md)。

第二轮回收站、首页分工、白板视图、跨标签会话、统计及导出边界的验证证据保存在 `artifacts/round2-20261022/`；模拟接口的浏览器检查与真实 MySQL/REST/WebSocket 验证分别记录。性能测试在其他浏览器与构建任务结束后单独执行，并保留首次失败及后续复测证据。

## 正式构建与部署

```powershell
mvn.cmd -q clean package -DskipTests
Set-Location .\frontend
npm.cmd ci
npm.cmd run build
```

产物为 `server/target/server-0.1.0.jar` 和 `frontend/dist/`；本机 `application-local.*` 不进入 JAR。正式环境通过 `DB_URL`、`DB_USER`、`DB_PASSWORD`、`JWT_SECRET` 及固定 `UPLOAD_DIR` 注入配置，以同一 Origin 发布静态文件，并将 `/api`、`/ws` 反向代理到 Spring Boot；`/ws` 必须转发 WebSocket Upgrade 头。完整配置、备份恢复和故障排查见 [部署与运维说明](docs/deployment.md)。

## 文档索引

- [IDEA / VS Code 本地启动](docs/local-development.md)
- [第二轮功能与验证记录](docs/improvements-20261022-round2.md)
- [系统架构](docs/architecture.md)
- [数据库设计](docs/database-er.md)
- [REST API](docs/api-reference.md)
- [WebSocket 协议](docs/websocket-protocol.md)
- [部署与运维](docs/deployment.md)
- [测试计划](docs/test-plan.md)
- [答辩演示指南](docs/demo-guide.md)
