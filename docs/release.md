# 发布规范

AgentForge 使用 [Semantic Versioning](https://semver.org/)：不兼容变更升 major，向后兼容能力升 minor，向后兼容修复升 patch。

## 版本源

`package.json` 是唯一版本源。服务端通过 `server/version.mjs` 读取 `APP_VERSION`，OTLP resource / scope 与 MCP `clientInfo` 都使用该值，不另写版本字面量。

## 发布前检查

在仓库根目录执行：

```bash
npm test
npm run check:syntax
git diff --check
```

三项都必须通过。`npm test` 会使用隔离的临时数据目录，不应改写仓库内 `data/`。

再检查文档事实是否一致：

- `README.md` 的能力、测试入口、数据目录和已知边界与当前源码一致。
- [平台演进路线](agent-platform-roadmap.md)、[OpenBot 融合计划](agentforge-openbot-plan.md) 和 [修复与验收计划](fix-plan.md) 的里程碑状态一致。
- `CHANGELOG.md` 已包含本版本的用户可见新增、变更、修复和已知限制。
- 内置 CLI 数量、Provider 默认值和历史验收结果没有被写成当前事实。
- 自动夹具与真实外部 CLI 验收明确区分。

可执行的最小文档审计：

```bash
grep -RInE "10 个内置|10 个候选|10 个外部 CLI|10 个 CLI|trae-cn/glm-5.3-flash|127.0.0.1:3425|server/attach\\.mjs|正规压缩|115 KB|待建" README.md CHANGELOG.md docs --exclude=release.md
```

结果应为空；历史设计段落若保留旧数字，必须明确标注“设计初稿”或“历史快照”。

## 版本发布

1. 更新 `package.json` 的 `version`，保持 `private: true`。
2. 在 `CHANGELOG.md` 顶部增加同版本条目，日期使用实际发布日。
3. 同步更新 README、路线图和计划文档中受影响的用户可见能力与边界。
4. 重新运行发布前检查。
5. 提交版本与文档改动：

   ```bash
   git add package.json CHANGELOG.md README.md docs
   git commit -m "release: vX.Y.Z"
   ```

6. 创建带注释 tag：

   ```bash
   git tag -a vX.Y.Z -m "AgentForge vX.Y.Z"
   ```

7. 显式推送两个远端和 tag：

   ```bash
   git push https://github.com/liuzheng6621/super-agentbot.git main
   git push https://github.com/liuzheng6621/super-agentbot.git vX.Y.Z
   git push gitee main
   git push gitee vX.Y.Z
   ```

8. 核对远端确实指向本地提交：

   ```bash
   git rev-parse HEAD
   git ls-remote https://github.com/liuzheng6621/super-agentbot.git refs/heads/main
   git ls-remote gitee refs/heads/main
   ```

`origin` 的 fetch 是 GitHub，但当前 push URL 被配置为 Gitee，因此不能把 `git push origin main` 当成同时推送两端。

## 依赖与锁文件

项目当前没有第三方运行时依赖，因此不生成 `package-lock.json`；CI 在 `actions/setup-node` 后直接运行 `npm test`。将来引入开发依赖时，再补锁文件并把 CI 改为 `npm ci`，不得为了“看起来完整”而生成空锁文件。

## 数据兼容

`db.json` 当前结构保持兼容，发布时不得悄悄改顶层形状或删除旧字段。新增字段必须有默认值或迁移路径；涉及持久化格式变化时，必须在 `CHANGELOG.md` 写清迁移方式和回滚边界。

`data/` 中的工作区、spill 和 attachments 不属于版本包，也不会被测试写入。发布前不要提交用户数据、运行日志或本地 Provider 凭据。

## 当前版本

当前为 `1.1.0`。这是向后兼容的能力版本，`db.json` 结构保持兼容。
