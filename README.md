# 多人实时协同编辑系统（毕业设计）

**题目**：基于 SpringBoot 与 WebSocket 的多人实时协同编辑系统的设计与实现
**结构**：自研协同引擎（统一元素模型 + LWW + Lamport 时钟）驱动文档/白板/看板三类协同应用 + 平台支撑（JWT、空间权限、快照与操作日志持久化、版本历史、检索导出、统计）

## 模块

```
collab-editor/
├── pom.xml          # Maven 父工程（engine + server 两模块）
├── engine/          # 自研协同引擎核心（纯 Java 库）
│                     #   元素模型 / Lamport 时钟 / LWW 合并 / 收敛测试
├── server/          # SpringBoot 3 服务端（REST + WebSocket 实时层 + 认证 + 持久化）
├── frontend/        # Vue 3 + Vite 前端（编辑器三应用 + 管理控制台）
└── db/              # MySQL 初始化脚本（库与表结构）
```

## 环境（本机实测版本）

| 项 | 版本 |
|---|---|
| JDK | 21.0.10 LTS |
| Maven | 3.9.14 |
| Spring Boot | 3.5.x |
| Node | 22.x |
| MySQL | 8.0.45 |

## 构建与运行

```bash
# 1. 编译（根目录）
mvn.cmd -q clean package

# 2. 初始化数据库（首次）
mysql -uroot -p < db/init.sql

# 3. 启动服务端
java -jar server/target/server-0.1.0.jar

# 4. 健康检查
curl http://localhost:8080/api/health

# 5. 前端（开发模式，另开终端）
cd frontend && npm install && npm run dev   # http://localhost:5173
```

## 里程碑进度（T0 = 2026-09-10）

- [x] T0+1 预热：多模块脚手架 + /api/health 跑通
- [ ] T0+2 引擎核心：元素模型 + LWW 合并 + 收敛 JUnit
- [ ] T0+3 实时层：WebSocket 协议 v1（join/op/sync/presence）
- [ ] T0+4 持久化：MySQL 快照 + op 日志 + 恢复
- [ ] T0+5 协同文档 / T0+6 协同白板 / T0+7 协同看板
- [ ] T0+8 账号体系 JWT / T0+9 空间权限
- [ ] T0+10 版本历史 / 导出 / 搜索 / 统计
- [ ] T0+11 质量门：收敛性 + 并发性能报告
- [ ] T0+12~16 集成 / 论文 / 答辩

更多规划见 `D:\bishe\plans\项目全案-协同工作台.md`。