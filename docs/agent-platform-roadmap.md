# AgentForge 平台能力评估与演进路线

> 评估日期：2026-11-27

本文基于当前仓库实现，区分“已经落地”“已有边界”和“下一阶段建议”，避免把提示词约束、平台 API 和真实 Tool Gateway 混为一谈。M3 / M4 / M5 已完成，当前 `178 / 178` 测试通过。

## 1. 工具调用能力

### 现状

平台侧已经具备一套可测试的工作区文件能力：

| 能力 | 当前实现 | 可靠性措施 |
| --- | --- | --- |
| 查 | 工作区树、按路径读取、全文搜索 | 深度/数量/体积上限；跳过依赖与构建目录 |
| 增 | 新建文件、新建目录 | 相对路径校验；2 MB 写入上限；原子写 |
| 改 | 覆盖写入、全屏编辑器保存 | 修改已有文件必须提交最近读取版本；写入后 sha256 版本；变更事件 |
| 移 | 文件/目录移动与重命名 | 源/目标边界校验；目标冲突检测；可纳入事务 |
| 删 | 移入 `.agentforge/trash` | 可恢复；删除事件与变更记录；可纳入事务 |
| 审 | Git diff、未跟踪文件 diff | 对比 `HEAD`；二进制/敏感/超限文件保护 |

安全边界包括：

- 拒绝绝对路径、`..` 穿越和符号链接路径。
- 禁止通过文件 API 直接访问 `.git`、`.agentforge`。
- 禁止预览和平台写入常见敏感文件（`.env*`、私钥、`.npmrc`、`.pypirc` 等）。
- 所有 Agent 配置带工具白名单；平台 API 在收到 `agentId` 时会校验对应工具。

### 当前边界

平台 API 已统一经第一层 Tool Gateway，真实 CLI 另有第二层执行策略预检：

- `executionPolicy=strict` 时，平台按 Agent 工具白名单推导 `read-only` / `workspace-write`，覆盖 CLI 参数中的危险沙箱开关；Codex / DSH 映射原生沙箱，Claude 仅允许无 shell 的只读工具白名单。
- `strict` 下无法证明边界的命令或能力组合返回 `-6`，不启动子进程；`inherit` 仍保留兼容行为，CLI 可以自行使用本机工具。
- 每次真实 CLI 调用记录 `cli.policy.start` / `cli.policy.end` / `cli.policy.denied`，消息元数据保留实际策略、沙箱、边界和拒绝原因。
- 原生沙箱仍不是内核级代理：平台尚未统一拦截 CLI 的网络请求、文件租约和系统调用。
- 前端人工操作不携带 `agentId`，因此不受 Agent 工具白名单限制，这是有意的管理员通道。
- `shell` 只开放固定命令白名单和审批后的单次执行；任意 shell、交互式终端和内核级审计沙箱仍不开放。
- 文件移动、删除和批量写入已有读后写守卫、操作组事务和回滚；跨进程 CLI 内部写仍不能由平台内核级拦截。

### 改进建议

1. **建立 Tool Gateway（第一层已完成）**
   - 所有 Agent 工具调用统一走 `toolId + agentId + taskId + arguments`。
   - 网关执行策略校验、工作区边界校验、审批、超时、审计和结果归一化。
   - CLI 只拿到网关地址和短期任务令牌，不再直接暴露宿主文件系统。

2. **增加操作日志与冲突检测（已完成）**
   - 写前记录文件版本和读取版本；未读取即写时拒绝。
   - 同一路径存在并发写入时返回冲突，由 Agent 重新读取后合并。
   - 为移动、删除、批量修改建立可回滚操作组。

3. **补齐命令执行能力（已完成固定命令路径）**
   - 为 `shell` 增加命令白名单/黑名单、工作目录、超时、输出上限和进程树回收。
   - 高风险命令进入人工审批，结果写入任务事件流。

当前只开放 operator 固定命令白名单和一次性审批；任意 shell、MCP 写工具仍不在范围内。

验收标准：任何 Agent 的工具调用都能回答“谁、在哪个任务和目录、调用了什么、参数是什么、结果如何、是否被策略拒绝”，并且 `strict` CLI 调用能说明实际使用的沙箱与强制边界。

## 2. 与 Magpie 的关系

### 现状

AgentForge 不是基于 Magpie 框架实现，也不再在内置 CLI 候选中携带 Magpie 地址、模型或凭据参数：

- `server/adapters.mjs` 只保留 CLI 原生命令、参数和输入方式。
- Provider Profile 的 `cliBindings` 负责注入模型、Base URL、密钥环境变量引用和 prompt 参数模板。
- Agent 可绑定主 Provider 与有序备用 Provider，真实 CLI 失败后自动回退。

Provider Profile 已落地：Agent 绑定 `providerId`，执行时把 Profile 解析为临时子进程环境，明文密钥不写回 `db.json`；CLI 参数模板、主/备 Provider 自动路由和失败回退也已接入。真实 CLI 子进程的强制工具拦截已由 `server/cli-policy.mjs` 接入第一版原生策略映射，内核级代理仍待补。

因此，当前泛用性瓶颈已从“CLI 适配参数是硬编码的”转移到“不同 CLI 的原生沙箱能力不一致，平台需要持续维护能力矩阵并明确拒绝无法强制的组合”。

### 改进建议：Provider Profile

增加独立的 Provider Profile 层：

```json
{
  "id": "local-magpie",
  "label": "Local Magpie",
  "kind": "openai-compatible",
  "baseUrl": "http://127.0.0.1:3425/v1",
  "apiKeyRef": "env:MAGPIE_API_KEY",
  "defaultModel": "trae-cn/glm-5.3-flash",
  "capabilities": ["chat", "tools", "vision"],
  "cliBindings": {
    "codex": {
      "args": ["-c", "model={{model}}", "{{prompt}}"],
      "env": {}
    },
    "gemini": {
      "args": ["--prompt="],
      "env": {
        "GEMINI_API_KEY": "{{apiKey}}",
        "GOOGLE_GEMINI_BASE_URL": "{{baseUrl}}"
      }
    }
  }
}
```

实现顺序：

1. 把 CLI 参数中的固定网关、模型和凭据改为模板变量。已完成 `cliBindings`。
2. Provider Profile 持久化，并支持创建、测试、复制和停用。已完成创建、测试和停用，复制待补。
3. Agent 可选择 Provider Profile 与模型，健康检查按 Profile 执行。已完成。
4. 增加路由与回退：同一角色可配置主 Provider、备用 Provider 和预算上限。已完成主/备路由和失败回退，费用预算待补。
5. 凭据只保存引用或系统密钥，不把明文 API Key 写进 `db.json`。

验收标准：不修改源码即可新增一个 OpenAI/Anthropic 兼容网关，并让不同 Agent 使用不同 Provider、模型和凭据。

## 3. 工作区、工作树与工作流展示

### 现状

当前已落地：

- 任务级工作区树、文件搜索、文件预览和编辑。
- 全屏工作区控制台：文件、执行泳道、计划版本、协作消息、工具审计、DAG、时间回放、跨任务总览和 Diff。
- 上下文预算、最近协作、已知文件、Agent 工具策略和任务摘要。
- 文件变更、工具调用、运行结果的事件流。
- Git detached worktree 隔离；worktree 元数据不可写时自动回退 shared clone。
- 每个任务独立目录，多个任务可在同一进程内并行运行。
- 显式开启的跨任务工作区池：项目根下的 `Shared/` 或 `Agents/<agentId>/`，默认不跨任务。

### 当前边界

- 已有只读 DAG、时间回放和跨任务总览；仍没有两个 Agent 产出的并排可视化合并评审。
- 工作区树已支持目录懒加载，但超大仓库的索引复用和增量快照仍可继续优化。
- 跨任务工作区池已支持显式共享 / 私有模式，但磁盘配额和自动清理策略仍未实现。

### 改进建议

1. **工作区总览（已完成只读总览）**
   - 顶部展示所有运行中任务、隔离方式、Provider、当前工序、文件变更数和阻塞原因。
   - 支持按项目、Agent、状态筛选，并能直接切换到对应任务控制台。

2. **DAG 与泳道联动（已完成只读图）**
   - 泳道保留“谁在做什么”，新增可缩放的依赖图。
   - 点击节点定位到消息、工具事件、文件 Diff 和上游产物。

3. **时间回放（已完成事件回放）**
   - 以事件时间轴重放规划、讨论、工具调用、文件变更和返工。
   - 目录检查点对比仍待后续。

4. **评审工作台**
   - 并排展示 Agent 方案、实现 Diff、测试结果和评审意见。
   - 人工可选择采纳、局部合并或要求指定 Agent 返工。

验收标准：面对复杂任务，用户不需要翻消息日志就能定位“当前卡在哪、谁负责、改了什么、为什么失败”。

## 4. 并发与 Agent 分工

### 现状

- 同一任务内通过 DAG 并行执行互不依赖的工序。
- 不同任务有独立工作区和运行上下文，可同时运行。
- 每个 Agent 有角色、Provider/CLI、工具白名单和席位状态。
- 工具池允许同一角色存在多个候选成员，失败时可切换。

### 当前边界

- 已有任务级 Scheduler，可限制同时运行的任务数，并展示排队位置和等待原因。
- Provider 配额按绑定该 Provider 的活跃任务计数，不按每次 CLI 调用计数；同一个 Provider 仍可能被单任务内的多个工序并发使用。
- Agent 租约只覆盖显式声明的 Agent；同一任务内可重入，不同任务之间互斥。
- 磁盘配额、任务优先级和 Provider 级费用预算尚未实现；主/备 Provider 回退已实现。
- 已有可复用 Agent Profile（角色、技能、工具、MCP、Provider、模型、并发和工作区策略）；按能力标签自动路由仍可继续增强。

### 改进建议

1. **全局 Scheduler（第一层已完成）**
   - 队列维度：任务、Provider、CLI、工作区。
   - 资源租约：Agent 正在执行时占用租约，支持独占和共享两种模式。
   - 配额：每 Provider 最大并发、每分钟请求数、每日 token/费用上限。
   - 优先级：交互任务优先于 Bot Hook 和批处理任务。

2. **专项 Agent Profile（已完成基础能力）**
   - Profile 组合：角色、技能标签、工具白名单、Provider、模型、工作区范围、最大并发。
   - 规划器按工序能力标签选择候选 Agent，而不是只按五个固定角色。
   - 工具不足时明确标记“能力缺口”，禁止让 Agent 假装完成。

3. **多工作区并行（已完成工作区池）**
   - 同一项目可创建多个隔离 worktree，按任务或分支分组。
   - 合并前做冲突预检，冲突交给指定 Agent 或人工解决。
   - 工作区池已支持显式跨任务复用；磁盘配额和自动清理策略仍待后续。

4. **事件与可观测性**
   - 统一记录调度排队、租约获取、Provider 限流、重试和回退。
   - 在控制台展示任务等待原因，而不是只显示“运行中”。

验收标准：多个任务可以并行推进，但不会超过配置的 Provider、Agent 和工作区资源上限；每个等待和重试都有可解释原因。

## 本轮已落地（2026-11-27）

| 能力 | 状态 | 已实现内容 |
| --- | --- | --- |
| 计划版本 | 已完成 | 初版、返工和手动重规划都生成不可变快照；保留已完成工序；自动重规划最多一次 |
| 协作消息路由 | 已完成 | 消息记录来源、目标、父消息、关联工序、产物引用和 correlationId |
| Tool Gateway 第一层 | 已完成 | 统一工具描述、Owner/Agent/System 主体、工具白名单、工作区执行和审计事件 |
| 工作区控制台 | 已完成 | 计划版本、协作消息、工具审计与原有文件、执行泳道、Diff 统一展示 |
| Provider Profile | 已完成 | Agent 绑定主/备 Profile；Base URL、模型、密钥环境变量引用、CLI 参数模板和并发上限可配置；真实 CLI 失败后按顺序回退 |
| 全局 Scheduler | 第一层已完成 | 任务并发上限、Provider 配额、排队位置、等待原因、Agent 租约和取消排队 |
| CLI 执行策略 | 第一层已完成 | `inherit / strict`；工具白名单推导沙箱；Codex / DSH / Claude 能力矩阵；不可强制时拒绝；策略事件与消息元数据 |
| Shell 沙箱 | 已完成固定命令路径 | 固定命令白名单、operator 审批、一次性执行、超时和进程树回收；任意 shell 仍关闭 |

## M1 首批增量（2026-11-27）

| 能力 | 状态 | 已实现内容 |
| --- | --- | --- |
| Skills MVP | 已完成 | 扫描工作区、源工作区和用户级 `.agents/skills/*/SKILL.md`；解析受控 frontmatter；按触发词、角色和 Agent 显式标签激活；注入讨论、实施、收口和聊天 prompt；记录 `skill.activated` 与任务级激活摘要；不执行技能脚本，不绕过工具权限 |
| Transcript 导出 | 已完成 | `/api/tasks/:id/export?format=markdown\|html`；包含质量门、计划、技能激活、协作消息、事件、产物、文件变更和讨论裁决；输出前脱敏并转义 HTML；界面提供下载入口 |
| P1-8 结构化 VERDICT | 已完成 | reviewer 只接受扁平 JSON `VERDICT`；要求 `decision`、`blockers`、`should`；损坏、缺失、负数和 `PASS + Blocker` 都 fail closed；`blockers / should` 落工序与导出记录 |

Skills 的边界：单个 `SKILL.md` 最大 64 KB，正文最多注入 6000 字符，单次最多激活 4 个技能；不跟随技能目录中的符号链接，不执行技能内脚本。导出是本地运行记录的快照，不替代任务工作区或 Git 历史。

当前有两层边界：平台 API 会校验 Agent 工具白名单并留痕；真实 CLI 在 `strict` 下会先经过执行策略预检，能映射到原生沙箱时才启动。`inherit` 仍可能直接调用本机工具，因此内核级代理和网络策略仍需后续补齐，不能把平台 API 校验当成完整子进程隔离。

## M2 团队服务基线（2026-11-27）

M2 的目标不是把单机项目包装成“多租户 SaaS”，而是把它变成可部署、可访问、可审计的单实例团队服务：

| 能力 | 状态 | 已实现内容 |
| --- | --- | --- |
| 服务安全边界 | 已完成 | 回环地址零配置；非回环监听需要至少 16 字符的 `AGENTFORGE_API_TOKEN`，或显式设置 `AGENTFORGE_ALLOW_INSECURE_REMOTE=1`；Bearer / Header / SSE 查询 Token；同源与 CORS 白名单；拒绝请求写入安全审计 |
| 统一可观测性 | 已完成 | 任务事件统一带 `traceId / spanId / parentSpanId / kind / runId`；运行根 span 保存在任务详情；`/api/state`、界面与 Markdown / HTML 导出可查看；重启中断任务写入 `run.recovered` |
| Automation | 已完成 | 周期与每日调度、CRUD、暂停 / 恢复、立即运行、最近 20 条历史、失败重试与退避、重叠运行阻止；调度器只运行在当前进程 |
| 启动恢复与部署开关 | 已完成 | 启动时把遗留 queued / running 任务标为中断；Automation 结果重新对账；`AGENTFORGE_SKIP_TEAM_BOOTSTRAP=1` 支持确定性部署和集成测试 |

M2 最初只是共享服务凭据，不是用户身份。M3 / M5 已在其上补 owner / operator / agent 主体、Token 作用域、租户过滤、任务配额和多实例锁 / 租约；完整账号、RBAC、SSO 和按用户计费仍未实现。

Agent Insight 的参考结论是：保留本项目零依赖、可直接运行的优势，不移植其完整的 Next.js / Prisma 应用结构；只吸收明确的服务契约——安全边界与审计、统一 trace / span、可持久化的定时工作及历史 / 重试 / 恢复。OpenHands 类项目同样用于对照能力，不把整套运行时替换掉。

## M3 已完成（2026-11-27）

详细拆分、验收标准和 backlog 见 [agentforge-openbot-plan.md](agentforge-openbot-plan.md)。M3 的顺序由依赖关系决定，不按功能热度排序：

| 阶段 | 重点 | 前置条件 |
| --- | --- | --- |
| M3-0 | owner / operator / agent / system 主体、Token 作用域、操作者审计 | 已完成；高风险端点有授权、越权可审计 |
| M3-1 | Provider 用量账本、上下文状态、历史检索、Automation `clientMessageId` 幂等 | 已完成；未知上下文窗口不伪造 compaction |
| M3-2 | 只读 MCP、白名单、密钥环境引用、启动超时、工具效果分类 | 已完成；只开放 `read`，写工具仍关闭 |
| M3-3 | operator-only 固定命令运行器、持久化审批队列 | 已完成；固定命令、一次性审批和重启恢复可验证 |

M3 不包含：自由 shell、Agent 自审批、MCP 写工具、Provider fill-first / spread、完整 RBAC 和分布式队列。这些能力仍在后续 backlog。

## 实施顺序

| 阶段 | 重点 | 交付物 |
| --- | --- | --- |
| P0（已完成） | 工作区 API、全屏控制台、工具白名单、Git worktree/clone 回退、Diff 与事件流 | 可用的单机协作台 |
| P1（第一层已完成） | Tool Gateway、计划版本、消息路由、Provider Profile、CLI 参数模板与自动回退、CLI 执行策略 | 平台 API 可校验、CLI 可强制或明确拒绝、可审计、可重规划 |
| P2（已完成基础层） | 全局 Scheduler、任务并发、Provider 配额、Agent 租约、Agent Profile | 稳定的多任务并发 |
| M2（团队服务基线，已完成） | 共享服务 Token、CORS / 审计、trace / span、Automation、启动恢复 | 可部署的团队服务基线 |
| M3（已完成） | 身份与审计、用量 / 上下文、历史与幂等、只读 MCP、受控执行与审批 | 高风险能力前置边界已补齐 |
| M4（已完成） | Agent Profile、工作区池、读后写守卫、事务回滚、DAG 图与时间回放 | 面向复杂项目的分工与工作区 |
| M5（已完成基础层） | 租户隔离与配额、OTLP、多实例 JSON + 锁 / 租约、目录懒加载、`/api/state` 分页 | 生产化与规模化基础；完整账号 / RBAC / SSO 仍待后续 |

## 下一阶段 backlog

> OpenBot 融合计划的执行拆分与验收标准见 [agentforge-openbot-plan.md](agentforge-openbot-plan.md)。本表只保留能力边界和尚未实施项，不重复给出另一套优先级。

以下条目来自本轮与 OpenHands / OpenBot 能力对照，M3-M5 已完成项已移出：

| 优先级 | 条目 | 现状 | 建议 |
| --- | --- | --- | --- |
| P2 | 完整账号 / RBAC / SSO | 已有 Token 主体、作用域、租户过滤和任务配额 | 需要用户身份、角色权限、SSO 和按用户计费时再做 |
| P2 | 外部数据库 / 分布式队列 | 当前是 JSON + 文件锁 + 租约，多实例可共享同一数据目录 | SQLite 或队列引入前先做架构决策，保持零依赖承诺清楚 |

## 后续 backlog

以下内容不在 M3-M5 已完成范围内：

| 优先级 | 条目 | 现状 | 后续建议 |
| --- | --- | --- | --- |
| P2 | 监听与权限边界 | `HOST`、`bypassPermissions`、`yolo` 仍沿用现有策略 | 单独做安全评审和显式配置，不在本轮修改 |

以上剩余条目是后续 backlog。M3 / M4 / M5 已完成；P1-9、P1-10、辩论多样性、CLI 网关去硬编码、附件读图、上下文压缩和 Automation durable `await_event` 已移出 backlog。当前没有修改 CLI `bypassPermissions` / `yolo` 的权限边界，也没有实现完整用户账号、RBAC、SSO 或分布式队列。

