# 在 IDEA 和 VS Code 中启动项目

整个项目在 `D:\bishe\projects\collab-editor`。打开这个目录即可，里面的 `engine`、`server` 是同一个 Maven 工程的模块，`frontend` 是 Vue 前端。

本地运行需要 **MySQL、后端、前端同时运行**。IDEA 和 VS Code 不需要连接彼此；浏览器中的前端会通过代理访问后端。可以用 IDEA 跑后端、VS Code 跑前端，也可以只用 VS Code 的两个任务。

| 部分 | 作用 | 默认地址 |
|---|---|---|
| MySQL 8 服务 | 保存账号、空间、内容和操作历史 | `localhost:3306` |
| Spring Boot 后端 | REST API、WebSocket 协同和权限 | `http://localhost:8080` |
| Vue / Vite 前端 | 当前正式页面 | **`http://localhost:5173`** |

## 启动前确认

1. 在 Windows“服务”中确认 MySQL 正在运行；服务名通常是 `MySQL80`，以本机安装为准。
2. 已有数据库和 `server/src/main/resources/application-local.yml` 时继续使用现有配置，**不要删除或重建数据库**。
3. 准备 JDK 17 或更高版本（现有 JDK 21 可以继续使用）、Maven 3.9、Node.js 22 LTS（至少 22.12）或 24 LTS。单独运行 Vite 的最低要求是 Node 18，但当前 Vitest 5 测试工具需要更高版本，完整开发环境按前述版本准备。
4. 如果后端或前端已经运行且代码未更新，直接打开页面。Java 代码更新后需重启原后端，不额外启动第二个实例；重复启动会占用 `8080` 或 `5173`，脚本会指出冲突，不会关闭原服务。

本地配置含数据库密码与 JWT 密钥，已经被 Git 忽略。Maven 构建应排除这个文件，运行时从外部路径加载；不要把它拷进 `frontend` 或提交到仓库。当前已有本地配置无需重写。新电脑没有配置时，可根据 [部署说明](deployment.md) 设置 `DB_URL`、`DB_USER`、`DB_PASSWORD`、`JWT_SECRET` 环境变量，或创建本地文件。`JWT_SECRET` 至少 32 字节，并在服务重启时保持一致。

## 应用本轮更新

本轮继续使用原项目目录、MySQL 配置和 8080/5173 端口，无新增依赖，也不需要重新建库。旧服务会继续执行启动时加载的 Java 代码，仅刷新前端不能启用新的回收站接口。

1. 在 IDEA 的运行窗口启动或重启 **`CollabServer-local`**，等待 `Started CollabServerApplication`；保持外部 `application-local.yml` 和原 JWT 密钥。
2. VS Code 中原 Vite 仍运行时直接复用；没有运行时执行 **“启动前端（Vue）”** 任务，再访问或刷新 **`http://localhost:5173`**。
3. 空间首页应显示“继续工作”和“最近更新”；文档、白板、看板从左侧进入，所有者可进入“回收站”。没有最近打开记录时，“继续工作”不显示。
4. 内容从回收站恢复后点击打开继续协作。旧标签页若此前提示内容被删除，需重新打开或刷新；它不会自动复用已经关闭的连接。

文档顶部可用“查找”或 `Ctrl/Cmd+F` 定位正文；白板右下工具栏提供缩放和平移；看板卡片可“移至列表”，顶栏可“跳转列表”。这些入口都在原内容页面内，不需要添加启动参数。

使用脚本启动后端时，先在原终端停止该后端，再运行 `start-backend.ps1` 重新构建启动。IDEA 启动与 JAR 启动二选一，避免重复占用端口。前端单独变化通常由 Vite 自动更新，后端 Java 变化仍需重启。

## 方式一：IDEA 启动后端，VS Code 启动前端

### IDEA

1. 选择“文件 → 打开”，打开 `D:\bishe\projects\collab-editor\pom.xml`，按 Maven 项目打开。也可以直接打开项目目录；无需新建工程。
2. 在“文件 → 项目结构”中为项目选择已安装的 JDK 17 / 21。在 Maven 工具窗口点击“重新加载所有 Maven 项目”，等待依赖导入完成。
3. 顶部运行配置选择 **`CollabServer-local`**，点击运行。该配置运行 `server` 模块中的 `com.bishe.server.CollabServerApplication`。
4. 控制台出现 `Started CollabServerApplication` 后，后端才启动完成。MySQL 连接失败时先检查服务和本地配置。

如果没有显示现成运行配置，在“运行 → 编辑配置”中添加 Application：

| 配置项 | 填写内容 |
|---|---|
| 名称 | `CollabServer-local` |
| 主类 / Main class | `com.bishe.server.CollabServerApplication` |
| 模块 / Use classpath of module | `server` |
| 工作目录 / Working directory | `D:\bishe\projects\collab-editor` |
| 程序实参 / Program arguments | `--spring.profiles.active=local --spring.config.additional-location=optional:file:./server/src/main/resources/` |

`local` 和外部配置路径都需要保留。只点击主类旁的三角形、却没有这些参数时，可能读取不到本地数据库密码或 JWT 密钥。

### VS Code

1. 打开项目根目录中的 **`collab-editor.code-workspace`**。
2. 选择“终端 → 运行任务”，运行 **`启动前端（Vue）`**。
3. 等终端显示 Vite 地址，访问 **`http://localhost:5173`**。

后端已经由 IDEA 运行时，只运行前端任务即可。不要再点 VS Code 的后端任务或“同时启动前后端”。

## 方式二：只用 VS Code

打开 `collab-editor.code-workspace`，选择“终端 → 运行任务 → **同时启动前后端**”。两个任务分别在 VS Code 终端中运行，前端会先就绪；等后端也显示启动完成后再登录。

后端任务会在项目根目录构建 `engine` 和 `server`，然后启动生成的 JAR；前端第一次缺少 `node_modules` 时会运行 `npm ci`。两个终端都应保持打开。需要停止时，在对应终端按 `Ctrl+C`；运行中不需要再次点击启动任务。

## 方式三：两个 PowerShell 终端

终端一：

```powershell
Set-Location D:\bishe\projects\collab-editor
powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\start-backend.ps1
```

终端二：

```powershell
Set-Location D:\bishe\projects\collab-editor
powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\start-frontend.ps1
```

这里的 `ExecutionPolicy Bypass` 只作用于本次子进程，不修改系统的脚本策略。两个脚本在当前终端前台运行，不会额外弹出窗口。它们不启动或停止 MySQL，也不结束其他 Java / Node.js 进程。

代码没有改变、且已经成功构建过后端时，可用 `-SkipBuild` 缩短启动时间；修改 Java 代码后应去掉该参数重新构建。

## 环境变量与自定义端口

脚本优先使用指定路径，随后查找 `JAVA_HOME`、`MAVEN_HOME` / `M2_HOME` 或 `PATH`。未配置环境变量时，可以明确指定自己的安装目录：

```powershell
# 将两个路径替换为本机实际安装位置
.\scripts\start-backend.ps1 -JavaHome 'C:\Tools\jdk-21' -MavenHome 'C:\Tools\apache-maven'
.\scripts\start-frontend.ps1 -NodeHome 'C:\Tools\nodejs'
```

需要使用另一组端口时，同时修改前端的代理目标：

```powershell
# 终端一
.\scripts\start-backend.ps1 -Port 8081

# 终端二
.\scripts\start-frontend.ps1 -Port 5174 -ProxyTarget http://localhost:8081
```

此时浏览器访问 `http://localhost:5174`。HTTP API 和 WebSocket 都会转发到 `8081`。脚本会显式检查端口，Vite 也启用了 `strictPort`，不会悄悄改为另一个地址。

如果 IDEA 已在 `8080` 启动同一项目，就保持原后端，只运行前端脚本。需要另开后端实例时，应先明确数据目录和数据库用途；日常开发不需要启动两个后端。

只查看帮助或检查环境，不启动服务：

```powershell
.\scripts\start-backend.ps1 -Help
.\scripts\start-frontend.ps1 -Help
.\scripts\start-backend.ps1 -CheckOnly
.\scripts\start-frontend.ps1 -CheckOnly
```

`-CheckOnly` 不安装依赖、不构建、不连接数据库；如果目标端口已有服务，它会报告端口占用，这通常意味着不需要再次启动。

## 常见情况

| 情况 | 处理方式 |
|---|---|
| 浏览器打不开 `5173` | 检查前端终端是否仍在运行，使用终端显示的 `localhost` 地址 |
| 页面能打开，但登录显示无法连接服务器 | 检查后端已启动、MySQL 已启动，以及前端代理端口与后端一致 |
| 新回收站页面加载失败或恢复接口返回 404 | 先确认当前账号是空间所有者；若已有权限且旧后端仍在运行，在 IDEA 重启 `CollabServer-local` 后刷新前端 |
| 删除内容恢复后，原标签页仍提示内容已删除 | 从回收站成功提示或对应栏目重新打开，也可以刷新原标签页 |
| `8080` 或 `5173` 被占用 | 检查是否已经运行项目；使用原服务或显式指定另一端口，勿重复启动 |
| 找不到 `java` / `mvn` / `node` | 设置环境变量后重新打开 IDE，或使用脚本的路径参数 |
| `JWT_SECRET 至少需要 32 字节` | 确认启用了 `local` 和外部配置路径；不要把密钥发到聊天或写进源码 |
| `Access denied for user` / 数据库连接失败 | 检查 MySQL 服务、本地用户名、密码、数据库名；保留已有数据库 |
| `node_modules` 不完整 | 在 `frontend` 目录执行 `npm.cmd ci`，然后重新启动前端 |
| JAR 被检测出包含 `application-local.yml` | 去掉 `-SkipBuild` 重新构建，确认 `server/pom.xml` 已排除本地文件 |
| 在 `8080` 看见较旧页面 | 正式 Vue 前端入口是 `5173`；`server/static` 保留的是早期页面 |

需要演示账号时，使用现有账号或按 [README 的演示数据说明](../README.md#演示数据) 运行 seed 脚本。项目没有在前端公开的通用密码。
