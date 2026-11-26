<div align="center">

# AgentForge

**一句话需求，一支会协作的 AI 研发团队。**

规划 · 架构 · 实现 · 测试 · 评审 全流程自动编排：先讨论出方案，再并行落代码，真实跑一遍测试，评审不通过自动返工。产物落在真实工作区，过程在浏览器里逐字可见。

[![Node](https://img.shields.io/badge/node-%E2%89%A520.11-3c873a?logo=node.js&logoColor=white)](https://nodejs.org)
![Dependencies](https://img.shields.io/badge/dependencies-0-blue)
![Build](https://img.shields.io/badge/build-none-lightgrey)
![Tests](https://img.shields.io/badge/tests-38%20passing-brightgreen)
![License](https://img.shields.io/badge/license-MIT-green)
![PRs](https://img.shields.io/badge/PRs-welcome-ff69b4)

[快速开始](#快速开始) · [工作原理](#工作原理) · [接入本机-cli](#接入本机-cli) · [上下文预算](#上下文预算) · [HTTP-API](#http-api) · [常见问题](#常见问题)

<img src="docs/screenshot.png" alt="AgentForge 工作台" width="100%">

</div>

---

## 为什么会有这个项目

把需求丢给单个 AI CLI，你会遇到三个反复出现的坑：

| 坑 | 表现 | AgentForge 的做法 |
| --- | --- | --- |
| **没有分工** | 一个模型既当架构师又当测试，自己审自己 | 5 个角色席位各司其职，评审与实现分离 |
| **不做方案比较** | 第一个念头就是最终方案，硬伤留到交付后 | 先辩论：多方案并行提案 → 交叉质询 → 主持人裁决 |
| **只说不做** | 聊出一堆代码块，没人真正写文件、跑测试 | 每个工序都在真实工作区执行，产物与版本可查 |

而市面上多数「多智能体框架」是**演示品**：内置几个模拟角色，输出像模像样，落到磁盘上是空的。AgentForge 反过来——**默认就用你本机已经装好、真的跑得通的 CLI**，模拟只作为「一个都连不上」时的显式回退，并且每个成员都挂着 `SIM 演示` / `✓ CLI 可用` 徽标，绝不把假输出当成交付。

## 特性

**编排**

- 🧠 **方案辩论先行** — 4 个执行席位 + 1 个工具池 CLI 各出一版方案（契约先行 / 最小闭环 / 测试先行 / 风险优先 / 分阶段交付），互相匿名打 1–10 分并各指一个硬伤，主持人按平均分裁决；只有 1 份有效提案或评分不足时会在裁决里标注置信度，不假装形成共识。
- 🔀 **依赖图并行** — 架构定稿后「实现」与「测试设计」并行推进，DAG 校验依赖与环路，失败按依赖链传播，取消是即时生效而不是等当前工序跑完。
- 🚦 **真实质量门** — 评审前真的执行测试命令，`VERDICT: PASS` 才允许交付；FAIL 进入「修复 → 回归 → 复评」有界回环，轮次可配。测试入口按 `package.json scripts.test` → pytest → cargo → go → Makefile → `tests/` 依次探测，找不到就标 `missing` 让界面显示「没有测试入口」，绝不静默跳过；真实 CLI 任务同样执行这套质量门，而不是一律跳过。评审员缺位退到其他席位时会如实标注「评审代质量门」，不让自审看起来像独立把关。
- 🎛 **工作流可视化配置** — 讨论开关与规模、工序并发、返工轮次都在顶栏 ⚙ 里改，即时落库；另带「快速 / 均衡 / 严谨」三档预设。
- 🔁 **任务级流程覆盖** — 输入框旁可切「先讨论」或「直接开工」，只影响当前任务，不动全局默认。

**执行**

- 🖥 **10 个本机 CLI 真接入** — 启动后台并发体检每个 CLI，只有「真回了话且没有鉴权错误」的才占执行席位；同一个 CLI 可兼任多角色（`OpenCode · 架构师`）。
- 🔌 **任意 OpenAI / Anthropic 兼容网关** — 用 `AGENTFORGE_MODEL` 一个变量把全部 CLI 指向同一个本地网关或自建代理。
- 🧾 **产物带内容版本** — 每个产物记录 `version`（sha256 前 16 位），改写即换版本，可判断「这一步到底动了什么」。
- 🧷 **不合格输出不流转** — 每个角色的回复都要过结构校验：提案需 5 段标题、质询需覆盖全部方案、步骤需可执行产出；半截回复或「我无法完成」直接重试，不把残稿喂给下一步。
- 💾 **原子写入** — 临时文件 → `fsync` → `rename`，Windows 占用自动退避重试，不会留下半截文件。

**界面**

- ⚡ **SSE 实时流** — 逐字输出、Markdown / 表格 / 代码块渲染、阶段条实时高亮、点击工序跳到对应时间线。
- 🗂 **三栏工作台** — 左栏席位与历史，中栏时间线与群聊，右栏上下文 / 辩论记录 / DAG / 产物源码。
- 🌗 **两套配色** — 顶栏 `SHIFT` 切换日间与夜间。
- 🪟 **桌面模式** — 不打包 Electron，用系统浏览器 `--app` 模式得到独立窗口与任务栏图标，双击即用。

**工程**

- 📦 **零依赖、零构建** — 纯 Node.js + 原生 ESM，`node server/index.mjs` 就起来，前端不打包、不装包管理器。
- ✅ **48 个测试** — `node --test` 直接跑，覆盖并行调度、失败传播、质量门返工与入口探测、体检判定、上下文预算、真实工时统计、输出完整性判定与退出码分类。

## 快速开始

要求 **Node.js ≥ 20.11**，没有任何其他依赖。

```bash
git clone https://github.com/liuzheng6621/super-agentbot.git
cd super-agentbot
npm start
```

打开 <http://127.0.0.1:8787>，在底部输入框描述需求，`Ctrl / ⌘ + Enter` 开工。

首次启动会自动生成：

```
data/db.json                 团队、任务、设置、Webhook Token
data/workspaces/<taskId>/    每个任务的真实工作区（产物就在这里）
data/spill/<taskId>/         超长上游产物的落盘副本
```

> **Windows 一键**：双击 `安装到桌面.bat`，桌面与开始菜单会出现 `AGENTFORGE` 快捷方式，双击开窗、关窗回收。

## 工作原理

```mermaid
flowchart TD
    A(["一句话需求"]) --> B{"流程模式"}
    B -->|"先讨论"| C["方案辩论<br/>并行提案 → 交叉质询 → 裁决"]
    B -->|"直接开工"| D["需求拆解 · 排工序"]
    C --> D
    D --> E["架构设计<br/>技术方案 · 接口契约"]
    E --> F["实现<br/>写代码 · 落文件"]
    E --> G["测试设计<br/>用例矩阵 · 边界"]
    F --> H["质量门<br/>真实执行测试"]
    G --> H
    H --> I{"评审"}
    I -->|"PASS"| J(["交付收口"])
    I -->|"FAIL"| K["修复 → 回归 → 复评<br/>有界重试"]
    K --> H
```

每一轮工序都走同一条链路：

```
组装上下文（稳定区 + 易变区） → 调 CLI（真实子进程） → 抓 stdout
   → 对比工作区快照（size + 纳秒 mtime + 内容版本） → 收录产物 → 落 Session 事件
```

### 五个执行席位

| 角色 | 职责 | 典型产出 | 默认偏好顺序 |
| --- | --- | --- | --- |
| `planner` | 拆需求、排工序、收口 | 任务分解、交付结论 | claude → dsh → qwen → gemini |
| `architect` | 技术方案、接口契约 | 设计文档 | gemini → claude → dsh → kimi |
| `coder` | 落代码、写文件 | 源码文件 | codex → opencode → trae-cli → dsh |
| `tester` | 用例矩阵、回归验证 | 测试用例、缺陷单 | opencode → crush → codex → gemini → dsh |
| `reviewer` | 评审、PASS / FAIL 质量门 | 评审意见 | dsh → claude → kimi → qwen → gemini |

席位采用 **主执行人 + 工具池**：每个角色只有一个主执行人，多接的 CLI 留在池里随时可上位。角色可增删改，提示词、命令、参数都能在界面上编辑。

## 接入本机 CLI

左栏「扫描本机 CLI」用 `where.exe` / `which` 确认命令存在并读版本；启动后台还会对每个已安装 CLI **真发一条最短提示词**（`Reply with exactly: OK`）做体检，判定标准是「有回复 + 没有鉴权错误」，而不是「进程退出码为 0」——因为很多 CLI 失败时也返回 0。

已实测跑通（Windows，统一指向本地网关）：

| CLI | 调用方式 | 免审批参数 | prompt 传递 | 体检耗时 |
| --- | --- | --- | --- | --- |
| `claude` | `.exe` 直连 | `--permission-mode bypassPermissions` | argv | ≈ 7s |
| `codex` | `.exe` 直连 | `--sandbox workspace-write` | argv | ≈ 17s |
| `opencode` | `.cmd` | `run --auto` | stdin | ≈ 11s |
| `dsh` | `.cmd` | `--permission-mode workspace-write --approval-policy never` | stdin | ≈ 30s |
| `kimi` | `.cmd` | —（打印模式不接受 `--auto`） | argv | ≈ 8s |
| `trae-cli` | `.exe` 直连 | `run --config-file …` | argv | ≈ 14s |
| `crush` | `.exe` 直连 | `run -y` | stdin | ≈ 28s |
| `aider` | `.exe` 直连 | `--yes` | argv | ≈ 16s |
| `gemini` | `.cmd` | `--skip-trust --approval-mode yolo` | stdin | ≈ 7s |
| `qwen` | `.cmd` | `--approval-mode yolo` | stdin | ≈ 20s |

三条踩过的坑，写在这里省你几小时：

1. **非交互必须显式免审批**。`-p` / `exec` 模式下没有人在旁边点「允许」，写文件会被权限层拦下，模型会回一句「我无法绕过权限」然后什么都没做。
2. **`.cmd` 包装器经 `cmd.exe` 时，多行 prompt 的换行会被当成命令分隔符**，后面的参数被吞掉（典型症状：`gemini` 报 `not running in a trusted directory`、退出码 55）。所以 `.cmd` 系一律把 prompt 走 **stdin**，只有 `kimi` 因为 `-p` 与 `--auto` 互斥而保留 argv——代价是它只适合单行任务。
3. **「装了」≠「能用」**。装了没配 Key、网关返回 405、provider 未初始化，都会在体检里被判不可用，不会混进团队。

常见不通过的对照表：

| 体检输出 | 原因 | 处理 |
| --- | --- | --- |
| `API Error: 405 / 401` | 网关地址或凭据不对 | 修正该 CLI 的 base URL / Key |
| `Please set an Auth method` / `No auth type` | 未配置 API Key | 补 `GEMINI_API_KEY`、qwen 的 `--auth-type` 等，再点「体检并换真实席位」 |
| `No providers configured` / `No LLM` | provider 未初始化 | 先跑一次该 CLI 的交互式初始化 |
| `Config file not found` | 缺配置文件 | 用 `--config-file` 指定，或写进参数模板 |
| 超时无输出 | 首次拉模型 / 不支持一次性提示词 | 单独点成员 ⚙ 或 `POST /api/agents/:id/test` 用更长超时复测 |

体检结果写进 `data/db.json` 的 `settings.teamHealth`，二次启动几乎零等待；改了 Key 就点左栏「体检并换真实席位」强制重检。

### 调用层的四道兜底

CLI 是不可控的第三方进程，所以调用不是「起进程 → 收字符串」这么简单：

| 机制 | 做法 | 解决什么 |
| --- | --- | --- |
| **参数拼装** | `normalizeCliArgs()` 给 `gemini` 补 `--prompt=`，给 `trae-cli run` 补 `--max-steps 16 --console-type simple`；命令行拼接时逐项加引号 | CLI 参数约定各不相同；路径含空格（`Program Files`）时不会被拆成两个参数 |
| **退出码分类** | `classifyCliExit()` 把退出码映射成 成功 / 执行超时 / 已停止 / 命令缺失 / 启动失败 / Windows 初始化失败（`0xC0000142`）/ 外部终止，并标出是否可重试 | 「退出码 0 = 成功」不成立；`0xC0000142` 这类系统级失败要能和真实业务失败区分 |
| **输出完整性** | `isCompleteProposalText()` / `isCompleteCritiqueText()` / `isCompleteStepText()` / `isCompleteSummaryText()` / `isCompleteDecisionText()` 按角色校验结构（提案需 5 段标题、质询需覆盖全部方案、步骤需可执行产出），不合格自动重试 | CLI 经常「退出码 0 但只回半段」「回一句无法完成」；这种产出若直接进下一步，后面全盘皆错 |
| **运行时 PATH** | `runtimePathEnv()` 把 Node 自身目录与 npm / WinGet / Programs 等常见 bin 目录补进子进程 PATH | 从桌面快捷方式启动时继承的 PATH 残缺，`claude.cmd` 之类会报「找不到命令」 |

## 上下文预算

多工序流水线最容易悄悄变贵的地方是上下文。这里的四条规则都带测试守护：

| 机制 | 做法 | 为什么 |
| --- | --- | --- |
| **段序稳定** | prompt 拆成 `stableBlock`（目标 / 工作区）与 `volatileBlock`（状态 / 工序账本 / 文件清单）；稳定区永远在前，易变区压到末尾 | 易变块放开头会让**前缀缓存全灭**，每步都按全价重算 |
| **输入输出双向 token 记账** | `server/tokens.mjs` 按字符类估算：CJK 1.0 / ASCII 1/3.6 / 其他 1/2；`store.countPrompt()` 在发请求前先记提示词，`appendMessage()` 记流式输出，落成 `stats.tokensIn` / `tokensOut` | 只算输出会把成本低估一个数量级（实测同一任务输入 4319 / 输出 7187）；用 `len/3` 估中文还会再低估约 3 倍 |
| **原子写 + 内容版本** | `server/fs.mjs`：同级临时文件 → `fsync` → `rename`；`versionOf()` 取 sha256 前 16 位 | 半截文件不可接受；等长改写也要能识别出来 |
| **超长产物 spill** | 上游产物超过 8000 字落 `data/spill/<taskId>/`，prompt 里只放「只读路径 + 1600 字摘录」 | 直接 `clip` 丢掉中间 25% 是**不可恢复**的信息损失 |

设计依据与完整取舍写在 [docs/design-io-image-context.md](docs/design-io-image-context.md)。

## 界面

三栏工作台，所有状态由 SSE 推送，无轮询。

| 区域 | 内容 |
| --- | --- |
| **左栏** | 五个执行席位 + 工具池（在线状态、`SIM 演示` / `✓ CLI 可用` / `! 不可用`）、本机 CLI 扫描结果、「体检并换真实席位」、历史任务 |
| **中栏** | 工作流阶段条（讨论 → 拆解 → 架构与实施 → 评审 → 交付，实时高亮负责人，可点击跳转）、按阶段分隔的协作时间线、流式输出、方案 / 质询 / 裁决标签、底部群聊输入框 |
| **右栏** | 上下文包、方案讨论（提案人 / 评分 / 票数 / 胜出方案 / 质询记录）、DAG 链路（依赖 / 并行 / 尝试次数 / 返工）、产物源码、统计与 Bot Hook |
| **统计面板** | 每个数字都来自落库事实：累计 TOKENS = 各成员 token 之和（输入与输出分开记账，`tokensIn` / `tokensOut`，不把成本低估一个数量级）；协作轮次 = 真实调用成员次数 `stats.agentRuns`；产物文件 = 产物清单条数；返工轮次 = `repairRound`；总耗时 = 各工序实际耗时之和（墙钟含排队与重试等待，只作悬浮提示）；质量门 = `passed / failed / missing / skipped / 未执行` 五态，中断的任务不会永远停在「待执行」 |
| **顶栏** | 状态、⚙ 工作流设置、`SHIFT` 切换配色 |

群聊里一次 `@` 多位成员，会自动组成讨论组出方案——这是「临时开个小会」的最短路径。

## 桌面模式

| 能力 | 实现 |
| --- | --- |
| 无控制台窗口 | `wscript` 隐藏启动 `desktop/launcher.mjs` |
| 独立应用窗口 | Edge / Chrome `--app` 模式，无地址栏、独立任务栏图标 |
| 隔离浏览器配置 | `%LOCALAPPDATA%\AgentForge\browser` |
| 单实例 | 已运行时直接开窗复用，不重复起服务 |
| 退出回收 | 关窗即结束服务并清理运行时锁 |
| 图标生成 | `desktop/make-icon.mjs` 纯 Node 生成 PNG / ICO |

日志在 `%LOCALAPPDATA%\AgentForge\logs\`，业务数据仍在项目内 `data/`。卸载：`卸载桌面快捷方式.bat` 或 `node desktop/install.mjs --remove`。

## HTTP API

所有接口都在 `http://127.0.0.1:8787` 下，JSON in / JSON out，无需鉴权（默认只监听本机回环）。

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| `GET` | `/api/state` | 全量状态（团队 / 任务 / 设置 / 当前任务） |
| `PATCH` | `/api/settings` | 工作流参数（白名单字段 + 范围夹紧） |
| `POST` | `/api/tasks` | 创建 `{ goal, flowMode?: "debate"\|"direct", autoRun? }` |
| `GET` | `/api/tasks/:id` | 任务详情（消息、工序、产物、辩论） |
| `POST` | `/api/tasks/:id/run` | 重新编排，可带 `{ flowMode }` |
| `POST` | `/api/tasks/:id/stop` | 停止执行 |
| `POST` | `/api/tasks/:id/chat` | `{ text }` 群聊，支持 `@成员名` |
| `GET` | `/api/tasks/:id/files` | 工作区文件列表（含字节数与纳秒 mtime） |
| `GET` | `/api/tasks/:id/file?path=` | 读取单个文件 |
| `POST` | `/api/context-preview` | `{ goal, workspace? }` 预览上下文包 |
| `GET` `POST` | `/api/agents` | 团队列表 / 新增成员 |
| `PATCH` `DELETE` | `/api/agents/:id` | 修改 / 移除成员 |
| `POST` | `/api/agents/:id/test` | 单 CLI 连通性冒烟（60s 超时） |
| `POST` | `/api/agents/adopt` | 扫描并接入可用 CLI 到工具池 |
| `POST` | `/api/agents/rebalance` | 按角色偏好重新分派席位 |
| `POST` | `/api/team/ensure` | 探测 + 体检 + 换真实席位（幂等） |
| `POST` | `/api/team/refresh` | 强制重新体检并重组 |
| `GET` | `/api/probe` | 扫描本机 CLI |
| `GET` | `/api/fs?path=` | 浏览本机目录（「选文件夹开工」） |
| `GET` | `/api/stream` | SSE 事件流 |
| `GET` | `/api/health` | 健康检查 |
| `POST` | `/api/shutdown` | 优雅退出 |
| `POST` | `/api/hooks/:token` | 外部触发（Bot Hook） |

### Bot Hook

一次 POST 就能让流水线开工，接机器人、CI 或自建系统：

```bash
curl -X POST http://127.0.0.1:8787/api/hooks/<token> \
  -H "Content-Type: application/json" \
  -d '{"goal":"做一个并发安全的待办 API"}'
```

Token 在界面右侧「统计」面板，或 `data/db.json` 的 `settings.hookToken`。

## 配置

| 变量 | 默认值 | 说明 |
| --- | --- | --- |
| `PORT` | `8787` | HTTP 端口（被占用时会打印明确提示并以退出码 2 退出，不会静默失败） |
| `HOST` | `127.0.0.1` | 监听地址；局域网共享设 `0.0.0.0` |
| `AGENTFORGE_DATA_DIR` | `<repo>/data` | 数据目录，测试与多套数据隔离时用 |
| `AGENTFORGE_MODEL` | `trae-cn/glm-5.3-flash` | 传给各 CLI 的模型名（走自建网关时改这里，不用逐个 CLI 改配置） |

工作流参数（讨论开关与规模、工序并发、返工轮次）在界面 ⚙ 里改，落 `data/db.json` 的 `settings`。

## 项目结构

```
.
├── server/
│   ├── index.mjs         HTTP 路由、SSE、静态资源、单实例端口守卫
│   ├── orchestrator.mjs  流水线编排、质量门、上下文组装、产物落盘
│   ├── store.mjs         状态、席位、持久化、事件总线
│   ├── dag.mjs           依赖图校验与并行调度
│   ├── adapters.mjs      CLI 适配（argv / stdin / 免审批参数）、模拟流式、本机探测
│   ├── team.mjs          体检判定与真实席位组建
│   ├── fs.mjs            原子写入、内容版本、超长文本 spill
│   ├── tokens.mjs        中文感知的 token 估算
│   ├── adopt.mjs         本机 CLI 扫描与接入
│   └── sim.mjs           内置内容引擎（仅回退用）
├── public/               前端（原生 ESM，无构建）
│   ├── index.html
│   ├── styles.css
│   ├── app.js            SSE 客户端与渲染
│   └── fonts/            自托管字体（离线可用）
├── desktop/              桌面启动器、快捷方式安装、图标生成
├── docs/
│   ├── screenshot.png
│   └── design-io-image-context.md
├── tests/                7 个测试文件、48 个测试
├── 安装到桌面.bat
├── 卸载桌面快捷方式.bat
└── data/                 运行时数据（gitignore）
```

## 测试

```bash
npm test
```

48 个测试，覆盖：依赖图并行 / 失败传播 / 环路检测 / 取消即时性、五席位分工、完整协作链路、质量门返工、CLI 失败禁止误交付、停止竞态、评审结论解析、辩论评分与排名规则、工作流设置白名单与任务级流程覆盖、真实团队体检判定与席位挑选、质量门测试入口探测与 `missing` 判定、真实 CLI 任务同样执行质量门、评审员兜底不落到实现者、目录快照复用、上游瞬时故障（ECONNRESET / 429 / socket hang up）只重试一次且不掩盖真实失败、上下文预算（段序稳定性、中文 token 估算、原子写版本、spill 可还原）、真实工时统计（只累加结束过的工序，不拿墙钟冒充）、输出完整性判定（半截提案 / 缺段质询 / 空步骤都会判不合格）、提案宽松解析（`A=7`、`B：8分`、`方案 C 7/10`）、退出码分类（超时 / 已停止 / 命令缺失 / `0xC0000142`）与参数拼装。

## 已知边界

- **单机单进程**：状态存 JSON 文件，适合本地个人与内网演示；要多实例请替换 `store.mjs` 的持久化实现。
- **`kimi` 只适合单行任务**：`-p` 与 `--auto` 互斥，只能走 argv，多行 prompt 会被 `cmd.exe` 截断。
- **`trae-cli` 的行为取决于模型**：工具齐全（bash / 编辑 / 顺序思考），但某些模型只肯调顺序思考而不落盘——这是模型行为，不是配置问题。
- **模拟模式**：一个可用 CLI 都没有时才会启用，产出仍是可运行的代码（`tests/*.test.js` 能直接 `node` 执行），但成员会明确标注 `SIM 演示`。

## Roadmap

- [x] 真实 CLI 体检组队（10 个 CLI 实测跑通）
- [x] 方案辩论、DAG 并行、质量门返工
- [x] 上下文预算（段序 / token 估算 / 原子写 / spill）
- [ ] 附件与读图（把截图交给视觉模型看 UI）
- [ ] 读后写守卫（改动未经读取的文件时要求先读，防盲改）
- [ ] 正规压缩（长任务的摘要式上下文压缩）
- [ ] 多实例持久化后端

## 常见问题

<details>
<summary><b>体检全失败，界面全是 SIM 演示？</b></summary>

说明本机没有能跑通的 CLI，或者都还没配 Key。先手动跑一次，看真实报错：

```bash
claude -p "Reply with exactly: OK"
gemini -p "Reply with exactly: OK" --skip-trust
```

按上面的对照表修完，点左栏「体检并换真实席位」（或 `POST /api/team/refresh`）强制重检。
</details>

<details>
<summary><b>启动报「端口 8787 已被占用」？</b></summary>

多半是已经有一个 AgentForge 在跑。关掉旧进程，或换端口：`PORT=9000 npm start`。
</details>

<details>
<summary><b>怎么把所有 CLI 指向自己的网关或模型？</b></summary>

设 `AGENTFORGE_MODEL`，例如 `AGENTFORGE_MODEL=my-gateway/my-model npm start`。各 CLI 的 base URL 与 Key 仍需在它自己的配置里指好——AgentForge 只负责传模型名和免审批参数。
</details>

<details>
<summary><b>数据存在哪？能备份吗？</b></summary>

全在 `data/`：`db.json` 是团队 / 任务 / 设置，`workspaces/<taskId>/` 是每个任务的真实产物。整个目录拷走即是完整备份，删掉即是从零开始。
</details>

<details>
<summary><b>能局域网多人用吗？</b></summary>

`HOST=0.0.0.0 npm start` 即可，但注意它**没有鉴权**，只适合可信内网。多实例共享状态需要替换 `store.mjs` 的持久化实现。
</details>

<details>
<summary><b>我的代码会被上传到哪？</b></summary>

服务本身只在你指定的工作区读写文件，不外传。但每个工序都会把上下文（目标、上游产物摘录、文件清单）发给你所选 CLI 背后的模型服务商——隐私边界取决于你用的是哪家模型，用本地网关就是本地。
</details>

## 贡献

欢迎 issue 与 PR。两条底线：

1. **保持零依赖**——新增运行时依赖的 PR 会被要求改成手写实现。
2. **`npm test` 必须全绿**——新增行为请带测试，测试即验收判据。

## License

[MIT](LICENSE)

<div align="center">

如果这个项目帮你省下了一次「AI 说做完了但其实什么都没写」，点个 ⭐ 让更多人少踩一遍。

[![Star History Chart](https://api.star-history.com/svg?repos=liuzheng6621/super-agentbot&type=Date)](https://star-history.com/#liuzheng6621/super-agentbot&Date)

</div>
