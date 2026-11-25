# AgentForge

**把一句话需求丢给一支会协作的 AI 研发团队。** 规划、架构、实现、测试、评审全流程自动编排，过程实时可见，产物落到真实工作区 —— 启动时自动体检本机的 `codex`、`claude`、`opencode` 等 CLI，把真正跑得通的工具组成 5 个执行席位，不再用内置模拟成员冒充。

![Node](https://img.shields.io/badge/node-%E2%89%A520.11-3c873a?logo=node.js&logoColor=white)
![Dependencies](https://img.shields.io/badge/dependencies-0-blue)
![Build](https://img.shields.io/badge/build-none-lightgrey)
![License](https://img.shields.io/badge/license-MIT-green)

![AgentForge 界面](docs/screenshot.png)

## 特性

- **零依赖、零构建** —— 纯 Node.js + 原生 ESM，`node server/index.mjs` 即可启动，前端无需打包。
- **真实多角色协作** —— 5 个角色席位各司其职，同一角色只保留一个主执行人，其余 CLI 进入工具池，不再出现“所有人都是 coder”。
- **先讨论再动手** —— 开工前多位成员各出一版方案，互相匿名评分并指出硬伤，主持人按平均分裁决；后续工序必须遵循胜出方案，偏离要在评审里写明理由。
- **上下文自动注入** —— 每个工序执行前实时读取依赖产物的真上下文，不再复用任务开始时的旧快照。
- **依赖图并行与返工闭环** —— 架构定稿后实现与测试设计并行；评审前真实执行测试质量门，不通过自动修复、回归、复评。
- **默认就是真实 Agent** —— 服务启动后台自动扫描并**真实调用一次**本机 CLI 做体检，只有跑得通的才会占执行席位；装了但没配 API Key / 鉴权的不会混进团队。体检结果持久化，二次启动几乎零等待。
- **模拟只是显式回退** —— 本机一个可用 CLI 都没有时才用内置模拟成员跑通链路；每个成员都带 `SIM 演示` / `✓ CLI 可用` / `! 不可用` 状态标签，不会把假输出当成交付。
- **实时流式界面** —— SSE 推送，逐字输出的时间线、Markdown / 表格 / 代码块渲染、执行链路与产物浏览器。
- **可被外部触发** —— 一次 HTTP POST 即可让流水线开工，方便接入机器人、CI 或自建系统。
- **桌面化运行** —— 不打包 Electron，用系统浏览器 `--app` 模式得到独立窗口与任务栏图标，安装成本为零。

## 快速开始

要求 Node.js ≥ 20.11，无其他依赖。

```bash
git clone https://github.com/liuzheng6621/super-agentbot.git
cd super-agentbot
npm start
```

打开 http://127.0.0.1:8787 ，在左下角输入框描述需求，`Ctrl/⌘ + Enter` 开工。

首次启动会自动生成 `data/db.json`（团队、任务、Webhook Token）与 `data/workspaces/<taskId>/`（产物目录）。

## 工作原理

```
需求
 └─ debate     多方案并行提案 → 交叉质询评分 → 裁决（采纳方案 X）
     └─ planner    按胜出方案拆解工序、收口交付
         └─ architect   技术方案、接口契约
             ├─ coder   实现代码、写入工作区   ┐ 并行
             └─ tester  用例设计、边界覆盖     ┘
                 └─ quality gate  真实执行测试
                     └─ reviewer  质量评审、PASS / FAIL
                         └─ repair loop  修复 → 回归 → 复评（有界）
```

**方案讨论**默认由 4 个执行席位 + 1 个工具池 CLI 组成讨论组（规划席位担任主持人，不参与提案）。每个成员拿到不同主张：契约先行、最小闭环、测试先行、风险优先、分阶段交付。各自出方案后，每人给其他方案打 1–10 分并指出一个硬伤，平均分最高者胜出；只有 1 份有效提案或评分不足时会在裁决里标注置信度，不会假装形成了共识。

**开工方式可以按任务选**：输入框旁切到「先讨论」会走完上面的提案—质询—裁决；切到「直接开工」则跳过讨论直接进入规划实施。这个选择只影响当前任务，不会改动全局默认。全局默认与讨论规模、工序并发、返工轮次都可以在顶栏 **⚙ 工作流设置** 里可视化调整，改完即时落库，不用再手改 `data/db.json`；也提供「快速 / 均衡 / 严谨」三个预设。

团队采用 **主执行席位 + 工具池**：每个角色只有一个主执行人，额外接入的 CLI 留在工具池，可随时设为主执行人。角色可增删改，提示词、命令与参数都能在界面上编辑。

**执行席位默认是真实 CLI，不是内置模拟人。** 服务启动后会扫描本机已安装的命令行工具，逐个发一条极简提示词做体检（`Reply with exactly: OK`），把「有正常回复」的判定为可用，再按角色偏好分到 5 个席位；同一个 CLI 可以兼任多个角色（名字会带角色后缀，如 `OpenCode · 架构师`），因为「真能跑」比「每个席位工具都不同」更重要。体检结果写进 `data/db.json` 的 `settings.teamHealth`，配置好 API Key 后点左栏「体检并换真实席位」即可强制重检并重组。

| 角色 | 默认成员 | 职责 | 产出 |
| --- | --- | --- | --- |
| `planner` | Nova | 拆需求、排工序、收口 | 任务分解、交付结论 |
| `architect` | Forge | 技术方案、接口契约 | 设计文档 |
| `coder` | Kilo | 落代码、写文件 | 源码文件 |
| `tester` | Probe | 用例矩阵、回归验证 | 测试用例、缺陷单 |
| `reviewer` | Lens | 评审、PASS / FAIL 质量门 | 评审意见 |

## 界面

三栏工作台，全部状态由 SSE 实时推送。

| 区域 | 内容 |
| --- | --- |
| 左栏 | 五个真实 CLI 执行席位 + 工具池（角色标签 / 在线状态 / `SIM 演示`·`✓ CLI 可用`·`! 不可用` 体检徽标）、本机 CLI 扫描结果、「体检并换真实席位」按钮、历史任务 |
| 中栏 | **工作流阶段条**（讨论 → 拆解 → 架构与实施 → 评审 → 交付，实时高亮当前阶段与负责人，点击可跳转）、按阶段分隔的协作时间线、流式输出、方案 / 质询 / 裁决标签、底部群聊输入框（一次 `@` 多位成员会组成讨论组出方案） |
| 右栏 | 上下文、方案讨论（提案人 / 评分 / 票数 / 胜出方案 / 质询记录）、DAG 执行链路（依赖 / 并行 / 尝试次数 / 返工，点击工序可展开结论与产物直达）、产物文件源码、统计与 Bot Hook |
| 顶栏 | 状态、**⚙ 工作流设置**、`SHIFT` 开关切换日间 / 夜间两套配色 |

工作流阶段条是界面上的主线索：讨论、拆解、实施、评审、交付五段各有状态（进行中 / 完成 / 跳过 / 失败），下方一行说明当前在做什么、谁在做、流程模式和工序进度。直接开工时「讨论」会显示为跳过，不会留一个空阶段让人猜。

## 接入真实 CLI

左栏「扫描本机 CLI」用 `where.exe` / `which` 确认命令是否存在，再读取版本信息。覆盖 `claude`、`codex`、`opencode`、`dsh`、`workbuddy`、`crush`、`goose`、`aider`、`gemini`、`qwen`、`ollama`。

**服务启动时会自动做一轮体检并组建真实团队**（后台执行，不阻塞界面）：并发对每个已安装的 CLI 发一条最短提示词，只有真跑出回复且没有鉴权错误的才会占执行席位。「装了」不等于「能用」，常见不通过原因与处理：

| 体检结果 | 原因 | 处理 |
| --- | --- | --- |
| `API Error: 405 / 401` | 网关地址或凭据不对 | 修正该 CLI 的 API 配置（如 `ANTHROPIC_BASE_URL`） |
| `Please set an Auth method` / `No auth type` | 未配置 API Key | 设置 `GEMINI_API_KEY`、`qwen` 的 `--auth-type` 等，再点「体检并换真实席位」 |
| `No providers configured` / `No LLM` | 模型 provider 未设置 | 先跑一次该 CLI 的交互式初始化 |
| `Config file not found` | 缺配置文件 | 用 `--config-file` 指定，或在参数模板里补上 |
| 超时无输出 | 首次拉模型 / 命令不支持一次性提示词 | 单独点成员 ⚙ 或 `/api/agents/:id/test` 用更长超时复测 |

- **READY** — 已安装，点「接入」自动填充绝对路径
- **N/A** — 未检测到，可点「手动」填写绝对路径或任意自定义命令
- 新接入的 CLI 默认进入工具池，不抢占已有执行席位；点「智能分工」按角色偏好分派，或点「体检并换真实席位」按体检结果重组
- 成员右侧 **⚙** 可重命名、切换模拟 / CLI 模式、修改命令与参数、设为主执行席位，或移出团队
- 体检慢的 CLI（例如 `codex` 约 20s）已放宽到 30s 超时；`prompt` 已在参数里时 stdin 直接设为 `ignore`，避免 `codex` 卡在 "Reading additional input from stdin..." 不退出

调用约定：

| 场景 | 处理方式 |
| --- | --- |
| `.exe` | 参数数组直连进程，UTF-8 提示词原样传递 |
| `.cmd` / `.bat` | 经 `cmd.exe` 执行，前置 `chcp 65001` 避免编码错乱 |
| 参数模板无 `{{prompt}}` | 提示词改由 stdin 传入 |
| 子进程 stdin | 参数里已带 `{{prompt}}` 时直接设为 `ignore`；否则立即关闭，防止 CLI 阻塞在交互读取 |
| 工作目录 | 任务专属工作区，运行期新增 / 修改的文件自动收录为产物 |

## 桌面模式

Windows 下双击 `安装到桌面.bat`，桌面与开始菜单会生成 `AGENTFORGE` 快捷方式，双击即用。

| 能力 | 实现 |
| --- | --- |
| 无控制台窗口 | `wscript` 隐藏启动 `desktop/launcher.mjs` |
| 独立应用窗口 | Edge / Chrome `--app` 模式，无地址栏、独立任务栏图标 |
| 隔离的浏览器配置 | `%LOCALAPPDATA%\AgentForge\browser` |
| 单实例 | 已运行时直接开窗复用，不重复起服务 |
| 退出回收 | 关窗即结束服务进程并清理运行时锁 |
| 图标生成 | `desktop/make-icon.mjs` 纯 Node 生成 PNG / ICO |

日志位于 `%LOCALAPPDATA%\AgentForge\logs\`，业务数据仍在项目内 `data/`。卸载：运行 `卸载桌面快捷方式.bat` 或 `node desktop/install.mjs --remove`。

## HTTP API

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| `GET` | `/api/state` | 全量状态（团队 / 任务 / 设置 / 当前任务） |
| `PATCH` | `/api/settings` | 调整工作流参数（讨论开关 / 人数 / 并发 / 返工轮次，字段白名单 + 范围夹紧） |
| `POST` | `/api/tasks` | `{ goal, flowMode?: "debate" \| "direct", autoRun? }` 创建任务，默认自动开工 |
| `GET` | `/api/tasks/:id` | 任务详情（消息、工序、产物、辩论记录） |
| `POST` | `/api/tasks/:id/run` | 重新编排，可带 `{ flowMode }` 顺带切换流程模式 |
| `POST` | `/api/tasks/:id/stop` | 停止执行 |
| `POST` | `/api/tasks/:id/chat` | `{ text }` 群聊，支持 `@成员名` |
| `GET` | `/api/tasks/:id/files` | 工作区文件列表 |
| `GET` | `/api/tasks/:id/file?path=` | 读取单个文件 |
| `POST` | `/api/context-preview` | `{ goal, workspace? }` 预览上下文包 |
| `GET` | `/api/agents` `POST` | 团队列表 / 新增成员 |
| `PATCH` `DELETE` | `/api/agents/:id` | 修改 / 移除成员 |
| `POST` | `/api/agents/adopt` | 扫描并接入可用 CLI 到工具池 |
| `POST` | `/api/agents/rebalance` | 按角色偏好把 CLI 重新分派到主执行席位 |
| `POST` | `/api/team/ensure` | 探测 + 体检，把内置演示席位换成真实 CLI（幂等） |
| `POST` | `/api/team/refresh` | 强制重新体检并重组执行席位 |
| `POST` | `/api/agents/:id/test` | 冒烟测试单个 CLI 连通性（60s 超时） |
| `GET` | `/api/probe` | 扫描本机 CLI |
| `GET` | `/api/fs?path=` | 浏览本机目录（「选文件夹开工」用） |
| `GET` | `/api/stream` | SSE 事件流 |
| `GET` | `/api/health` | 健康检查 |
| `POST` | `/api/hooks/:token` | 外部触发（Bot Hook） |

### Bot Hook

```bash
curl -X POST http://127.0.0.1:8787/api/hooks/<token> \
  -H "Content-Type: application/json" \
  -d '{"goal":"做一个并发安全的待办 API"}'
```

Token 显示在界面右侧「统计」面板，也可从 `data/db.json` 的 `settings.hookToken` 读取。

## 配置

| 变量 | 默认值 | 说明 |
| --- | --- | --- |
| `PORT` | `8787` | HTTP 监听端口 |
| `HOST` | `127.0.0.1`（注入 `PORT` 时为 `0.0.0.0`） | 监听地址，局域网共享可显式设为 `0.0.0.0` |

运行时数据均在 `data/`（已加入 `.gitignore`）：`db.json` 保存团队、任务与设置，`workspaces/<taskId>/` 保存每个任务的产物。

## 项目结构

```
.
├── server/
│   ├── index.mjs        HTTP 路由、SSE、静态资源
│   ├── store.mjs        状态管理、角色席位、持久化、事件总线
│   ├── orchestrator.mjs 流水线编排、质量门、群聊、产物落盘
│   ├── dag.mjs          依赖图校验与并行调度
│   ├── adapters.mjs     模拟流式输出、真实 CLI 适配、本机探测
│   ├── team.mjs         本机 CLI 体检与真实执行席位组建
│   └── sim.mjs          内置智能体内容引擎（仅回退用）
├── public/              前端（原生 ESM，无构建）
│   ├── index.html
│   ├── styles.css
│   └── app.js           SSE 客户端与渲染
├── desktop/
│   ├── launcher.mjs     启动服务、打开应用窗口、关窗回收
│   ├── install.mjs      部署桌面 / 开始菜单快捷方式
│   └── make-icon.mjs    纯 Node 生成图标
├── docs/
│   └── screenshot.png
├── tests/
│   ├── dag.test.mjs
│   ├── debate.test.mjs
│   ├── flow.test.mjs
│   ├── orchestrator.test.mjs
│   └── team.test.mjs
├── 安装到桌面.bat
├── 卸载桌面快捷方式.bat
└── data/                运行时数据（gitignore）
```

## 说明

- 模拟模式产出的是可运行的真实代码：`data/workspaces/<taskId>/tests/*.test.js` 可直接用 `node` 执行。
- 单机单进程设计，状态存于 JSON 文件，适合本地个人使用与团队内网演示；如需多实例部署，需要替换 `store.mjs` 的持久化实现。

## 测试

```bash
npm test
```

覆盖依赖图并行、失败传播、环路检测、取消、五席位分工、完整模拟协作、质量门返工、CLI 失败禁止误交付、停止竞态、评审结论解析，辩论阶段的评分解析、排名规则与讨论组构成，工作流设置白名单、任务级流程模式覆盖与「直接开工」跳过讨论的完整链路，以及真实团队的体检判定、可用 CLI 优先的席位挑选、体检缓存去重。

## License

MIT
