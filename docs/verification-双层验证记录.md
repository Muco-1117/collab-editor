# 双层自动化验证记录（2026-09-20）

> 版本说明：本文件保留 2026-09-20 的历史验证与方案记录；2026-10-17 新增图片、元素级 STATE、多格式导出后的范围和新证据以 [本轮需求对照与验证](report-alignment-20261017.md) 为准。旧版性能数字不能直接作为新版结果。

本记录只引用最终 Vue 前端、当前 Spring Boot 服务和 MySQL 8 的本轮结果。2026-09-16 的早期静态页面脚本及旧平台累计数字不再作为最终验收证据。

## 一、证据基线

| 项目 | 本轮值 |
|---|---|
| Vue 入口 | `http://127.0.0.1:5173` |
| 后端入口 | `http://127.0.0.1:8080`，`/api/health` 返回 `UP` |
| Playwright 脚本 | `tests/e2e-ui/vue-e2e.mjs` |
| Playwright 版本 | `1.55.1` |
| 最终 runId | `2026-09-20T12-59-33-742Z-mu9tphimjpye` |
| 原始运行目录 | `artifacts/e2e-vue/2026-09-20T12-59-33-742Z-mu9tphimjpye/` |
| 稳定证据目录 | `artifacts/e2e-vue-final-20260920-1300/` |
| 浏览器视口 | 工作流桌面 `1440 x 960`；布局矩阵 `320/390/414/768 x 844`、`1440 x 900` |
| 隔离方式 | `owner`、`editor`、`viewer` 三个独立 browser context；每轮唯一账号、空间和文档键 |

原始目录的 36 个运行产物已复制到稳定证据目录，并另生成 `SHA256SUMS.txt`；所有源文件按文件名和 SHA-256 全量核对一致，没有删除其他历史 run。

## 二、界面层：真实 Vue Playwright（14/14 PASS）

| # | 自动化验证点 | 关键断言 | 结果 |
|---:|---|---|---|
| 1 | 服务可用性 | 健康状态为 `UP` | PASS |
| 2 | 三角色注册登录 | 三个独立 context 均进入仪表盘 | PASS |
| 3 | 空间与邀请 | owner 创建空间；editor/viewer 角色及入口正确 | PASS |
| 4 | 协同文档 | owner/editor 写入实时同步到三端 | PASS |
| 5 | 同段并发 | LWW 唯一获胜，三端收敛且不反转 | PASS |
| 6 | 历史恢复 | 预览目标版本、恢复后三端同步 | PASS |
| 7 | viewer 只读 | 三应用编辑入口不可用；REST 写入返回 `403` | PASS |
| 8 | Markdown 导出 | 下载文件含当前标题和恢复后的正文 | PASS |
| 9 | 协同白板 | 文本、位置和颜色同步；viewer 只读 | PASS |
| 10 | 协同看板 | 两列、卡片及真实拖拽跨列同步；viewer 只读 | PASS |
| 11 | 30 秒断线重连 | WebSocket 传输阻断 `30005 ms`，步骤耗时 `31900 ms`；恢复后补齐，刷新后仍持久化 | PASS |
| 12 | 搜索与统计 | 正文命中；UI `operations=44` 与 API 一致 | PASS |
| 13 | `320/390/414/768/1440 px` 五档布局 | 仪表盘、文档、白板、看板均可见；五档根节点宽度与视口完全一致 | PASS |
| 14 | 运行期错误 | `consoleErrors=0`、`pageErrors=0`、HTTP 5xx `=0` | PASS |

断线测试通过 Playwright WebSocket 透明代理关闭 editor 的页面侧传输，并在 30 秒窗口内拦截重连。恢复传输后由产品自身的退避与 `hello(lastRev)` 流程完成增量补齐；测试没有直接修改客户端状态。

## 三、产物核验

| 证据 | 文件 | 核验结果 |
|---|---|---|
| 总结 | `artifacts/e2e-vue-final-20260920-1300/summary.json` | `status=passed`，14/14，三个错误数组为空 |
| 服务端统计 | `artifacts/e2e-vue-final-20260920-1300/stats.json` | 2 个空间、3 个内容、44 条操作；应用和操作分类完整 |
| 导出 | `artifacts/e2e-vue-final-20260920-1300/export-mu9tphimjpye.md` | UTF-8 标题、恢复正文和 editor 补充段落完整 |
| 响应式截图 | `11-*.png`、`12-*.png` | 20 张，覆盖 1440、768、414、390、320 五档及三应用；人工抽查无遮挡或空白 |
| 原流程截图 | `01-owner-default-space.png` 至 `10-collaboration-stats.png` | 10 张，三应用、权限、历史、搜索和统计状态可见 |
| SHA-256 清单 | `artifacts/e2e-vue-final-20260920-1300/SHA256SUMS.txt` | 原始产物复制后逐文件生成哈希清单 |
| 调试 trace | `trace-owner.zip`、`trace-editor.zip`、`trace-viewer.zip` | 三份均非空，可回放三个独立 context |

白板固定画布和看板多列在各自滚动容器内滚动，不计为页面全局溢出。自动化对五档视口的仪表盘、文档、白板和看板逐页断言 `documentElement.scrollWidth <= clientWidth + 1`，并等待各编辑器根容器可见。

## 四、协议与服务层

同日 clean 全量 Maven 测试结果为 engine 12/12、server 34/34，合计 46/46，失败、错误和跳过均为 0。并发测试采用同房间 closed-loop 模型，每客户端最多一条未确认操作；10/50/100 客户端三档广播、发送者确认、数据库 `operation_id` 和连续 `seq` 均完整，`lost=0`、`duplicate=0`。详细指标与最终 20:56 原始 XML 见 [性能报告](performance-report.md) 和 `artifacts/test-reports/final-maven-20260920-2056-default/server/TEST-com.bishe.server.ws.ConcurrentLoadTest.xml`。

界面层证明真实用户工作流、权限和响应式布局可用；协议与服务层证明收敛、持久化、错误处理和并发质量门通过。两层证据共同覆盖任务书中的三应用协同、权限、历史、检索导出、统计、断线恢复和性能验证。

## 五、复跑命令

先按 [部署说明](deployment.md) 启动 MySQL、后端和 Vite，然后执行：

```powershell
Set-Location tests/e2e-ui
npm ci
npx playwright install chromium
npm test
```

默认断线窗口为 `30000 ms`；仅调试测试夹具时可临时设置 `E2E_OFFLINE_MS`，但缩短窗口的 run 不得作为最终验收证据。每轮原始结果位于 `artifacts/e2e-vue/<runId>/`。

## 六、本轮修正与结论

本轮修正均位于 E2E 夹具：相同 hash 路由显式 reload、移动端已激活空间不再点击收起侧栏、预期 `403` 改由 `APIRequestContext` 发起以保持浏览器 console 零错误、WebSocket 路由精确控制断线窗口，并加入五档视口布局矩阵。未发现当前覆盖范围内需要继续开放的产品缺陷。

结论：当前范围内的最终 Vue 界面 E2E 与协议/服务测试均通过，证据可复跑、可回放、可核对。
