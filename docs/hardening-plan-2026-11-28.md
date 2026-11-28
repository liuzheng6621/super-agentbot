# AgentForge 安全复审与 W1-W20 执行计划

> 复审日期：2026-11-28
> 基线：`feat/dynamic-execution-plan` @ `c96f292`，工作树干净
> 结论：上一轮 W1-W14 方向成立，但需补充安全复审发现；本文件是下一轮实施的唯一执行计划。

## 1. 复审发现

### 1.1 上一轮清单修正

1. 任务租约已有 TTL、PID、10 秒心跳和过期回收；"完全缺僵尸回收"不成立。缺口是 Automation claim 只有启动期 TTL，运行期不持续续约。
2. `CANDIDATES` 已无 Magpie 地址和 `127.0.0.1:3425` 硬编码；残余默认项是 gemini / qwen / ollama 的默认模型与授权参数，应继续迁入 Provider Profile。

### 1.2 新增漏洞与缺口

| 编号 | 等级 | 发现 | 位置 |
| --- | --- | --- | --- |
| F1 | P0 | `tokenEnabled=false` 时任意来源直接获得 `owner / scopes:["*"]`；配合 `AGENTFORGE_ALLOW_INSECURE_REMOTE=1` 即公网全权。 | `server/security.mjs:185` |
| F2 | P0 | 不校验 `Host`，`corsDecision` 用 `Origin` 的 host 与 `Host` 头比对判同源，攻击域解析到 127.0.0.1 后即为同源请求（DNS rebinding），可直接 POST `/api/settings`、`/api/tasks`；无 `Origin` 请求一律放行，非浏览器客户端不受限制；`/api/shutdown` 只查 remoteAddress。 | `server/security.mjs:300`、`server/index.mjs:1620` |
| F3 | P0 | external workspace 接受宿主任意已存在目录；`task:write` 主体可让 CLI 以 `workspace-write` 写任意目录，跨租户可借路径逃逸租户隔离。 | `server/store.mjs:2033`、`server/index.mjs:1218` |
| F4 | P1 | `readSpillText` 信任 db 中 locator 任意路径，未限制在 `spillRoot()` 内，也没有符号链接防护。 | `server/fs.mjs:104` |
| F5 | P1 | Hook Token 在 URL 路径中且绕过 scope 体系；GET 返回任务摘要，POST 创建 default 租户任务。 | `server/index.mjs:1595` |
| F6 | P1 | `/api/state` 未剔除 `settings.hookToken`，所有具备 `read` 作用域的主体可见。 | `server/index.mjs:180` |
| F7 | P1 | 质量门子进程沿用 `spawnCli` 的 `...process.env` 继承，`OPENAI_API_KEY`、`GEMINI_API_KEY` 等可进入纯测试命令；根因在 CLI 通用环境拼装，不在质量门本身。 | `server/orchestrator.mjs:2120`、`server/adapters.mjs:265` |
| F8 | P0 | `detectTestCommand` 只排除 "no test specified"；`"test":"exit 0"`、空断言测试、无测试证据的 exit 0 仍可通过质量门。 | `server/test-entry.mjs:53`、`server/orchestrator.mjs:2077` |
| F9 | P1 | 评审独立性只比较 Agent ID；同一 CLI + 同一 Provider + 同一模型的自审不被标记。 | `server/review-independence.mjs:13` |
| F10 | P2 | 任务创建前无基于历史 usage 的成本预估区间与确认门。 | `server/store.mjs` usageLedger |
| F11 | P2 | 内容寻址附件与 spill 无引用 GC；`attachmentUrl()` 无任何调用方，属死代码（附件 GET 路由已在 `server/index.mjs:1314` 单独注册）。 | `server/store.mjs:2272`、`server/attachments.mjs:143` |

## 2. W1-W20 工作项

| 编号 | 优先级 | 工作项 | 主要文件 | 验收条件 | 状态 |
| --- | --- | --- | --- | --- | --- |
| W1 | P0 | 评审身份与模型独立性 | `server/review-independence.mjs`、`server/orchestrator.mjs`、`public/app.js` | 独立性判定包含 resolved Provider、model、CLI command；同模型自审写入 `self-review` 事件并在 `/api/state` 与 UI 可见；多角色场景 reviewer 身份与实现者不同。 | 已完成（`tests/review-independence.test.mjs`） |
| W2 | P0 | 质量门反伪造与环境隔离 | `server/test-entry.mjs`、`server/orchestrator.mjs`、`server/adapters.mjs` | trivial `scripts.test`（`exit 0`、空 echo、占位符）判失败；本次变更文件与测试文件无交集时给出显式状态；runner 输出无 pass/fail 证据时 fail closed；保留退出码、超时和输出记录；质量门子进程只继承最小环境白名单，Provider / CLI 密钥不进入测试命令（F7）。 | 已完成（`tests/quality-forgery.test.mjs`） |
| W3 | P0 | 启动成本边界 | `server/team.mjs`、`server/index.mjs` | 默认启动只做本地存在性、版本和配置探测；真实提示词调用只能由显式 probe 或体检触发；保留 `AGENTFORGE_SKIP_TEAM_BOOTSTRAP` 兼容。 | 已完成（`tests/team-startup.test.mjs`） |
| W4 | P1 | 成本预估与确认门 | `server/index.mjs`、`server/store.mjs`、`public/app.js` | 任务创建前按同模式历史 usage 给 token 区间，不伪造费用换算；超过阈值时任务进入待确认且 UI 可见。 | 已完成（`tests/cost-gate.test.mjs`） |
| W5 | P1 | Provider 并发跨进程仲裁 | `server/scheduler.mjs`、`server/store.mjs`、`server/store-leases.mjs` | Provider 并发计数进入 `.leases.json`；两实例并发测试不超过配置配额；冲突有等待原因和审计。 | 已完成（`tests/provider-lease.test.mjs`） |
| W6 | P1 | Automation claim 心跳 | `server/store.mjs`、`server/automation-runner.mjs` | 运行中 claim 定期续约；进程崩溃后 TTL 到期可回收；幂等和取消语义测试覆盖。 | 已完成（`tests/automation-claim.test.mjs`） |
| W7 | P1 | 任务分片持久化 | `server/store.mjs` 或新 persistence 模块 | `tasks/<id>.json` + 索引；原子写、崩溃恢复、旧 `db.json` 迁移和备份；跨实例合并写测试。 | 已完成（`tests/task-shards.test.mjs`） |
| W8 | P2 | Store 门面拆分 | `server/store.mjs`、新 persistence / leases / events / trace 模块 | 只做机械搬移，公开 API 不破坏；每个模块有直接单元测试；全量测试通过。 | 已完成（`tests/store-modules.test.mjs`） |
| W9 | P0 | 目录白名单 | `server/index.mjs`、`server/store.mjs`、`server/path-roots.mjs` | `/api/fs` 与 external workspace 使用独立可配置白名单；白名单外 403；非 owner/admin 主体禁 external workspace；worktree isolation 白名单同步生效。 | 已完成（`tests/path-allowlist.test.mjs`、`tests/http-hardening.test.mjs`） |
| W10 | P0 | 回环与无 Token 加固 | `server/security.mjs`、`server/index.mjs` | 非 GET 无 Token 请求必须同源 `Origin + Sec-Fetch-Site`；Host 校验拒绝 DNS rebinding；insecure remote 拒绝 `operator:admin` 且不得授予 owner；覆盖 CSRF / rebinding 场景。 | 已完成（`tests/http-hardening.test.mjs`） |
| W11 | P1 | Spill 与附件根目录校验 | `server/fs.mjs`、`server/attachments.mjs` | locator 必须解析到 `spillRoot()` / `attachmentRoot()` 内；符号链接逃逸拒绝；哈希与大小校验保留。 | 已完成（`tests/spill-root.test.mjs`） |
| W12 | P1 | Hook Token 规范化 | `server/index.mjs`、`server/store.mjs` | 支持 header Token；路径 Token 仅兼容模式；可轮换或禁用；GET 降级为无敏感摘要；`hookToken` 从 `/api/state` 剔除。 | 已完成（`tests/hook-token.test.mjs`） |
| W13 | P2 | 附件与 spill GC | `server/attachments.mjs`、`server/fs.mjs`、`server/store.mjs` | 基于任务删除级联或保留期加引用扫描；共享内容寻址文件只按引用计数清理；GC 后仍可读回的回归测试。 | 已完成（`tests/storage-gc.test.mjs`） |
| W14 | P2 | 通用 API 限流 | `server/index.mjs`、`server/security.mjs` | 认证失败、任务创建、FS 浏览有 per-principal / per-IP 固定窗口或 token bucket；超限 429 且审计可见。 | 已完成（`tests/rate-limit.test.mjs`） |
| W15 | P2 | CI 浏览器必跑 | `.github/workflows/ci.yml`、`tests/` | CI 安装真实浏览器；浏览器用例跳过仅在本地允许，CI 跳过失败；至少覆盖登录、状态和工作区入口 DOM 断言。 | 已完成（`tests/folder-picker.test.mjs`（浏览器必跑）） |
| W16 | P2 | 前端最小拆分 | `public/app.js` | 按低风险 feature 拆 2-3 个 ESM 模块；不引入构建；行为与现有测试保持不变。 | 已完成（`public/lib/format.js`、`public/lib/status.js`） |
| W17 | P2 | 类型与覆盖率门槛 | `package.json`、`tests/` | JSDoc `tsc --allowJs --checkJs --noEmit` 或等价零运行时方案；核心模块覆盖率下限可配置且 CI 可见；引入 devDependency 需说明理由。 | 已完成（`npm run check:types`、`npm run test:coverage`） |
| W18 | P2 | 文档与仓库卫生 | `README.md`、`docs/` | Gitee / GitHub 地址分流正确；README 首屏定位、快速开始和边界；数字口径标环境或区间；品牌大小写统一。 | 未开始 |
| W19 | P2 | 辩论角度覆盖接入 | `server/debate-analysis.mjs`、`server/orchestrator.mjs`、`public/app.js` | 检测侧已完成（`proposalDiversity` 输出 `angleCoverage` 与 `angle-coverage-low`，`tests/debate.test.mjs:156` 有断言）；本项只做消费侧：警告写入任务事件并在 UI 可见，重复提案扣分补独立断言，不重复实现检测逻辑。 | 未开始 |
| W20 | P2 | Automation await_event 跨实例加固 | `server/store.mjs`、`server/automation-runner.mjs` | durable `await_event` 的等待、eventId 匹配、幂等唤醒、取消、对账和租约互斥已完成，不重做；本项只补 delta：跨实例 claim 冲突可恢复、唤醒事件身份不可重放的显式测试、API 与 UI 状态一致。 | 未开始 |

## 3. 实施顺序

按依赖与风险排序，每项一个 commit，commit message 前缀使用 W 编号：

1. 安全边界：W9、W10、W11、W12。
2. 核心卖点：W1、W2。
3. 成本边界：W3、W4。
4. 存储与并发：W5、W6、W7、W8。
5. 工程化：W13、W14、W15、W16、W17。
6. 文档与扩展：W18、W19、W20。

每项执行前先写最小失败测试；失败测试必须先在修复提交前复现，再由修复提交转绿。禁止 mock 掉真实执行路径、命令探测或持久化落盘。实施分支建议 `feat/hardening-and-cost-boundary`；完成后按仓库现行约定推 GitHub 与 Gitee 双远端。

## 4. 统一验收

```powershell
npm test
npm run check:syntax
```

安全项额外要求：

- F1-F11 每项有最小复现测试，修复前失败、修复后通过；F6-F11 允许归入对应 W 项的测试文件，但必须在提交说明里点名覆盖关系。
- 测试统一在隔离数据目录下运行，并设置 `AGENTFORGE_SKIP_TEAM_BOOTSTRAP=1`，避免启动体检发出真实提示词调用。
- W15 的浏览器用例在 CI 必跑，本地允许显式跳过；跳过不算通过。
- W9-W12 必须覆盖 Token 主体矩阵：owner、operator、agent、无 Token 回环、无 Token insecure remote。
- W7 迁移测试必须覆盖旧 `db.json` 到分片、崩溃和重新加载。
- W10 必须覆盖 `Origin: null`、跨站 Origin、Host 不匹配和 `Sec-Fetch-Site: none`。
