# GitHub 发布说明与验证

日期：2026-10-26（Asia/Shanghai）。远程仓库：<https://github.com/Muco-1117/collab-editor>，默认分支 `main`。

## 内容

发布源码、数据库初始化脚本、前端 / 引擎 / 服务端测试、本地启动脚本和架构 / API / 协议 / 部署文档。保留本地已有功能及提交历史；新增根目录贡献与安全说明。

`application-local.*`、用户上传、构建产物、运行日志、测试证据、交付制品和 Python 缓存不进入当前主分支。早期已跟踪的 `artifacts/` 文件本次通过 Git 索引清理；本地文件继续保留，历史提交中的记录未重写。

`.run/CollabServer-local.run.xml` 只保存相对路径与启动参数，不包含账号密码，作为文档引用的可移植 IDEA 配置发布。

## 实际验证

| 命令 | 结果 |
| --- | --- |
| `mvn.cmd -q -pl engine test` | 15 项测试通过，0 失败 / 错误 / 跳过 |
| `npm.cmd test`（frontend） | 20 个测试文件、148 项测试通过 |
| `npm.cmd run build`（frontend） | Vite 生产构建通过 |

本次补做了 `collab_editor_test` 隔离库上的服务端全量集成测试（126 项）、真实多浏览器 E2E（20/20 步）和构建。E2E 覆盖三角色协同、权限、断线恢复、导出与响应式布局。生产部署仍未验收，因为没有可授权的生产服务器、域名和外部服务配置。

依赖审计：`frontend` 的 `npm audit` 当前为 0 vulnerabilities；升级了 `vite`、`vitest` 及 `source-map-js`。测试 E2E 工程的 `npm audit` 也为 0。

验证环境：Windows、JDK 21.0.10（编译目标 Java 17）、Maven 3.9.14、Node.js 24.14.1。
