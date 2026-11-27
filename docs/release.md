# 发布规范

AgentForge 使用 [Semantic Versioning](https://semver.org/)：不兼容变更升 major，向后兼容能力升 minor，向后兼容修复升 patch。

## 版本源

`package.json` 是唯一版本源。服务端通过 `server/version.mjs` 读取 `APP_VERSION`，OTLP resource / scope 与 MCP `clientInfo` 都使用该值，不另写版本字面量。

## 发布步骤

1. 确认 `npm test` 与 `npm run check:syntax` 通过。
2. 更新 `package.json` 的 `version`。
3. 在 `CHANGELOG.md` 顶部增加同版本条目，并写清新增、变更与修复。
4. 同步更新 README 中受影响的用户可见能力说明。
5. 提交、打 tag，并同步 GitHub 与 Gitee。

## 当前版本

当前为 `1.1.0`。这是向后兼容的能力版本，`db.json` 结构保持兼容。
