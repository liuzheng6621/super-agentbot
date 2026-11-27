# Changelog

本文件记录 AgentForge 的发布版本。版本号遵循 [Semantic Versioning](https://semver.org/)。

## [1.1.0] - 2026-11-27

### Added

- Provider Profile 支持复制，保留密钥引用、CLI 绑定和环境变量模板。
- 任务优先级调度、工作区配额与回收站保留期、持久化 Automation 事件等待。
- 质量门真实测试入口探测、CLI 测试执行、独立评审标记、CLI 解析缓存和增量持久化验证。
- 统一版本源，OTLP 与 MCP 客户端信息从 `package.json` 读取。

### Changed

- 上下文预算、压缩与回放逻辑继续保留 orchestrator 兼容导出，便于后续按模块拆分。
- 真实 CLI、团队体检与多实例边界以测试和手工验收清单记录，不把未验收能力写成已完成。

## [1.0.0] - 2026-11-24

### Added

- AgentForge 初始平台基线：多 Agent 编排、真实工作区、质量门、评审、辩论、持久化和控制台。
