# 贡献指南

Issue 请包含预期行为、实际行为、复现步骤，以及浏览器 / JDK / Node.js 版本。涉及协同时，说明同时在线的账号角色、内容类型和断线情况。不要附上数据库密码、JWT、用户正文或含凭据的完整网络跟踪。

PR 应说明修改原因、行为变化、涉及模块和验证结果。调整协议或元素模型时，同步更新 `docs/websocket-protocol.md`；调整部署配置时更新 `docs/deployment.md`。

## 验证

```powershell
mvn.cmd -q -pl engine test
npm.cmd --prefix frontend ci
npm.cmd --prefix frontend test
npm.cmd --prefix frontend run build
```

服务端集成测试需要独立的 `collab_editor_test`，会重建该库。先检查 [测试计划](docs/test-plan.md) 和 [服务端测试说明](server/src/test/README.md)，不要使用开发或生产数据库。

构建输出、运行日志、测试证据、用户上传、个人配置和凭据不进入 Git。仓库保留的第三方许可见 `frontend/src/styles/vendor/shadcn-vue.LICENSE`；项目整体尚未指定开源许可证，复用前请先确认授权范围。
