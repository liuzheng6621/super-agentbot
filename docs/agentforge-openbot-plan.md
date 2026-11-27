# AgentForge × OpenBot 融合计划（M3-M5 完成版）

> 更新日期：2026-11-27
> 状态：M3 / M4 / M5 已完成；本文件保留能力边界与后续 backlog
> 来源：OpenBot 上游仓库（https://github.com/OpenHands/OpenBot）+ AgentForge 现有路线图（`agent-platform-roadmap.md`）
> 说明：本计划只吸收机制与契约，不移植 OpenBot 的 Electron / Bun / Cloudflare 架构。

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
| Automation | 周期 / 每日、CRUD、暂停恢复、重试、历史和启动恢复 | `await_event` 尚无 durable 等待状态 |
| 服务安全 | owner / operator / agent / system 主体、Token 作用域、租户过滤、配额和审计 | 不是完整账号、RBAC、SSO 或按用户计费 |
| 工作区 | 任务级 worktree / clone、显式工作区池、读后写版本守卫、事务回滚 | 跨任务池默认关闭；磁盘配额和任务优先级未实现 |
| 上下文 | 分段预算、稳定前缀、token 估算、spill、`contextStates` 和可审计压缩记录 | 自动摘要策略仍可继续打磨 |
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

全量验证：`node --test tests/*.test.mjs`，当前 `160 / 160` 通过。

## 后续 backlog

以下条目不在 M3-M5 已完成范围内，保留为后续工作：

| 优先级 | 条目 | 当前情况与建议 |
| --- | --- | --- |
| P1 | P1-9 spill 推广 | 目前主要覆盖超长上游产物；后续复用于事件、工具输出和导出附件 |
| P1 | P1-10 超时配置化 | 质量门和各阶段仍有固定预算；后续放进设置与 Agent / Provider Profile |
| P2 | CLI 网关硬编码 | `CANDIDATES` 仍有 magpie 地址、模型和 `--openai-api-key magpie`；统一走 Provider Profile 和模板变量 |
| P2 | 监听与权限边界 | `HOST`、`bypassPermissions`、`yolo` 仍沿用现有策略；单独做安全评审和显式配置 |
| P2 | 辩论多样性检测 | 已有提案、交叉评分和降级标记；后续增加方案相似度和角度覆盖检测 |
| P2 | 附件读图 | 当前主要处理文本上下文；后续增加视觉能力声明、图片类型 / 体积校验和脱敏 |
| P2 | 摘要式上下文压缩自动化 | 已有预算、spill 和可审计压缩记录；后续增加自动触发、摘要质量和回放策略 |
| P2 | Automation durable `await_event` | 当前没有 durable 等待状态、事件身份、唤醒或取消语义；单独设计状态机 |
| P2 | 完整账号 / RBAC / SSO | 当前是 Token 主体和租户过滤，不是完整用户身份体系 |
| P2 | 外部数据库 / 分布式队列 | 当前是 JSON + 文件锁 + 租约；SQLite 或队列引入前需单独架构决策 |

每项实现前都应先补最小失败测试；不得为了通过测试 mock 掉真实命令、工具或持久化路径。
