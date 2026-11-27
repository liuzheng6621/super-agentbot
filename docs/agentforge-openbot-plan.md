# AgentForge × OpenBot 融合计划（M3-M5 完成版）

> 更新日期：2026-11-27
> 状态：M3 / M4 / M5 已完成；本轮 P1-9、P1-10 与五项 P2 能力已完成
> 当前文档基线：`14fe33d docs: align plan baseline and remaining backlog`
> 来源：OpenBot 上游仓库（https://github.com/OpenHands/OpenBot）+ AgentForge 现有路线图（`agent-platform-roadmap.md`）
> 说明：本计划只吸收机制与契约，不移植 OpenBot 的 Electron / Bun / Cloudflare 架构。

当前缺陷、残余验收项与 agent-web 接入判断见 [fix-plan.md](fix-plan.md)。

## 定位

AgentForge 继续保留零依赖、零构建、可直接运行的优点，并通过 JSON 文件锁与租约支持多实例共享状态。它不把单机工具包装成完整 SaaS，也不把进程内 Automation / Scheduler 宣传成分布式队列。

所有能力都必须能回答：

- 谁在调用：owner、operator、agent 还是 system？
- 在哪个任务、租户和工作区执行？
- 调用了什么工具、命令或外部服务器？
- 参数和结果是否已审计、脱敏并受大小限制？
- 失败、超时、拒绝和恢复是否有明确状态？

## 当前实现核验

以下结论来自当前源码与测试，不是计划假设：

| 能力 | 当前状态 | 实际边界 |
| --- | --- | --- |
| Tool Gateway | 已覆盖工作区读、写、搜索、移动、删除、事务和审计 | Agent 调用必须带工具白名单；人工管理员通道仍可绕过 Agent 白名单 |
| Shell / 命令 | 固定命令白名单、operator 审批、一次性执行、超时和进程树回收 | 不开放任意 shell；Agent 只能申请，不能自行批准 |
| CLI 执行 | 每次调用启动独立子进程，Provider Profile 负责环境、参数、路由和回退 | 没有长期 Provider 会话；`inherit` 不是内核级隔离 |
| Scheduler | 全局任务并发、Provider 配额、Agent 租约和排队原因可见 | Automation / Scheduler 仍是进程内调度，不是分布式队列 |
| Automation | 周期 / 每日、CRUD、暂停恢复、重试、历史、启动恢复和 durable `await_event` | 事件等待持久化在 `settings.automations`；进程内调度器仍不是分布式队列 |
| 服务安全 | owner / operator / agent / system 主体、Token 作用域、租户过滤、配额和审计 | 不是完整账号、RBAC、SSO 或按用户计费 |
| 工作区 | 任务级 worktree / clone、显式工作区池、读后写版本守卫、事务回滚 | 跨任务池默认关闭；平台产物配额已实现，外部项目文件不计入配额 |
| 上下文 | 分段预算、稳定前缀、token 估算、spill、`contextStates`、自动摘要、质量评估与压缩回放 | 摘要仍是抽取式，不是模型生成的语义摘要 |
| 可观测性 | 本地 trace / span、OTLP/HTTP JSON 导出、任务详情和运行记录导出 | OTLP 失败只记录状态，不影响本地任务执行 |
| 状态接口 | `/api/state` 支持 cursor 分页、摘要字段选择和 active 详情按需加载 | 无参数请求保留全量旧响应以兼容现有客户端 |

## 已完成阶段

### M3-0：最小服务身份与授权边界

已完成：

- owner / operator / agent / system 主体模型。
- Token 作用域：`read`、`task:write`、`automation:write`、`tool:execute`、`command:execute`、`command:request`、`command:approve`、`operator:admin`。
- 高风险端点按 operator / command scope 校验，越权请求写入安全审计。
- 回环单用户仍可零配置启动。

验证：`tests/security.test.mjs`、`tests/http-security.test.mjs`、`tests/approvals.test.mjs`。

### M3-1：成本、上下文、历史与幂等基础

已完成：

- Provider 用量账本记录 `providerId / model / taskId / runId / agentId / tokensIn / tokensOut / estimatedCost / source / at`；未知成本保持 `null`。
- `/api/state` 暴露任务级 `contextStates`，未知窗口保持 `null`，压缩记录保留摘要和原始消息引用。
- `history_search` / `history_read` 只读、任务内限定、cursor 分页。
- `clientMessageId` 在 24 小时窗口内返回同一任务，不重复创建工作区。

验证：`tests/context-budget.test.mjs`、`tests/collaboration.test.mjs`、`tests/automation.test.mjs`、`tests/quality.test.mjs`。

### M3-2：只读外部工具

已完成：

- MCP server 定义、transport、command、args、工作目录、环境变量引用、启动超时和输出上限。
- Agent / Profile 的 MCP server 白名单默认拒绝。
- 只开放 `read` 效果；写工具、破坏性工具和任意 shell 继续拒绝。
- 启动、调用、拒绝、超时、截断和结果摘要都有审计；密钥只保留环境变量引用。

验证：`tests/mcp.test.mjs`、`tests/http-security.test.mjs`。

### M3-3：受控执行与审批

已完成：

- operator-only 固定命令白名单，不接受任意 shell 字符串。
- 工作目录、超时、输出大小、并发和频率限制。
- 超时 / 取消时回收进程树，并记录命令、参数、退出码、stdout / stderr 摘录和耗时。
- 持久化审批请求、批准、拒绝、过期、取消和一次性执行；重启后未完成审批 fail closed。

验证：`tests/approvals.test.mjs`、`tests/http-security.test.mjs`。

### M4：Profile 与工作区

已完成：

- Agent Profile：角色、技能、工具、MCP、Provider / 模型、并发、工作区策略；支持导入导出且不包含密钥。
- 工作区池：任务级 worktree 优先，跨任务 `Shared/` 或 Agent 私有目录必须显式开启，默认不跨任务。
- 读后写守卫：修改已有文件必须提交最近读取版本，陈旧写入返回冲突并留痕。
- 事务回滚：移动、删除和批量写入按操作组提交；中途失败回滚真实文件和元数据。
- DAG 图、时间回放、跨任务总览：只读投影，不改执行内核。

验证：`tests/profiles.test.mjs`、`tests/workspace.test.mjs`、`tests/overview.test.mjs`。

### M5：生产化

已完成：

- 租户级任务、Automation、审批和状态过滤，以及任务配额。
- OTLP/HTTP JSON trace 导出，同时保留本地 trace / span。
- 零依赖多实例：`db.json` 文件锁合并写、`.leases.json` 任务与 Automation 租约、写冲突检测。
- 工作区目录懒加载和 `/api/state` cursor 分页。

验证：`tests/tenant-isolation.test.mjs`、`tests/otlp.test.mjs`、`tests/multi-instance.test.mjs`、`tests/state-pagination.test.mjs`、`tests/workspace.test.mjs`。

## 执行顺序与完成证据

| 顺序 | 阶段 | 状态 | 完成证据 |
| --- | --- | --- | --- |
| 1 | M3-0 身份与审计 | 已完成 | 作用域校验、越权审计、回环兼容测试 |
| 2 | M3-1 账本、上下文、历史、幂等 | 已完成 | 用量账本、`contextStates`、分页历史、幂等测试 |
| 3 | M3-2 只读 MCP | 已完成 | 白名单、密钥引用、超时和审计测试 |
| 4 | M3-3 受控执行与审批 | 已完成 | 固定命令、一次性审批、重启恢复测试 |
| 5 | M4 Profile / 工作区 | 已完成 | Profile、池、读后写、事务、DAG / 回放测试 |
| 6 | M5 生产化 | 已完成 | 租户、OTLP、多实例、懒加载、分页测试 |

全量验证：`npm test`（统一隔离数据目录）；跨平台矩阵由 `.github/workflows/ci.yml` 运行。测试数量随用例增减，不在计划中固定。

## 本轮已完成

| 条目 | 完成内容 | 主要验证 |
| --- | --- | --- |
| P1-9 spill 推广 | 大事件、消息和工具输出保留 spill 引用；Markdown / HTML 导出超限时生成附件句柄与响应头 | `tests/context-budget.test.mjs` |
| P1-10 超时配置化 | 提案、质询、裁决、工序和质量门超时可由全局设置、Provider Profile 和 Agent Profile 分层覆盖 | `tests/timeouts.test.mjs` |
| 辩论多样性 | 提案指纹、相似度分组、角度覆盖率、重复提案扣分和前端告警 | `tests/debate.test.mjs` |
| CLI 网关去硬编码 | 内置 CLI 候选移除 Magpie 地址、模型和凭据参数，改由 Provider Profile `cliBindings` 注入 | `tests/adapters.test.mjs` |
| 附件读图 | 声明视觉能力；校验 PNG / JPEG / WebP / GIF 类型、体积、尺寸和像素；只持久化内容寻址引用 | `tests/attachments.test.mjs` |
| 上下文压缩 | 阈值自动触发、来源范围去重、摘要质量、历史、原文保留和按来源回放 | `tests/context-budget.test.mjs` |
| Automation durable `await_event` | 持久等待、eventId 匹配、幂等唤醒、取消、完成对账、租约互斥、API 与 UI 可见 | `tests/automation.test.mjs`、`tests/http-security.test.mjs` |
| 测试入口结构提取 | `server/test-entry.mjs` 已承接测试文件枚举和命令生成，`orchestrator.mjs` 保留兼容导出 | `tests/quality.test.mjs` |
| 文件夹选择器浏览器验收 | 真实 Edge/CDP 覆盖当前构建；缺少浏览器时显式跳过 | `tests/folder-picker.test.mjs` |
| agent-web 开发期验收 | 固定提交 `fe543ea`，真实 HTTP 适配器跑通 10 个核心案例；可选、不进入生产依赖 | `tests/agent-web-compat.test.mjs` |

## 后续 backlog

以下条目不在 M3-M5 已完成范围内，保留为后续工作：

| 优先级 | 条目 | 当前情况与建议 |
| --- | --- | --- |
| P2 | 监听与权限边界 | `HOST`、`bypassPermissions`、`yolo` 仍沿用现有策略；单独做安全评审和显式配置 |
| P2 | 完整账号 / RBAC / SSO | 当前是 Token 主体和租户过滤，不是完整用户身份体系 |
| P2 | 外部数据库 / 分布式队列 | 当前是 JSON + 文件锁 + 租约；SQLite 或队列引入前需单独架构决策 |

每项实现前都应先补最小失败测试；不得为了通过测试 mock 掉真实命令、工具或持久化路径。
