# AgentForge：把本机 AI CLI 拼成一条开发流水线

> 开源地址：[GitHub](https://github.com/liuzheng6621/super-agentbot) · [Gitee](https://gitee.com/liu-everything_impossble/super-agentbot)  
> 技术栈：纯 Node.js + 原生 ESM，零运行时依赖，零构建。  
> 许可：MIT。

## 一、起因

用单个 AI CLI 做开发，常见的体验是：能聊，也能写代码，但你真正关心的事情它不负责。

- 方案靠猜；
- 测试靠它自己说“跑过了”，没有真实执行证据；
- 评审靠它自己夸自己；
- 产物散落在临时目录里，过程散落在聊天记录里；
- 多个 CLI 同时装了，却不知道谁该干哪一环。

AgentForge 把开发这件事拆成一条流水线：

> 规划 → 架构 → 实现 → 测试 → 评审 → 交付  
> 先讨论出方案，再并行落代码，真实跑测试，评审不过自动返工。

它不是聊天套壳，也不是演示用的“多智能体”。任务、工作区、测试、评审、Token 计量、trace、多实例协调都落库。

## 二、定位

AgentForge 当前定位是单机 / 团队服务基线：

- 一个 Node.js 进程就能跑；
- 多实例可以共享同一 JSON 数据目录，靠文件锁和租约协调；
- 不是分布式任务队列，不是完整 SaaS；
- 没有账号体系、RBAC、SSO 或外部数据库；
- 不做“看起来很高级但实际没执行”的事。

## 三、五个席位

团队拆成 5 个角色：

| 角色 | 职责 | 典型产出 |
| --- | --- | --- |
| `planner` | 拆需求、排工序、收口 | 任务分解、交付结论 |
| `architect` | 技术方案、接口契约 | 设计文档 |
| `coder` | 落代码、写文件 | 源码文件 |
| `tester` | 用例矩阵、回归验证 | 测试用例、缺陷单 |
| `reviewer` | 评审、PASS / FAIL 质量门 | 评审意见 |

每个角色默认有主执行人，也有工具池。本机装了什么 CLI，就用什么 CLI 组队：

- `claude`、`codex`、`dsh`、`kimi`、`gemini`、`qwen`、`opencode`、`trae-cli`、`crush`、`aider` 等内置候选；
- 席位可以手动增删改；
- 提示词、命令、参数、Provider Profile 都能在界面上编辑；
- 一个 CLI 也可以兼任多个角色（比如同一个 OpenCode 既做架构又做测试），平台会显式标记。

## 四、几件具体的事

### 1. 质量门

平台执行的是工作区真实测试入口，不是模型自己说“我测过了”：

- 优先从 `package.json` 的 `scripts.test` 找测试入口；
- 其次看 `Makefile`；
- 再看 pytest / tox 等常见 Python 测试配置；
- 真执行命令，记录命令串、退出码、stdout / stderr 摘录、耗时；
- 没有测试入口时，状态是 `no-test-entry`，不是 `skipped`，不会当作通过；
- `exit 0` / `true` / 纯 `echo` 这类占位脚本不算测试入口；
- 测试失败、超时、缺少 pass / fail 证据，都不能交付；
- 测试子进程只继承最小环境白名单，Provider 密钥不会进入测试命令。

### 2. 评审独立性

评审候选只允许 `reviewer / tester / architect`，实现者不会被悄悄拉来审自己。  
自审按真实的 `reviewerId / implementerId` 判定，写入任务事件并在界面提示，不再当成独立评审。

### 3. 结构化 VERDICT

评审必须输出扁平 JSON `VERDICT`，缺失、损坏或与 Blocker 矛盾的结论都不能放行。  
Blocker / Should 数量进入工序记录和界面。

### 4. 工作区与 Git

每个任务都有真实工作区：

- 平台文件操作走 Tool Gateway，校验路径边界、敏感文件、工具白名单；
- 写入使用临时文件 + `fsync` + `rename` 原子写；
- 删除进入 `.agentforge/trash`，不是硬删除；
- 支持 Git `worktree --detach`，Windows 文件系统不支持时自动回退 `git clone --shared`；
- Diff 对比 Git `HEAD`，并补齐未跟踪新文件的 unified diff。

### 5. 动态工序图

规划师根据任务形状输出 DAG：

- 纯 bug 修复可以省略设计工序；
- 多模块可以拆给多个 coder；
- 平台严格校验后替换模板；
- 非法计划回退模板并记录 `plan.fallback`；
- 每个任务最多 12 个工序，支持返工，但自动重规划最多一次，避免无限循环。

### 6. 上下文压缩与回放

达到阈值可自动压缩：

- 保留来源消息范围、摘要质量、历史记录和原文回放；
- 当前摘要是抽取式，不是模型生成的语义摘要；
- 压缩记录进入 `/api/state`，原始消息不删除。

### 7. 图片附件

图片附件有真实的工程边界：

- Provider Profile 必须声明 `vision` 能力；
- 只接收 PNG / JPEG / WebP / GIF；
- 校验体积、尺寸和像素；
- 按内容寻址保存，持久化数据不内联 base64 或本地绝对路径。

### 8. trace

每次运行都有 trace：

- `traceId / spanId / parentSpanId / kind / runId`；
- 运行根 span 写入任务详情；
- 支持 OTLP / OpenTelemetry 导出；
- `/api/state`、任务详情、Markdown / HTML 导出都能追踪。

### 9. 多实例

多个进程可以共享同一数据目录：

- `db.json` 有文件锁；
- 任务分片为 `tasks/<id>.json`；
- 租约互斥任务、Automation 和 Provider 槽位；
- 进程崩溃后过期租约可回收；
- 启动时把遗留 queued / running 任务标为中断并写入 `run.recovered`。

## 五、安全

这块不伪装成“绝对安全”：

- 默认回环地址可零配置启动；
- 绑定到局域网或非回环地址时，强制要求 `AGENTFORGE_API_TOKEN`；
- 支持 Bearer、`X-AgentForge-Token`、浏览器 SSE 查询令牌；
- 支持 CORS 白名单、Host 校验和拒绝审计；
- Token 有作用域、租户绑定、任务配额；
- `executionPolicy=strict` 时，真实 CLI 必须在启动前通过策略预检；
- Codex / DSH 映射原生沙箱，Claude 使用只读工具白名单，其他无法精确表达的组合直接拒绝；
- `inherit` 模式仍保留兼容行为，但界面会明确标记 `INHERIT`，不冒充子进程隔离。

## 六、界面

界面是三栏工作台：

| 区域 | 内容 |
| --- | --- |
| 左栏 | 5 席位 + 工具池、CLI 扫描、体检、历史任务 |
| 中栏 | 阶段条、协作时间线、流式输出、方案 / 质询 / 裁决标签 |
| 右栏 | 上下文包、方案讨论、DAG 链路、产物源码、统计 |
| 工作区控制台 | 文件 / 执行轨迹 / 计划版本 / 协作消息 / 工具审计 / DAG / 回放 / 总览 / Diff |

最近加了「泳道视图」：

- 按成员分行；
- 消息按时间折叠成块；
- 能直接看出谁在并行、谁在等待；
- 质量门、裁决、完成横跨泳道，一眼看出失败前最后活跃的是谁；
- 支持时间回放 scrubber；
- 移动端保留时间比例并纵向堆叠。

所有状态由 SSE 推送，无轮询。

## 七、跑起来

要求 Node.js ≥ 20.11，没有其他依赖。

```bash
git clone https://github.com/liuzheng6621/super-agentbot.git
cd super-agentbot
npm start
```

打开 <http://127.0.0.1:8787>，在底部输入框描述需求，`Ctrl / ⌘ + Enter` 开工。

首次启动会自动生成：

```text
data/db.json                 团队、设置、Webhook Token（不含任务）
data/tasks/<id>.json         任务分片，单任务原子写
data/tasks/index.json        分片索引，缺失或过期时自动重建
data/workspaces/<taskId>/    每个任务的真实工作区
data/spill/<taskId>/         超长上游产物落盘副本
data/attachments/            图片附件内容寻址副本
```

Windows 用户也可以双击 `安装到桌面.bat`，桌面会出现 `AGENTFORGE` 快捷方式。

## 八、接 CLI

左栏「扫描本机 CLI」先做本地存在性、版本和配置探测，不发起真实提示词调用。  
只有点「体检并换席」或调用 `POST /api/team/refresh` 才会对已安装 CLI 真发一条最短提示词。

判断标准是「有回复 + 没有鉴权错误」，不是「进程退出码为 0」——很多 CLI 失败时也返回 0。

内置候选包括：

`claude`、`codex`、`opencode`、`cursor-agent`、`copilot`、`cn`、`dsh`、`kimi`、`trae-cli`、`crush`、`goose`、`aider`、`gemini`、`qwen`、`ollama`。

几个踩过的坑：

1. 非交互必须显式免审批。`-p` / `exec` 模式下没有人在旁边点「允许」，写文件会被权限层拦下。
2. `.cmd` 包装器经 `cmd.exe` 时，多行 prompt 的换行会被当成命令分隔符。所以 `.cmd` 系一律把 prompt 走 stdin。
3. 「装了」不等于「能用」。没配 Key、网关返回 405、provider 未初始化，都会在体检里被判不可用。

## 九、测试

仓库按领域组织测试，数量随用例增减：

- 编排：五席位、辩论、动态计划、DAG、计划版本；
- 质量与评审：测试入口探测、真实命令执行、独立评审、结构化 `VERDICT`；
- 工作区：文件读写、路径边界、Git worktree、Diff、工作区池；
- 工具与安全：Tool Gateway、CLI 严格策略、Token / CORS / MCP；
- 上下文与附件：token 估算、压缩回放、图片校验；
- 持久化与多实例：dirty 窗口合并落盘、文件锁、租约、重启恢复；
- 可观测性与集成：trace / span、OTLP、导出脱敏；
- CLI 适配：argv / stdin、Windows `.cmd`、命令解析缓存。

统一验证入口：

```bash
npm test
npm run check:syntax
npm run check:types
npm run test:coverage
```

CI 在 Ubuntu / Windows × Node 20 / 22 上运行，浏览器用例在 CI 中不允许跳过。

## 十、边界

AgentForge 的 README 里明确写了它做不到什么：

- 没有完整用户账号、RBAC、SSO；
- 没有外部数据库或分布式队列；
- 没有 Provider 级费用预算；
- 没有内核级 CLI 代理与隔离；
- `strict` 是原生能力映射，不是内核级代理；
- 自动夹具只覆盖调用契约与进程边界，不等于内置候选的真实交付矩阵都通过；
- 文中的 CLI 数量、耗时、测试数量都可能随版本和环境变化。

这些是当前实现的实际边界。

## 十一、贡献

欢迎 issue 与 PR。两条底线：

1. 保持零依赖。新增运行时依赖的 PR 会被要求改成手写实现。
2. `npm test` 必须全绿。新增行为请带测试，测试即验收判据。

> 如果这个项目帮你省下了一次「AI 说做完了但其实什么都没写」，点个 ⭐ 让更多人少踩一遍。

