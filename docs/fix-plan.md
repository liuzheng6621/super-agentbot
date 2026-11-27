# AgentForge 修复与验收计划

> 核查日期：2026-11-27
> 核查对象：`E:\SKIl.1\bot` 当前工作树
> 文档同步基线：`14fe33d docs: align plan baseline and remaining backlog`
> 本文性质：修复与验收文档；每项状态以“当前状态”和对应提交 / 测试为准

## 1. 目的与边界

这份文档回答三个问题：

1. 上一轮列出的 7 个失败中，哪些已经解决，证据是什么。
2. 当前代码里还有哪些缺陷、旧账和不能误报成“已解决”的风险。
3. `E:\SKIl.1\agent-web` 能否用于本项目，以什么方式使用。

本文件最初用于盘点残余项。盘点后，基础项 3.1、3.2、3.3、3.4、3.5、3.6、3.7 已按独立提交落地；本文件持续记录剩余验收项，不能用早期盘点结论覆盖后续代码事实。

## 2. 当前基线

### 2.1 测试结果

在 Windows、Node.js `v22.23.4` 下执行：

```powershell
$env:AGENTFORGE_DATA_DIR = 'C:\Users\six\AppData\Local\Temp\agentforge-fixplan-baseline'
node --test tests/*.test.mjs
```

结果：

| 指标 | 当前值 |
| --- | --- |
| 测试入口 | `npm test` |
| 数据隔离 | 每次运行使用独立临时 `AGENTFORGE_DATA_DIR` |
| 当前结果 | 全量通过；具体数量随用例增减，不在文档中固定 |

结论：**当前工作树在这一个环境下全绿，旧的“153/160、7 个失败”不能再当作当前基线。** 这不等于跨平台、干净环境和真实 CLI 链路都已验收；下面仍列出这些缺口。工作树在核查期间仍在变化，测试数量随用例增减，不能把任何固定数字写成 README 常量。

### 2.2 已确认改善

| 原问题 | 当前状态 | 仍需注意 |
| --- | --- | --- |
| `node --test tests/` 在 Node 22 上把目录当模块 | 已改为递归枚举测试文件并传真实路径 | `tests/quality.test.mjs` 覆盖 `.spec`、嵌套目录和空目录 |
| 命令路径跨平台归一化 | `server/adopt.mjs` 已接入共享 `command-key` | 路径、扩展名、引号和带参数命令均有测试 |
| 阶段超时固定 | 新增 `server/timeouts.mjs`，支持设置、Provider、Agent/Profile 分层覆盖 | 前端字段与真实 CLI 超时冒烟已验收，见 3.8 |
| 超长产物 spill | 已覆盖事件、消息、工具输出和导出 | 已有自动化回归；大任务端到端压测仍建议保留 |
| 工作区文件闭环 | 读、写、增、删、移、查、事务与审计均有测试 | 跨进程 CLI 的强制边界仍有限 |

## 3. 仍需修复的问题

### 3.1 P0：测试入口探测与执行范围不一致（已完成）

**位置**：`server/orchestrator.mjs` 的 `detectTestCommand()`，当前约 2326-2390 行。

**现状**：探测时接受：

```text
*.test.js / *.test.mjs / *.test.cjs
*.spec.js / *.spec.mjs / *.spec.cjs
```

但返回的命令固定为：

```text
node --test tests/**/*.test.{js,mjs,cjs}
```

因此只有 `*.spec.*` 的项目会被探测为“有测试”，实际却可能一个文件都没跑；嵌套测试和 shell glob 展开也存在跨平台差异。

**风险**：质量门可能对空集合执行成功，形成假绿；这不是旧的 `MODULE_NOT_FOUND`，但仍是真实交付风险。

**修法**：

1. 递归枚举 `tests/` 下实际存在的 `.test.*` 与 `.spec.*` 文件。
2. 按稳定顺序排序，把每个相对路径逐个作为 `--test` 参数。
3. 列表为空时返回 `null`，质量门保持 `no-test-entry`。
4. `package.json scripts.test` 始终优先于自动探测。
5. 命令记录中保留真实文件列表，不只记录 glob 模板。

**已实施**：`0ae62cc P0 execute detected node test files`。测试入口改为递归枚举并按稳定顺序传真实文件；`.spec.*`、嵌套文件、空目录、`tests` 为文件和 `package.json scripts.test` 优先级均有回归用例。

**回归用例**：

- 只有顶层 `.spec.mjs`。
- 只有嵌套 `tests/unit/foo.test.mjs`。
- 同时存在 `.test` 与 `.spec`，两者都执行。
- 空 `tests/`、`tests` 是文件、只有非测试 JS。
- `package.json` 的显式 test 脚本优先。

验收命令：`node --test tests/quality.test.mjs`。

### 3.2 P1：命令归一化尚未全部收口（已完成）

**位置**：`server/adopt.mjs` 当前约 1-116 行。

**现状**：

- `server/team.mjs`、`cli-policy.mjs`、`providers.mjs`、`adapters.mjs`、`orchestrator.mjs` 已使用共享 `commandKey` / `commandBaseName`。
- `adopt.mjs` 仍用本地 `path.basename`。
- `adoptInstalledClis()` 的 `taken` 集合使用 `baseName`，候选 key 却使用 `String(c.command).toLowerCase()`。

**后果**：同一个 CLI 以 `opencode`、`C:\...\opencode.cmd`、`C:/.../opencode.exe` 出现时，接管去重可能失效；POSIX 处理 Windows 路径时也会返回整串路径。

**修法**：

1. `adopt.mjs` 删除本地 `baseName`，统一导入 `commandBaseName`。
2. 候选去重、团队分配、健康缓存和持久化都用同一个 key。
3. 单独定义带参数命令串的解析规则；不要把 `"C:\Program Files\x.exe" --flag` 直接交给 `path.basename`。
4. 删除 `server/command-key.mjs` 中未使用的 `nativeBaseName()`，或明确它的调用方和测试。

**已实施**：`e0a0d6e P1 normalize adopted CLI command keys`。接管、去重和缓存统一使用共享命令 key，并覆盖 Windows 路径、扩展名、引号、空格和带参数命令。

**回归用例**：

- `C:\tools\codex.exe`、`C:/tools/codex.cmd`、`codex` 折成同一个 key。
- 带引号、带空格、带参数的命令不会把参数当文件名。
- `adoptInstalledClis()` 对同一工具只创建一次。
- 空值和异常路径不抛错。

验收命令：`node --test tests/team.test.mjs tests/cli-policy.test.mjs`。

### 3.3 P1：Windows `.cmd/.bat` 参数编码仍不安全（已缓解并覆盖）

**位置**：`server/adapters.mjs` 的 `quoteArg()` 当前约 45-53 行，`.cmd/.bat` 分支约 300-308 行。

**现状**：Windows 分支用反斜杠转义双引号，而 `cmd.exe` 不使用 POSIX 的反斜杠转义规则；该路径又通过 `shell: true` 启动。prompt 含 `"`、`&`、`|`、`<`、`>`、`^` 或换行时，参数边界可能被改变。

**已缓解部分**：部分包装器 CLI 已改为通过 stdin 传 prompt；`.exe` 直连路径不走这条 shell 链。

**仍未解决**：用户自定义 CLI 模板只要把 `{{prompt}}` 放进参数且命中 `.cmd/.bat`，仍会进入风险路径。

**修法优先级**：

1. 复杂 prompt 一律优先走 stdin 或临时文件，不拼进 cmd 命令行。
2. 必须拼参数时，为 cmd.exe 单独实现参数编码，不复用 POSIX/通用 Windows 引号规则。
3. 不允许通过字符串拼接启动任意 shell。
4. 在 Windows CI 上做真实 `.cmd` 夹具测试。

**已实施**：`4c78648 P1 harden Windows cmd argument handling`。`.cmd/.bat` 包装器优先走 stdin；必须拼参数时使用独立的 cmd.exe 元字符编码；`tests/adapters.test.mjs` 覆盖中文、引号、`& | < > ^`、括号、百分号、反斜杠、多行和空参数。

**回归用例**：中文、双引号、`& | < > ^`、括号、百分号、反斜杠、多行文本、空参数。

### 3.4 P1：测试隔离依赖调用者设置环境变量（已完成）

**现状**：大多数测试自行设置临时 `AGENTFORGE_DATA_DIR`，但以下文件没有：

- `tests/dag.test.mjs`
- `tests/adapters.test.mjs`
- `tests/security.test.mjs`

本次全绿是因为运行前显式设置了临时数据目录。直接执行 `npm test` 时，部分测试可能读取开发目录 `data/`，与真实开发数据互相影响。

**修法**：

1. 增加统一测试入口，为整个测试进程设置唯一临时数据目录。
2. 测试结束清理该目录；失败时保留路径并在日志中打印。
3. 禁止测试依赖仓库内 `data/`。
4. 不要直接删除现有 `data/`；它可能包含用户数据。

**已实施**：`61c7aef P0 isolate test data directory`。`npm test` 由 `tests/run-tests.mjs` 创建唯一临时目录；通过后清理，失败时保留并打印路径。测试不再依赖调用者预先设置环境变量。

**验收**：连续运行两次 `npm test`，`data/` 的修改时间、文件数量和内容摘要不变化。

### 3.5 P1：README 和路线图数字过期（已完成）

**现状**：README 和路线图曾写固定测试数，随新增用例持续漂移。

**已实施**：

- 不在徽标里手写“通过数”，改用 CI 状态。
- 正文只写统一测试入口和覆盖范围，避免数字漂移。
- README、路线图与 OpenBot 计划均改为“以 `npm test` / CI 为准”。

### 3.6 P1：没有 CI，也没有锁文件（已完成）

**现状**：仓库没有 `.github/`，没有 `package-lock.json`。当前 `npm test` 仅在 Windows / Node 22 手工验证。

**已实施**：

1. GitHub Actions 矩阵：Ubuntu + Windows；Node 20 + Node 22。
2. 每个矩阵运行 `npm test`。
3. 增加 `npm run check:syntax`：所有 Git 跟踪或未忽略的 `.js/.mjs` 跑 `node --check`。
4. 暂时不引入重型 lint；先建立正确性门。
5. 失败时上传测试日志。

**锁文件结论**：当前项目零第三方依赖，`setup-node` 后直接运行即可，因此本轮不生成 `package-lock.json`；将来引入开发依赖时再补锁文件并改用 `npm ci`。

**验收**：故意提交一个失败测试，CI 必须报红；恢复后四组合全绿。

### 3.7 P1：Markdown 链接协议未做 allowlist（已完成）

**位置**：`public/app.js` 的 `inlineMd()` 当前约 191-197 行；消息渲染在 `patchMessage()` 当前约 765-769 行。

**现状**：先做 HTML 转义，再把 Markdown 链接直接拼成 `<a href="$2">`。`[x](javascript:...)` 这类内容可能成为可点击的危险链接。

**风险等级**：代码层确认存在；尚未在浏览器中复现利用链，因此文档不把它写成已发生安全事件。

**已实施**：

1. URL 解析后只允许 `http:`、`https:`、`mailto:` 和相对链接。
2. 拒绝 `javascript:`、`data:`、`vbscript:`、`file:` 等协议；非法链接只保留文字。
3. 外链统一加 `target="_blank" rel="noopener noreferrer"`。
4. `tests/markdown-links.test.mjs` 覆盖允许协议、拒绝协议和 HTML 转义。

### 3.8 P2：超时改造端到端验收（已完成）

**现状**：

- `server/timeouts.mjs` 已实现分层优先级和边界。
- `tests/timeouts.test.mjs` 覆盖优先级、Profile 同步和审计。
- `CLI_TIMEOUTS` 曾作为旧导出保留，存在两套预算来源。
- 前端已有超时字段，但此前没有浏览器自动化证据。

**修法**：

1. 将 `CLI_TIMEOUTS` 标记为兼容常量，内部路径只使用 `timeoutFor()` / `resolveTimeouts()`。
2. 补前端保存、重载、显示生效值的浏览器测试。
3. 用一个会超时的真实 CLI 夹具验证：超时状态、进程树回收、错误事件、任务终态。

**已实施**：移除 `CLI_TIMEOUTS`，内部默认值统一走 `timeoutFor()` / `resolveTimeouts()`。`tests/quality.test.mjs` 用真实 npm 测试脚本触发 30 秒质量门超时，验证 `status=timeout`、退出码 `-3`、真实耗时、stdout/stderr 摘录、`quality.gate.timeout` 事件和禁止交付；进程在预算后结束，没有继续挂住。

### 3.9 P2：历史任务标题乱码已定位为显示证据缺失（已完成）

**现状**：`docs/screenshot.png` 中可见 `???????????????? API,??????????`。截图引入于提交 `a760a7c`，但没有证据说明乱码发生在数据库、终端代码页、前端渲染还是导出。

**修法**：

1. 新建包含中文、emoji、日文、特殊符号的任务。
2. 检查创建请求、内存对象、`db.json`、重启后读取、页面渲染、Markdown / HTML 导出。
3. 若只在旧数据出现，提供一次性迁移；若新数据可复现，修写入或读取入口。
4. 补持久化与导出回归测试。

**不要先下结论**：当前不能把根因归到数据库或控制台代码页。

**已实施**：`tests/transcript.test.mjs` 新增真实 HTTP 回归：创建包含中文、emoji、日文、引号和 HTML 特殊字符的任务，验证创建响应、`/api/state`、`db.json`、停止后重启读取、任务详情、Markdown / HTML 导出均保留原文；HTML 导出按预期转义 `<`、`>`、`&`、`"`，不是编码丢失。标题按既有规则截断到 26 个字符，完整目标始终保存在 `goal`。当前工作树无法复现新数据的乱码；截图中的旧数据显示问题仍缺少可重复证据，因此没有做无依据的数据迁移。

### 3.10 P2：“选择文件夹”可见性与交互已完成浏览器验收

**现状**：

- 按钮：`public/index.html` 的 `#dirPick`，当前约 175 行。
- 模态框：同文件当前约 656 行。
- 前端逻辑：`public/app.js` 当前约 3616-3661 行与 4527-4554 行。
- 后端接口：`server/index.mjs` 的 `/api/fs` 当前约 1006 行。

所以这不是“完全没写”。如果桌面端看不到，优先排查：

1. 桌面端加载的是旧前端缓存或旧打包产物。
2. 窗口宽度不足，按钮被响应式布局隐藏。
3. `/api/fs` 返回 400/500，用户只看到“读取失败”。
4. 启动的是另一个目录/端口的旧服务。

**验收场景**：桌面端和浏览器端分别检查按钮可见、进入目录、返回上级、选择盘符、确认、取消、无权限目录、含空格和中文路径。截图必须来自当前构建。

**已实施**：`tests/folder-picker.test.mjs` 启动真实服务与 Microsoft Edge headless，通过 CDP 验证当前构建中 `#dirPick` 首屏可见、模态框可打开、目录可进入和返回上级、中文与空格目录可选择并写入 `localStorage`、确认和重置状态正确；当前构建截图输出到 `artifacts/folder-picker/folder-picker.png`。同一测试还覆盖 `/api/fs` 对不存在路径和普通文件的显式 400 响应。

**环境限制**：无 Edge 或无法启动 CDP 时该浏览器用例显式跳过，并提示设置 `AGENTFORGE_EDGE_PATH`；API 错误路径仍会执行。桌面壳使用同一套前端与服务，但本轮未做 Windows 桌面窗口自动化，因此“桌面端不可见”的旧截图仍不能作为根因证据。

### 3.11 P2：结构债务（逐步提取中）

当前主要文件规模：

| 文件 | 行数 |
| --- | ---: |
| `public/app.js` | 4984 |
| `public/styles.css` | 6093 |
| `server/store.mjs` | 3164 |
| `server/orchestrator.mjs` | 3130 |
| `server/workspace.mjs` | 1118 |
| `server/tool-gateway.mjs` | 607 |

当前已开始按稳定职责拆，不做一次性重写。`server/test-entry.mjs`、`server/review-independence.mjs`、`server/review-analysis.mjs`、`server/debate-analysis.mjs` 和 `server/context-budget.mjs` 已从 `server/orchestrator.mjs` 提取，保留原导出兼容；后续继续按小步提交：

- `orchestrator`：run controller、step runner、debate、quality gate、review、plan。
- `store`：持久化、租户、任务查询、租约、迁移。
- 前端：state、SSE、任务视图、工作区、辩论、组件、样式分层。

每一步拆分必须保持公开导出兼容，并以当前 `npm test` 全绿加手工冒烟为准，不在文档中固定测试数量。`server/store.mjs` 暂不拆分：持久化、多实例锁和 dirty 窗口的边界风险高，当前以单文件按职责分区为准。

### 3.12 P2：其他旧账

| 项 | 现状 | 建议 |
| --- | --- | --- |
| 零依赖承诺 | 当前无运行时依赖 | 开发工具可以引入，最终用户仍应克隆即用 |
| 版本号 | 已统一到 `package.json` 的 `1.1.0`；OTLP / MCP 不再写死版本 | 后续发布按 `docs/release.md` 同步版本、CHANGELOG 与 tag |
| 任意 shell | 仍关闭 | 保持关闭；只扩展固定命令和审批 |
| 内核级隔离 | 未实现 | 不把 strict 原生沙箱宣传成完整进程隔离 |
| 真实 CLI 覆盖 | 质量门、固定命令和团队体检已有真实子进程夹具；完整 CLI 交付矩阵仍缺 | 增加最小真实 CLI 矩阵，见第 6 节；安装或授权状态必须逐项记录，夹具不能冒充外部 CLI 验收 |
| 团队体检临时工作区 | 已修复 `cwd/path` 缺失，并用 `tests/team.test.mjs` 验证真实体检命令 | 继续扩展到 `.cmd/.bat` 与真实 Provider |
| 工作区配额与清理 | 已实现平台产物配额、显式 413 拒绝、回收站保留期清理与任务用量投影 | 外部项目文件不计入配额；默认 `0 = 不限`，不静默删除业务文件 |
| 任务优先级 | 已实现 `low / normal / high` 调度顺序、同优先级 FIFO、旧任务迁移和前端选择 | 只影响等待队列，不抢占已运行任务；Provider 级费用预算仍未实现 |
| 超大目录树 | 已懒加载，并实现按任务与真实工作区根绑定的增量索引；CLI 前后仍执行权威全量扫描，截断扫描不产生删除结论，平台写 / 移动 / 删除会失效对应索引 | `tests/quality.test.mjs` 与 `tests/workspace.test.mjs` 覆盖复用、工作区切换、截断完整性及写 / 移动 / 删除失效；真实超大仓库压测仍建议单独保留 |

### 3.13 P1-6 持久化结论

**结论：不是每次全量写，本轮不改持久化实现。**

`server/store.mjs` 已实现 200ms dirty 窗口、按 agents / profiles / providers / settings / tasks 记录脏区、只重新序列化变化任务、原子替换 `db.json`，并在 `process.exit`、`SIGINT`、`SIGTERM` 前 flush。`tests/persistence.test.mjs` 已验证 200 次 `appendMessage` 合并为一次写盘，且正常退出后数据完整可读。

后续建议：如果出现超大单任务或高并发多实例写入，再单独评估按任务分文件或外部存储；本轮保持 `db.json` 结构兼容。

## 4. 工具调用能力评估

### 4.1 当前能力

| 操作 | 实现 | 当前可靠性 |
| --- | --- | --- |
| 查 | 工作区树、读取、搜索、Diff、事件 | 有路径边界、大小限制和测试 |
| 增 | 新文件、新目录 | 原子写、路径校验 |
| 改 | 覆盖写、编辑保存 | 版本令牌、读后写守卫、审计 |
| 移 | 文件/目录移动、重命名 | 冲突检查、事务支持 |
| 删 | 移入 `.agentforge/trash` | 可恢复、有变更记录 |
| 批处理 | 事务提交与回滚 | 中途失败可回滚真实文件与元数据 |

结论：**平台 API 层的文件闭环已基本完整，测试覆盖也强于普通 MVP。** 但真实 CLI 子进程在 `inherit` 模式下仍可能绕过平台网关直接使用本机工具，因此不能把平台 API 的可靠性等同于 CLI 的强制隔离。

### 4.2 是否基于 Magpie

不是整体基于 Magpie。代码中仍能看到 Magpie 的模型/网关默认值和 CLI 参数模板，但工作区文件、工具网关、调度、持久化和评审不是 Magpie 实现的。

更准确的说法：

- **编排与文件能力**：AgentForge 自有实现。
- **部分 CLI 的默认模型/网关配置**：仍有 Magpie 相关硬编码。
- **执行隔离**：部分是 CLI 原生沙箱映射，不是 Magpie 代理。

### 4.3 提升泛用性

1. 把 `CANDIDATES` 里的 Magpie 地址、模型名、API key 模板迁到 Provider Profile。
2. 定义通用 CLI 适配器契约：发现、探活、参数模板、stdin 模式、超时、退出码分类、能力声明。
3. 工具能力用声明式 manifest 表示，不按命令名写分支。
4. 对不支持原生沙箱的 CLI 明确标为“不可强制隔离”，strict 下拒绝。
5. 用统一验收夹具验证任意新 CLI，而不是只给内置 10 个命令加特例。

## 5. 工作区、工作树与流程视图

### 5.1 当前已有

- 任务级工作区树、预览、编辑、搜索。
- Git detached worktree，失败时回退 shared clone。
- 文件变更、工具调用、运行事件。
- 计划版本、DAG、时间回放、跨任务总览、Diff。
- 全屏工作区控制台。

### 5.2 仍不够直观的地方

当前页面已有“工序状态”，但复杂项目真正需要的是**一个任务从规划到交付的可追溯链路**：

```text
任务目标
  -> 计划版本
  -> 并行工序
  -> 每个工序的 Agent / 工具 / 文件 / 产物
  -> 质量门命令与结果
  -> 返工与重规划
  -> 独立评审
  -> 交付
```

### 5.3 推荐视图

1. **工作区总图**：任务、worktree、分支、Provider、Agent 租约、阻塞原因。
2. **DAG 泳道**：节点显示角色、Agent、工具、耗时、状态、重试次数。
3. **文件时间线**：每次读写与版本令牌，能追到哪个工序产生。
4. **质量门面板**：真实命令、cwd、退出码、stdout/stderr、超时、返工轮次。
5. **回放**：按时间合并消息、工具事件、文件变更和计划变更。
6. **跨任务对比**：同项目多个 worktree 的进度、冲突和资源占用。

视图只读投影应继续由服务端提供，前端不要自己猜状态。

## 6. 并发与 Agent 分工

### 6.1 当前能力

- 多任务可并行，有全局并发上限。
- Provider 配额、Agent 租约、排队原因。
- Agent Profile 包含角色、技能、工具、MCP、Provider、模型和并发。
- 工作区池支持显式共享与私有目录。
- DAG 支持独立分支并行和汇合等待。

### 6.2 仍缺

- 规划器仍以五个固定角色为主，尚未完全按能力标签选 Agent。
- Provider 配额按活跃任务计数，单任务内多个并发工序仍可能压满同一 Provider。
- 跨任务工作区已有平台产物配额和回收站保留期清理；外部项目文件仍不计入配额。
- 工具不足时虽有策略拒绝，但“能力缺口”在计划阶段还不够显式。
- 进程内 Scheduler 不是分布式队列，多实例协调仍靠文件锁和租约。

### 6.3 实施建议

1. Profile 增加 `capabilities` 标签和工具能力清单。
2. 计划节点声明所需能力，不直接绑定角色。
3. 调度器按任务、Provider、CLI、工作区四个维度排队。
4. 明确租约模式：独占、共享、只读。
5. 任务开始前生成“能力缺口报告”，缺工具时拒绝假装可完成。
6. 工作区池的配额、保留期和回收审计已覆盖平台产物；继续补跨任务池的独立配额。

## 7. `E:\SKIl.1\agent-web` 评估

### 7.1 它是什么

| 项 | 实际情况 |
| --- | --- |
| 路径 | `E:\SKIl.1\agent-web` |
| HEAD | `fe543ea chore(release): v0.78.3...` |
| 包名 | `agent-case` |
| 版本 | `0.78.3` |
| 运行时 | Node >= 20，ESM，零运行时依赖 |
| npm 发布 | 尚未发布，README 明确写 `npx agent-case` 当前会 404 |
| 定位 | 机器可判的集成测试 / 认证引擎，不是 Web 前端应用 |

本机自测结果：

```text
样本 N=13  pass=9 fail=3 unknown=1
可判定率 92.3% (12/13)
与预期标签一致 100.0% (13/13)
```

结论：**能跑通，可以用于本项目，但应作为开发期验收工具，不应现在变成 AgentForge 的运行时依赖。**

### 7.2 可直接借鉴的机制

1. **三值判决**：`pass`、`fail`、`unknown`；`unknown` 留在分母，不偷偷算通过。
2. **适配器契约**：`manifest`、`reset`、`observe`、`execute`、`close`。
3. **五类执行结果**：`applied`、`rejected`、`unsupported`、`infra_error`、`may_have_committed`。
4. **证据等级与视图契约**：案例只依赖稳定视图，不依赖实现细节。
5. **记录/回放、审计、陷阱、覆盖率、变异认证**。
6. **假绿检测**：候选结果必须能区分真实通过、真实失败和环境未知。
7. **CI 反向验证**：故意制造假绿，CI 必须报红。
8. **自包含流程页**：`src/flow.mjs` 生成可展开的执行流程 HTML。

### 7.3 不能直接替代什么

- 不能替代 `public/app.js` 的产品界面。
- 不测试前端布局、交互、可访问性或性能。
- 不提供 AgentForge 所需的任务持久化、租户、Scheduler。
- 同进程加载适配器存在爆炸半径；适配器仍可能撒谎。
- npm 包未发布，不能承诺 `npx` 安装。

### 7.4 推荐接入方式

采用**开发期验收预言机**，不进入生产运行链：

1. 在 AgentForge 仓库外保留独立 checkout：`E:\SKIl.1\agent-web`。
2. 通过环境变量 `AGENT_WEB_ROOT` 或测试脚本定位，不复制源码进主仓库。
3. 固定到已验收提交 `fe543ea`，升级必须单独评审；测试脚本先校验 `git rev-parse HEAD`，不一致就明确报错或跳过。
4. 编写 AgentForge adapter，实现五方法契约。
5. 先覆盖只读和可回放场景，再覆盖真实 CLI。
6. CI 中若需要它，先 vendoring 或发布私有包；当前不要依赖 404 的 npm 包。

已完成开发期接入：

- 适配器：`tests/fixtures/agent-web/agentforge-adapter.mjs`。
- 案例：`tests/fixtures/agent-web/cases/`，共 10 个核心场景。
- 自动验收入口：`tests/agent-web-compat.test.mjs`。
- 固定提交：`fe543ead03c9b200a9bfebf39e86cf5b676edfbc`；commit 不符直接失败，checkout 缺失时显式跳过。
- 2026-11-27 实测：10/10 `pass`，覆盖质量门通过、返工、超时、停止、重启恢复、工作区事务和 Unicode 导出。

推荐环境变量：

```text
AGENT_WEB_ROOT=E:\SKIl.1\agent-web
AGENT_WEB_COMMIT=fe543ea
```

Windows PowerShell 下如果 `node` 不在 `PATH`，夹具应允许显式指定
`AGENT_WEB_NODE` 的绝对路径；不得把本机临时 Node 路径写死进仓库。

### 7.5 AgentForge 验收案例

首批案例：

1. 创建任务并分配工作区。
2. direct 模式完成实施、质量门、交付。
3. 质量门通过。
4. 质量门真实失败并返工。
5. 质量门超时。
6. 停止与取消。
7. 重启恢复。
8. 工作区读、写、移动、删除、事务回滚。
9. 导出中文与特殊字符不丢失。
10. 模拟实现与真实 CLI 的关键判决一致。

每条案例都要记录：

- 前置工作区。
- 操作。
- 观察点。
- 期望判决。
- 失败证据。
- 是否允许 `unknown`。

### 7.6 流程视图可借鉴到什么程度

可以借鉴：

- 单次运行逐步展开。
- 只显示偏差。
- 断言三值结果。
- 状态事件和证据引用。
- 总览页的判决分布与可判定率。

不能照搬：

- 咖啡店领域案例。
- 以案例为中心的导航。
- 只在测试运行时生成静态 HTML 的产品交互。

AgentForge 应把这些概念映射到任务、工序、工具调用、文件变更和质量门。

## 8. 修复顺序

| 顺序 | 工作 | 优先级 | 验收 |
| --- | --- | --- | --- |
| 1 | 统一测试临时数据目录 | P0 | 连续两次测试不碰 `data/` |
| 2 | 修复测试文件枚举与 `.spec` | P0 | `quality.test.mjs` 新旧场景全绿 |
| 3 | 收口 `adopt.mjs` 命令归一化 | P1 | 路径、扩展名、带参数用例通过 |
| 4 | 建立四组合 CI | P1 | 配置完成；推送后观察 GitHub Actions 四组结果 |
| 5 | 修 Windows `.cmd/.bat` 参数 | P1 | Windows 真实夹具覆盖特殊字符 |
| 6 | Markdown URL allowlist | P1 | 已完成：单元测试 3/3；浏览器冒烟见 9.4 |
| 7 | README / 路线图数字去漂移 | P1 | 已完成：文档以测试入口和 CI 为准 |
| 8 | 超时浏览器与真实 CLI 冒烟 | P2 | 超时、取消、进程回收可观察 |
| 9 | 乱码复现与迁移判断 | P2 | 创建、落库、重启、导出均保持原文 |
| 10 | 文件夹选择器可见性验收 | P2 | 桌面端和浏览器端都可操作 |
| 11 | 接入 agent-web 验收夹具 | P2 | 已完成：10/10 核心案例可重复运行 |
| 12 | 拆巨型文件 | P2 | 每步测试全绿，无行为漂移 |

## 9. 统一验收清单

### 9.1 自动化

```powershell
node --check server/index.mjs
node --test tests/*.test.mjs
```

已加入 CI：`npm run check:syntax` 与 `npm test` 是仓库统一入口，不在文档里复制散落命令。

agent-web 独立验收（checkout 固定到 `fe543ea`）：

```powershell
node bin/agent-web.mjs verify E:\SKIl.1\bot\tests\fixtures\agent-web\cases `
  --adapter=E:\SKIl.1\bot\tests\fixtures\agent-web\agentforge-adapter.mjs --json
```

仓库内 `tests/agent-web-compat.test.mjs` 会校验固定提交并断言 10 条全部 `pass`；没有 checkout 时显式跳过，不会伪报通过。

### 9.2 手工冒烟

1. 新建任务。
2. direct 开工。
3. debate 开工。
4. 选择一个真实项目文件夹。
5. 工作区读、写、移动、删除。
6. 停止任务。
7. 重启并恢复。
8. 质量门成功、失败、超时。
9. 审批固定命令。
10. 导出 Markdown / HTML。
11. 中文、emoji、特殊字符任务标题。
12. 桌面端和浏览器端都检查文件夹选择按钮。

### 9.3 真实 CLI

至少覆盖：

- 一个 `.exe`。
- 一个 `.cmd`。
- 一个无扩展名 POSIX 可执行文件。
- 一个可用 Provider。
- 一个备用 Provider。
- 一个 CLI 缺失。
- 一个鉴权失败。
- 一个真实超时。
- 一个取消。

## 10. 明确未验证

以下结论目前没有足够证据，不能写成已修复：

- Linux / macOS 的完整测试矩阵。
- 文件夹选择按钮在桌面端不可见的具体根因。
- 截图乱码的根因。
- Markdown 危险协议的浏览器利用链。
- 真实 CLI 的完整端到端交付。
- 多工作区高并发下的磁盘和 Provider 压测。

这些项目应在后续提交中逐项变成可重复测试，而不是只更新文字结论。
