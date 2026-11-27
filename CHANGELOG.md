# Changelog

本文件记录 AgentForge 的发布版本。版本号遵循 [Semantic Versioning](https://semver.org/)。

## [1.1.0] - 2026-11-27

### Added

- Provider Profile 支持复制，保留密钥引用、CLI 绑定和环境变量模板；团队体检复用已绑定 Profile，覆盖模型、Base URL、密钥环境引用与 Windows `.cmd`。
- 任务优先级调度、平台产物配额、回收站保留期、增量工作区索引，以及 Automation durable `await_event` 的持久等待、幂等唤醒、取消和完成对账。
- 真实质量门：探测 `package.json scripts.test`、Makefile、pytest 配置、Cargo、Go 与 `tests/` 入口；CLI 成员产出的测试同样执行，并记录命令、退出码、耗时和 stdout / stderr 摘录。没有入口时返回 `no-test-entry`，不得交付。
- 独立评审：reviewer 缺位时只回退到 tester / architect；只有 coder 时明确不可用。任何实际自审都会记录 `selfReview`、`reviewerId`、`implementerId` 和 `review.independence`，并在任务摘要中可见。
- CLI 可执行文件解析增加进程级缓存，`/api/probe` 显式失效；缓存 key 保留完整命令串，解析时优先提取可执行名。
- 上下文预算与抽取式压缩：稳定前缀、来源消息范围、质量评估、历史记录、原文保留和按来源回放。
- 图片附件基础：PNG / JPEG / WebP / GIF 签名校验、8 MiB / 2048px / 400 万像素限制、内容寻址存储、Provider `vision` 门禁，以及前端上传与消息渲染。
- spill 推广到事件、消息、工具输出和超长导出附件；超时可由全局设置、Provider Profile 和 Agent Profile 分层覆盖。
- 统一版本源，OTLP 与 MCP 客户端信息从 `package.json` 读取。

### Changed

- `db.json` 持久化采用 200ms dirty 窗口，按 `agents / profiles / providers / settings / tasks` 记录脏区，只重新序列化变化任务；使用临时文件 + 原子替换，并在正常退出、`SIGINT` / `SIGTERM` 前 flush。当前没有显式 `fsync`。
- `CANDIDATES` 移除 Magpie 地址、模型和凭据参数，统一由 Provider Profile `cliBindings` 注入；内置候选实际为 15 个。
- 测试入口探测与质量门从 `orchestrator.mjs` 提取到 `server/test-entry.mjs`，保留兼容导出。
- 上下文压缩、评审独立性、评审分析、辩论分析和上下文预算按稳定职责拆分模块，`orchestrator.mjs` 保留兼容导出。
- 文档统一说明抽取式压缩不是模型语义摘要，自动夹具不等于真实外部 CLI 安装、授权与交付验收。

### Fixed

- CLI 模式不再整体跳过质量门；测试超时和非零退出会阻断交付并留下可审计记录。
- 评审员缺席时不再静默回落到实现者，避免实现者自审自身。
- 高频流式消息不再逐条触发全量持久化，降低写盘放大和事件循环阻塞。
- 修正 README 中的内置 CLI 数量、Provider 模型默认值和首次启动数据目录说明。

### Known Limits

- 15 个内置候选的安装、授权和真实交付矩阵仍需按环境逐项验收。
- 外部 CLI 的真实视觉端到端尚未全部验收；图片重编码规范化和附件 GC 尚未实现。
- 上下文摘要为抽取式，不是模型生成的语义摘要。
- Provider 级费用预算、内核级 CLI 隔离、完整账号 / RBAC / SSO、外部数据库或分布式队列仍未实现。

## [1.0.0] - 2026-11-24

### Added

- AgentForge 初始平台基线：多 Agent 编排、真实工作区、质量门、评审、辩论、持久化和控制台。
