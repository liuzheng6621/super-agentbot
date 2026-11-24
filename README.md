# AGENTFORGE · 多智能体开发协作台

把一句话需求交给一支会协作的 AI 研发团队：**规划 → 架构 → 实现 → 测试 → 评审 → 收口**，
全过程实时可见，产物写进真实工作区。可把本机的 `codex` / `dsh` / `workbuddy` / `claude` 等 CLI 挂成团队成员。

- 零依赖，`node server/index.mjs` 即可跑（Node ≥ 20.11）
- 内置模拟智能体，没有 API Key 也能完整演示协作链路
- 一条 HTTP 请求即可从外部系统触发任务（Bot Hook）

## 快速开始

```bash
cd e:/SKIl.1/bot
npm start
# 打开 http://127.0.0.1:8787
```

首次启动会自动创建 `data/db.json`（团队、任务、Webhook Token）与 `data/workspaces/<taskId>/`（产物目录）。

## 部署到桌面（推荐）

双击 **`安装到桌面.bat`** → 桌面出现 `AGENTFORGE` 图标 → 双击即用。

不依赖 Electron，安装包体为 0 字节下载：

| 能力 | 实现 |
|------|------|
| 无控制台黑框 | `wscript` 隐藏启动 `detached/launcher.mjs` |
| 独立应用窗口 | Edge/Chrome `--app` 模式，无地址栏、独立任务栏图标 |
| 独立浏览器配置 | `%LOCALAPPDATA%\AgentForge\browser`，不污染日常浏览器 |
| 单实例 | 已有实例直接开窗复用，不会重复起服务 |
| 退出即回收 | 关窗 → 自动结束服务进程并清理 runtime 锁 |
| 快捷方式 | 桌面 + 开始菜单，图标由 `desktop/make-icon.mjs` 纯 Node 生成 |

- 退出：直接关窗口，或点左下角「退出」按钮（桌面模式下才显示），两条路都会回收服务进程
- 日志：`%LOCALAPPDATA%\AgentForge\logs\`（`launcher.log` / `server.log`）
- 业务数据仍在项目内 `data/`
- 移除快捷方式：跑 `卸载桌面快捷方式.bat`，或 `node desktop/install.mjs --remove`
- 也可以 `npm run desktop` 直接启动（保留控制台，便于看日志）

## 界面

- **左栏**：团队成员（含在线状态 / SIM·CLI 标记 / 执行次数）、本机 CLI 扫描、历史任务
- **中栏**：协作时间线（流式输出、Markdown / 代码块 / 表格渲染）、底部群聊输入框
- **右栏**：执行链路（每道工序状态）、产物文件（点开即看源码）、统计与 Bot Hook
- **日夜模式**：右上角 `SHIFT` 开关切换白昼 / 夜巡两套配色

## 团队与角色

| 角色 | 默认成员 | 职责 |
|------|---------|------|
| planner | Nova | 拆需求、排工序、收口交付 |
| architect | Forge | 技术方案、接口契约、写设计文档 |
| coder | Kilo | 落代码、写文件 |
| tester | Probe | 用例矩阵、边界覆盖、回抛缺陷 |
| reviewer | Lens | 评审、质量门、卡 Blocker |

## 接入真实 CLI

「扫描本机 CLI」用 `where.exe` 先确认命令是否真的存在（只有存在才去读 `--version`），
探测 `claude / codex / opencode / dsh / workbuddy / crush / goose / aider / gemini / qwen / ollama`：

- **READY**：已安装，点「接入」自动带上绝对路径
- **N/A**：本机没有这个命令，点「手动」可以直接填绝对路径或任意自定义命令
- 点成员右侧的 **⚙** 可以改名字 / 切换模拟与 CLI / 改命令与参数，也能「移出团队」

调用方式说明：

- `.exe` 用参数数组直连进程，中文提示词原样送达
- `.cmd / .bat` 走 `cmd.exe`，会先 `chcp 65001` 再执行，避免 UTF-8 被按 GBK 解析成乱码
- 参数模板里没有 `{{prompt}}` 时，提示词改由 stdin 传入
- 子进程 stdin 会被立即关闭，防止 `codex` 这类工具卡在「Reading additional input from stdin」

CLI 以**任务工作区**为 cwd 执行，运行期间新增/修改的文件会自动收录进「产物」。
先把模式设为「真实 CLI」再填命令；不确定就先留在「模拟」模式。

## 外部触发（Bot）

```bash
curl -X POST http://127.0.0.1:8787/api/hooks/<token> \
  -H "Content-Type: application/json" \
  -d '{"goal":"做一个并发安全的待办 API"}'
```

Token 在右侧「统计」页可见，也可读 `data/db.json` 的 `settings.hookToken`。

## API

| 方法 | 路径 | 说明 |
|------|------|------|
| GET | `/api/state` | 全量状态（团队 / 任务 / 设置 / 当前任务） |
| POST | `/api/tasks` | `{goal, autoRun?}` 创建任务，默认自动开工 |
| GET | `/api/tasks/:id` | 任务详情（含消息、工序、产物） |
| POST | `/api/tasks/:id/run` | 重新编排 |
| POST | `/api/tasks/:id/stop` | 停止 |
| POST | `/api/tasks/:id/chat` | `{text}` 群聊，支持 `@成员名` |
| GET | `/api/tasks/:id/files` | 工作区文件列表 |
| GET | `/api/tasks/:id/file?path=` | 读取单个文件 |
| GET/POST | `/api/agents` | 团队列表 / 新增成员 |
| PATCH/DELETE | `/api/agents/:id` | 修改 / 移除成员 |
| POST | `/api/agents/:id/test` | 冒烟测试该 CLI |
| GET | `/api/probe` | 扫描本机 CLI |
| GET | `/api/stream` | SSE 事件流 |
| POST | `/api/hooks/:token` | 外部触发 |

## 目录

```
bot/
├─ server/
│  ├─ index.mjs         HTTP + SSE + 路由 + 静态资源
│  ├─ store.mjs         状态与持久化、事件总线
│  ├─ orchestrator.mjs  编排流水线、群聊、产物落盘
│  ├─ adapters.mjs      模拟流式输出 / 真实 CLI 适配 / 本机探测
│  └─ sim.mjs           内置智能体内容引擎
├─ public/              前端（原生 ESM，无构建步骤）
│  ├─ index.html
│  ├─ styles.css        像素印刷风视觉
│  ├─ app.js            SSE 客户端与渲染
│  ├─ icon-256.png      生成的网页图标
│  └─ fonts/
├─ desktop/             桌面化
│  ├─ launcher.mjs      拉起服务 + 打开应用窗口 + 关窗回收
│  ├─ install.mjs       一键部署快捷方式（桌面 / 开始菜单）
│  ├─ make-icon.mjs     纯 Node 生成 PNG / ICO 图标
│  ├─ start.vbs         生成的隐藏启动入口
│  └─ icon.ico
├─ 安装到桌面.bat
├─ 卸载桌面快捷方式.bat
└─ data/                运行时数据（已 gitignore）
```

## 说明

- 模拟模式产出的是**可运行的真实代码**：`data/workspaces/<taskId>/tests/*.test.js` 可直接 `node` 执行。
- 环境变量：`PORT`（默认 8787）、`HOST`（默认 127.0.0.1）。
- 视觉语言参考 `E:\vue黄课作\商品管理`（MAKET 像素仓库）：纸张黄 + 墨绿描边 + 硬投影 + 像素字。
