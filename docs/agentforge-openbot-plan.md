# AgentForge × OpenBot 融合计划（修订版）

> 更新日期：2026-11-27
> 状态：计划文档，尚未实施
> 来源：OpenBot 上游仓库（https://github.com/OpenHands/OpenBot）+ AgentForge 现有路线图（`agent-platform-roadmap.md`）
> 说明：本计划只吸收机制与契约；开工前应固定 OpenBot 的 commit 或 tag，避免计划随上游漂移。

## 定位

AgentForge 继续保留零依赖、单进程、可直接运行的优势，只吸收 OpenBot 中已经被验证的机制和契约，不移植其 Electron / Bun / Cloudflare 架构，也不把 OpenBot 的产品界面当成 AgentForge 的架构。

所有新增能力都必须能回答以下问题：

- 谁在调用：owner、operator、agent 还是 system？
- 在哪个任务和工作区执行？
- 调用了什么工具、命令或外部服务器？
- 参数和结果是否已审计、脱敏并受大小限制？
- 失败、超时、拒绝和恢复是否有明确状态？

## 当前实现核验

以下结论来自当前源码，不是计划假设：

| 能力 | 当前状态 | 对计划的影响 |
| --- | --- | --- |
| Tool Gateway | 已统一处理工作区读、写、搜索、移动、删除和审计 | MCP 应接入同一层，而不是另开一套工具权限 |
| Shell | `shell` 已出现在工具目录和角色策略中，但平台端点明确返回 501，没有真实执行入口 | shell 不能先于身份、审批和审计边界开放 |
| CLI 执行 | 每次调用启动一次子进程，Provider Profile 只负责环境、参数和路由 | 不能假设存在长期 Provider 会话；MCP 应按执行实例注入或代理 |
| Scheduler | Provider 配额按活跃任务数计数，token 只记在 task / agent 上 | 账户池前必须先建立按 Provider、model、run 的用量账本 |
| Automation | 已有周期、每日、CRUD、重试、历史和启动恢复 | 目前没有审批实体；`await_event` 是独立的状态机改造 |
| 服务安全 | 已有共享服务 Token、CORS、拒绝审计和远程监听保护 | 共享 Token 不是用户身份，也没有 RBAC 或租户隔离 |
| 工作区 | 每个任务有独立工作区，支持 worktree / clone 和变更账本 | Agent 级持久目录、共享目录和租约需要单独设计，不能直接叠加 |
| 上下文 | 有分段预算、稳定前缀、token 估算和上游产物 spill | 还没有真实 compaction 状态，不能伪造“已压缩”或未知窗口 |

## 修订后的阶段

### M3-0：最小服务身份与授权边界（前置）

目标不是做完整多租户，而是让高风险能力有明确的授权主体。

- 引入 `owner / operator / agent / system` 主体模型。
- 服务 Token 增加最小作用域，例如 `read`、`task:write`、`automation:write`、`tool:execute`。
- 写操作和工具调用记录 `actorId`、`actorKind`、`tokenScope`、来源 IP 和请求标识。
- operator-only 端点与 agent 工具权限分开；没有作用域的请求返回 403。
- 暂不实现账号注册、SSO、租户数据隔离和按用户配额。

验收：agent 不能直接调用 operator 端点；未授权工具调用被拒绝并写入审计；现有单用户回环模式仍可零配置启动。

### M3-1：成本、上下文、历史与幂等基础

这是低风险且能直接改善可观测性的第一批增量。

**Provider 用量账本**

- 记录 `providerId`、`model`、`taskId`、`runId`、`agentId`、输入 token、输出 token、估算费用、来源（CLI / API / estimate）和时间。
- 优先使用真实 usage；没有 usage 时明确标记为估算值。
- 在账本可靠后，才实现 fill-first / spread 和 85% 预警。

**上下文状态**

- `/api/state` 增加任务级 `contextStates`：当前估算 token、消息数、文件数、预算上限。
- `contextWindow`、`autoCompactAt`、`lastCompactionAt` 在数据未知时返回 `null`，不能伪造 compaction 状态。
- 前端只展示真实存在的数值和状态。

**历史检索**

- 增加 deferred 工具 `history_search` 和 `history_read`。
- 关键词匹配任务消息、事件和摘要；读取使用 cursor 分页，不覆盖原始记录。
- 摘要截断到固定长度，原始记录仍由任务详情和导出提供。

**Automation 幂等**

- 支持 `clientMessageId`，默认 24 小时窗口内重复请求返回同一任务或同一结果。
- 只做幂等键和重试去重，不在这一批实现 `await_event`。
- `await_event` 需要单独的 durable 等待状态、事件身份、唤醒条件、超时、取消和重启恢复设计，不能并入幂等批次。

验收：重复请求不会创建第二个任务；Provider 账本可按 run 追溯；上下文状态能区分“已知”和“未知”；历史工具不会把全量历史塞进一次响应。

### M3-2：只读外部工具

先接入 MCP 的只读能力，不允许写工具、破坏性工具或任意 shell。

- 增加 MCP server 定义：`id`、`label`、transport、command、args、workingDirectory、env 引用、启动超时和输出上限。
- 密钥只保存环境变量引用，不把明文 secret 写入 `db.json`。
- 每个 Agent / Profile 声明可见的 MCP server 白名单；默认拒绝。
- 工具效果分为 `read / write / execute / destructive`，本阶段只开放 `read`。
- 当前 CLI 是每次调用启动子进程，因此按执行实例注入配置或走 Tool Gateway 代理，不假设长期 Provider 会话。
- 记录启动、工具调用、拒绝、超时、输出截断和结果摘要。

验收：未列入白名单的 MCP 不可见；启动超时不会拖垮任务；密钥不会出现在 `/api/state`、导出或日志中；只读工具调用有完整审计。

### M3-3：受控执行与审批

分两步开放，任何一步都不能直接暴露自由 shell。

**第一阶段：operator-only 固定命令运行器**

- 只允许固定命令白名单，不接受任意 shell 字符串。
- 限制工作目录、超时、输出大小、并发和每 Agent 频率。
- 超时或取消时回收整个进程树。
- 记录命令、参数、退出码、stdout / stderr 摘录、耗时和拒绝原因。
- 先只允许 operator 主体调用，Agent 只能申请，不能直接执行。

**第二阶段：持久化审批队列**

- 增加审批请求、批准、拒绝、过期和取消状态。
- 记录申请人、审批人、任务、Agent、命令、参数和有效期。
- 审批状态必须跨进程重启恢复；重复审批和过期审批不能执行。
- 前端增加审批列表和详情，不复用现有 Automation 面板冒充审批 UI。
- 审批链路稳定后，才评估 MCP 写工具。

验收：只有 coder 的团队不能自行获得 shell；高风险命令在没有审批时不会执行；审批通过后只执行一次；超时、拒绝和重启都有可恢复状态。

### M4：Profile 与工作区

这一阶段与执行能力分开，避免同时改变工具权限和文件隔离语义。

- Agent Profile：角色、技能标签、工具白名单、Provider / 模型、最大并发、工作区策略；支持 JSON 导入导出，不包含密钥。
- 工作区池：保留任务级 worktree，新增显式的 Agent 私有目录和 `Shared/`；定义跨任务复用、清理、租约和冲突规则。
- 读后写守卫：写入前校验最近读取版本；人工保存时检测 Agent 是否已修改同一文件。
- 事务回滚：为移动、删除和批量修改建立可回滚操作组。
- DAG 图与时间回放放在工作区 / 事件契约稳定后，只读展示，不改执行内核。

### M5：生产化

- 完整 RBAC、用户身份、租户数据隔离和每用户配额。
- OTLP exporter，并保持本地 trace / span 记录不变。
- 存储抽象、SQLite 或外部数据库、多实例租约和分布式队列。
- 目录懒加载和 `/api/state` 分页。

多实例和 SQLite 涉及“零依赖”承诺，必须先做单独架构决策；当前单实例阶段继续保留 `db.json` 和 dirty 窗口持久化。

## 非目标与 backlog

以下条目本轮只记录，不实施：

| 优先级 | 条目 | 当前情况与建议 |
| --- | --- | --- |
| P1 | P1-5 目录扫描优化 | `listWorkspaceFiles()` 仍会遍历目录并截断；后续改为按需懒加载、索引复用和增量快照 |
| P1 | P1-7 `/api/state` 分页 | 当前返回任务摘要和最新任务详情；后续增加 cursor、摘要字段选择和详情按需加载 |
| P1 | P1-9 spill 推广 | 目前主要覆盖超长上游产物；后续复用于事件、工具输出和导出附件 |
| P1 | P1-10 超时配置化 | 质量门和各阶段仍使用代码内固定预算；后续放进设置与 Agent / Provider Profile |
| P2 | CLI 网关硬编码 | `CANDIDATES` 仍有 magpie 地址、模型和 `--openai-api-key magpie`；统一走 Provider Profile 和模板变量 |
| P2 | 监听与权限边界 | `HOST`、`bypassPermissions`、`yolo` 仍沿用现有策略；单独做安全评审和显式配置 |
| P2 | 辩论多样性检测 | 已有提案、交叉评分和降级标记；后续增加方案相似度和角度覆盖检测 |
| P2 | 读后写守卫 | Tool Gateway 有版本和变更账本，但没有强制读取版本；在 M4 单独实现 |
| P2 | 附件读图 | 当前主要处理文本上下文；后续增加视觉能力声明、图片类型 / 体积校验和脱敏 |
| P2 | 摘要式上下文压缩 | 已有上下文预算和 spill；后续增加可审计的分段摘要，不覆盖原始记录 |

## 执行顺序与决策门

| 顺序 | 阶段 | 进入下一阶段前必须证明 |
| --- | --- | --- |
| 1 | M3-0 身份与审计 | 高风险端点有 operator 授权，拒绝和越权可审计 |
| 2 | M3-1 账本、上下文、历史、幂等 | 重复请求不重复执行，成本和上下文数据可追溯 |
| 3 | M3-2 只读 MCP | 白名单、密钥引用、超时和审计闭环 |
| 4 | M3-3 受控执行与审批 | 固定命令、审批恢复和一次性执行可验证 |
| 5 | M4 Profile / 工作区 | 隔离、清理、冲突和回滚语义明确 |
| 6 | M5 生产化 | 存储和多实例决策完成，零依赖承诺得到明确取舍 |

每阶段至少包含单元测试和真实路径验证；不得为了通过测试 mock 掉真实的命令、工具或持久化路径。M3 完成前不开放自由 shell，不开放 MCP 写工具，不把共享服务 Token 宣传成 RBAC。
