# AgentForge 文件、读图与上下文设计（以 DSH 内部实现为蓝本）

> 调研对象：`@deepseek-ai/dsh` 的公开包文档与本地运行时行为。
> 依据：DSH 子系统文档、插件包 README，以及受控兼容网关的图片输入验证。
> 文档状态：本文最初用于设计与差距分析。三项能力现已落地；前半部分保留“设计初稿时”的判断，当前状态以本页“实施结果”和测试为准。

**当前结论**

- 文件原子写、内容版本、读后写守卫和事务回滚已经落地。
- 图片附件已经有类型 / 体积 / 尺寸校验、内容寻址存储和 Provider `vision` 能力门禁；尚未完成外部 CLI 的逐项真实视觉验收，也没有图片重编码规范化。
- 上下文已经有稳定段序、token 估算、spill、自动压缩、质量评估和回放；当前摘要仍是**抽取式**，不是模型生成的语义摘要。
- 这些能力不等于内核级隔离：`strict` 仍是 CLI 原生沙箱映射，网络请求、系统调用和跨进程文件租约尚未统一拦截。

---

## 0. 结论摘要

| # | 领域 | 设计初稿时的 AgentForge | DSH 的做法 | 差距性质 |
|---|---|---|---|---|
| 1 | 文件读写 | `fs.writeFileSync` 直写；靠 `mtimeMs+bytes` 判断变更 | 原子交换 + 不透明版本令牌 + 意图守卫 + 12 个稳定错误码 | **正确性**（断电/并发写坏文件、等长改写漏检） |
| 2 | 读图 | 零能力，消息只有纯文本 | 内容寻址附件 + 规范化 + `ImageBlock` 引用 + 按路由投影 + 超预算省略 | **能力缺失**（兼容路由验证支持视觉，但当时未接入） |
| 3 | 上下文 | 单条扁平 prompt，**易变块排在最前**；`ceil(len/3)` 估 token；依赖产物 `clip(6000)` 丢中间 | 分段注册表 + 仅追加日志投影 + 前缀友好的稳定段 + compaction/pruner/spill 三层减法 | **成本 + 质量**（每一步都打掉前缀缓存，且信息不可恢复地丢失） |

设计初稿时三条里性价比最高的是 **3**：不新增依赖、不改协议，只调整 prompt 的段序与预算，立刻省钱。其次是 **1** 的原子写。**2** 工作量最大，但兼容路由已能接受图片输入，属于纯增量能力。上述三项现均已实现基础版本。

---

## 1. 读写的文件操作

### 1.1 DSH 的分层与 AgentForge 的对应实现

| 角色 | 包 | 职责 | 与 AgentForge 的对应物 |
|---|---|---|---|
| Service Definition | `dsh-fs` | `ctx.fs` 抽象接口 + 受防护的变更操作 | 不做通用服务 seam；由 `server/workspace.mjs` 与 Tool Gateway 提供受控操作 |
| Service Provider | `dsh-fs-local` | 本地磁盘实现（原子写、版本令牌） | `server/fs.mjs` 提供原子写、内容版本和 spill |
| Policy | `dsh-fs-observation-policy` | 记录「谁读过什么」，把写入意图升级成守卫 | `server/workspace.mjs` 在工作区与网关链路中校验最近读取版本 |
| Consumer | `dsh-tool-fs` | 面向模型的 read / read_image / write / edit / apply_patch | Tool Gateway 提供工作区文件能力；外部 CLI 通过只读路径与约束读取 |
| Pure lib | `dsh-fs-patch` | 补丁解析与文本应用 | 可选，暂不做 |

关键设计原则是**换后端不改策略，换策略不改工具 schema**。AgentForge 不引入 DSH 的完整服务 seam，但已经把原子写、版本、读后写守卫、事务和工作区索引拆到稳定模块中，避免各调用点各写一套文件语义。

### 1.2 DSH 的六个关键机制

**① 不透明身份 + 后端拥有的版本令牌**

```ts
interface FsTarget { targetKey: Branded<'FsTargetKey'>; displayPath: string }
type FsVersion = Branded<'FsVersion'>   // 新鲜度令牌，由后端产生
```

消费方可以显示 `displayPath`，**禁止解析 `targetKey`**。这样换后端（本地/沙箱/远端）不需要改任何调用点。
`stat(target)` 只返回 `{version, type, size?}`，**从不返回内容**；`lstat(path)` 不跟随末段符号链接，供信任边界检查。

**② 写入意图是三态而不是二态**

```ts
type FsWriteIntent =
  | { kind: 'createIfAbsent' }
  | { kind: 'replaceIfVersion', version: FsVersion }
// 省略 expected 参数 = 无条件创建或覆盖（这是第三种行为，不是联合的第三臂）
```

- `createIfAbsent` 遇到已存在 → `FS_NOT_OBSERVED`
- `replaceIfVersion` 版本不符 → `FS_STALE_VERSION`

**③ `editText` 是提供方级的原子操作，不是 read+write 的组合**

匹配、行尾处理、陈旧检查、原子替换全部在**同一个临界区**里完成。
这是「先读再写」永远做不到的正确性——AgentForge 现在让 CLI 自己改文件，等价于把这一步交给不可观测的黑盒。

**④ 变更产物是 diff 基线，不是 diff**

```ts
interface FsWriteOutcome { operation: 'create'|'update'; version; before: string|null; after: string }
```

`before` / `after` 都是 **LF 归一化后的存储文本**。UI 要 diff 时拿这两个字符串自己算，seam 不产生 diff。

**⑤ 四个 `fs/*` 事件，两类语义**

| 事件 | 语义 | 约束 |
|---|---|---|
| `fs/write-intent` / `fs/edit-intent` / `fs/delete-intent` | **单槽决策 waterfall** | 监听方直接 `return` 决策，不调 `next()`；先注册先得 |
| `fs/observed` | 即发即弃的**记录**事件 | 必须同步、只做副作用；抛异常会让工具调用失败 |

**⑥ 观测策略的状态是 `WeakMap<owner, Map<targetKey, FsObservation>>`**

`owner` = `exec.agent.session`（当作不透明 WeakMap key 用）。写入决策把「未见/已缺失」映射到 `createIfAbsent`、把「存在」映射到 `replaceIfVersion`。
**该插件随发行版交付但默认 `disabled: true`**——需要「先读后写」的部署自己打开。这解释了为什么 DSH 默认允许无条件写：它是可选项，不是默认纪律。

### 1.3 设计初稿时 AgentForge 的四个具体缺陷

以下以当时的 `server/orchestrator.mjs` 为准，保留为设计依据；当前实现已由 `server/fs.mjs`、`server/workspace.mjs`、`server/workspace-index.mjs` 和 `server/store.mjs` 取代。

| 位置 | 设计初稿时现状 | 风险 |
|---|---|---|
| `writeWorkspaceFile` L37-51 | `fs.writeFileSync(abs, content, 'utf8')` | **非原子**：进程在写到一半被杀 → 文件截断，且原内容已丢 |
| `listWorkspaceFiles` L68-96 | 全量 `readdirSync` + `statSync`，上限 20000 文件 / 深度 12 | 每次 CLI 调用**前后各扫一遍全仓**（`cliMessage` L223 与 L275），大仓库上是 O(2×N) 同步 IO |
| `cliMessage` L274-288 | 变更识别 = `prev.bytes !== f.bytes || prev.mtimeMs !== f.mtimeMs` | 等长同毫秒改写漏检；CLI 覆盖自己刚写的文件不会产生新 artifact 记录 |
| 全局 | 没有「读后写」概念，没有错误码 | CLI 直接落盘，AgentForge 只能事后发现，无法拒绝 |

另有一处**真实数据损坏隐患**：`store.mjs` 把整个 `db.json` 当单文档写。任务越多越大，写盘窗口越宽。当前已改为 200ms dirty 窗口、按子树记录脏区、原子替换，并在退出前 flush。

### 1.4 落地设计（`server/fs.mjs` 与工作区模块，零依赖）

```js
// 设计示意：原子写与内容版本；读后写守卫位于工作区 / Tool Gateway 链路
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

/** 原子写：同级随机后缀独占创建 → rename。rename 在同一文件系统内是原子交换。 */
export function writeFileAtomic(abs, content, { mode = 0o644 } = {}) {
  const dir = path.dirname(abs);
  fs.mkdirSync(dir, { recursive: true });
  const tmp = path.join(dir, `.${path.basename(abs)}.${process.pid}.${crypto.randomBytes(6).toString('hex')}.tmp`);
  const fd = fs.openSync(tmp, 'wx', mode);   // wx：拒绝跟随预埋的符号链接
  try {
    fs.writeFileSync(fd, content, 'utf8');
    fs.fsyncSync(fd);                        // 内容落盘后再交换，否则 rename 之后仍可能空文件
  } finally {
    fs.closeSync(fd);
  }
  fs.renameSync(tmp, abs);                   // Windows 上目标被占用会 EPERM/EBUSY：有界指数退避重试
  return abs;
}

/** 内容版本：sha256 前 16 位。比 mtimeMs 可靠，等长改写也能发现。 */
export function versionOf(abs) {
  try {
    return crypto.createHash('sha256').update(fs.readFileSync(abs)).digest('hex').slice(0, 16);
  } catch {
    return null;                             // 不存在 = 缺失观测
  }
}
```

守卫层（对应 `fs-observation-policy`）：

```js
// 观测记录挂在任务对象上：DSH WeakMap 的可持久化等价物
const observed = new Map();   // taskId -> Map<relPath, {version, kind:'present'|'absent'}>

export function observe(taskId, relPath, version) { ... }

export function guardedWrite(taskId, relPath, content) {
  const seen = observed.get(taskId)?.get(relPath);
  if (!seen) throw new FsError('FS_NOT_OBSERVED', `cannot modify "${relPath}": file has not been read — read the file, then retry`);
  const current = versionOf(relPath);
  if (seen.kind === 'present' && current !== seen.version) {
    throw new FsError('FS_STALE_VERSION', `"${relPath}" changed since it was read — re-read the file, then retry`);
  }
  ...
}
```

**错误码照抄 DSH 的分类**（消费方按 code 路由，不解析文案）：
`FS_NOT_OBSERVED`、`FS_NOT_FOUND`、`FS_STALE_VERSION`、`FS_ALREADY_EXISTS`、`FS_NOT_DIRECTORY`、`FS_PERMISSION_DENIED`、`FS_SANDBOX_DENIED`、`FS_IO_ERROR`、`FS_NOT_REGULAR_FILE`、`FS_TOO_LARGE`、`FS_PATCH_MISMATCH`、`FS_SAME_TARGET`。
errno 映射：`ENOENT|ENOTDIR → FS_NOT_FOUND`、`EACCES|EPERM → FS_PERMISSION_DENIED`、`EISDIR → FS_NOT_REGULAR_FILE`。

**刻意不做的**：文件 IO **不设 timeoutMs**。本地系统调用最多是「尽力中止」，超时无法中止进行中的 `fsync`/`rename`，设了就是一个自己骗自己的截止时间。取消通过 `AbortSignal` 在系统调用边界传播。

**当时对 AgentForge 的最小改动清单（已落地）**

1. `writeWorkspaceFile` 已接入原子写。
2. 工作区快照已按任务与真实工作区根复用，变更判定使用纳秒 mtime 粗筛加内容版本。
3. artifact 已记录 `version`。
4. `db.json` 已使用临时文件 + 原子替换，并在正常退出 / `SIGINT` / `SIGTERM` 前 flush；当前没有显式 `fsync`，这是已知持久化边界。

**验收判据**（机器可判）

- 在 `writeFileAtomic` 写入中途 `process.kill` 自己 → 目标文件要么旧内容完整、要么新内容完整，**不存在中间态**。
- 等长改写测试：写 `aaaa`，改成 `bbbb`，`versionOf` 必须变化，且 `cliMessage` 能记录到新 artifact。
- `guardedWrite` 未观测 → 抛 `FS_NOT_OBSERVED`；观测后他人改动 → 抛 `FS_STALE_VERSION`。

---

## 2. 读图多模态

### 2.1 设计初稿时的可行性验证

```
POST <provider-base-url>/chat/completions
model: <vision-capable-model>
content: [{type:'text',text:'这张图是什么颜色？只答颜色'},
          {type:'image_url',image_url:{url:'data:image/png;base64,iVBORw0KG...'}}]
→ 200，回答「红色」
```

受控兼容路由接受 data URL 图片输入。这条验证只证明直连兼容网关可以接收图片，不代表每个外部 CLI 都已具备图片输入能力。

### 2.2 DSH 的图片链路（七步）

1. **事件前规范化**：源图在消息被接受前完成校验 + 规范化（8-bit sRGB/sRGBA 光栅）并持久化。任何一张被拒 → **整条消息失败，不发布任何东西**。格式白名单 PNG/JPEG/WebP/GIF（无扩展名按文件签名识别）。
2. **不可变 + 保留策略中立**：对象发布后不可变；恢复/fork 的会话共享对象，所以引用感知 GC 被推迟。
3. **引用而非内联**：`ImageBlock` 只带 `ImageAttachmentRef`。持久会话事件里**不含**浏览器路径、提供方 URL、本地存储路径、base64。
4. **读取时校验**：读回时比对不可变对象的摘要/格式/字节数/尺寸，缺失或损坏明确失败。
5. **按路由投影**：适配器把引用解析成「确定性请求版本」——`variantId = 附件 id + 变换版本 + 目标尺寸 + 字节目标 + 编码参数`。同一张图在不同模型路由上可以是不同尺寸。纯函数 `requestImageDimensions` / `longEdgeDimensions` 按总像素预算或长边算等比尺寸，让路由与计费共用同一套几何。
6. **超预算省略**（`image-offload`）：路由因图片超预算拒绝时返回 `IMAGE_OFFLOAD_REQUIRED` + `offloadImages: n`；执行器按请求顺序遍历表层、跳过 assistant 节点与已标记项，追加 `image/offload {seq, imageIndexes}` 事件，把这些位置**永久**换成占位文本（注明附件与只读路径），然后重试——**不消耗提供方重试预算**。KV 缓存只能复用到第一张被改的图片之前。
7. **通用文件不进 provider**：非图片文件原样保存，模型只收到一行 handle 文本（文件名 + 字节数 + 摘要前缀 + 只读保存路径），需要时用文件工具去读。

### 2.3 设计初稿时的 AgentForge 现状

- 消息体只有 `{agentId, name, role, kind, text}`，`kind` 只用于展示分类。
- `artifacts` 只记 `{path, bytes, mtimeMs, lang}`，没有摘要、没有 MIME。
- 前端没有图片渲染路径（消息正文按 Markdown 渲染文本）。
- 没有「附件」概念，截图只能靠 CLI 自己写到工作区，然后当作普通文件列在「已知文件」里。

当前已实现：`server/attachments.mjs` 负责签名识别、尺寸读取、内容寻址和视觉门禁；消息只持久化附件引用，不内联 base64 或本地绝对路径。前端已有图片上传、缩略图和消息渲染；外部 CLI 的真实图片读取仍要按各自能力验收。

### 2.4 落地设计

**存储**（`data/attachments/<sha256[0:2]>/<sha256>.<ext>`，内容寻址，天然去重）：

```js
// server/attachments.mjs
export function admitImage(buffer, { maxBytes = 8 << 20, maxPixels = 4_000_000, maxDim = 2048 } = {}) {
  const kind = sniffImage(buffer);            // 按签名判 PNG/JPEG/WebP/GIF，不信扩展名
  if (!kind) throw new AttachError('IMAGE_UNSUPPORTED_FORMAT', '只接受 PNG/JPEG/WebP/GIF');
  const meta = readImageSize(buffer, kind);   // 宽高（PNG/JPEG/GIF 头部足够，WebP 读 VP8X）
  if (meta.width * meta.height > maxPixels) throw new AttachError('IMAGE_DIMENSION_TOO_LARGE', ...);
  const sha = sha256(buffer);
  const abs = path.join(ATTACH_ROOT, sha.slice(0, 2), `${sha}.${kind.ext}`);
  if (!fs.existsSync(abs)) writeFileAtomic(abs, buffer);
  return { id: sha.slice(0, 16), sha256: sha, bytes: buffer.length, ...meta, mime: kind.mime };
}
```

**消息形态**（照 `ContentBlock` 的思路，但保持 AgentForge 的扁平风格）：

```js
{ agentId, name, role, kind: 'image', image: { id, sha256, mime, width, height, bytes } }
```

**给成员用的两种投递方式**

| 场景 | 做法 | 理由 |
|---|---|---|
| CLI 真进程 | 在 prompt 里给**只读路径**，让 CLI 自己的 read 工具去读 | 内置 15 个候选里只有部分支持图片输入；路径最通用 |
| 直连兼容网关 | 把 `data:<mime>;base64,...` 放进 `image_url` | 受控网关曾验证可接收；当前产品链路仍需按 Provider 和 CLI 分别验收 |

**能力门禁**（DSH 的 `IMAGE_UNSUPPORTED_MODEL` 等价物）：每个成员记录 `caps.vision`，路由不支持时**拒绝**把图片块投进去，并给出「换支持视觉的模型」的明确指令——不要让文本路由的持久历史里出现图片块。

**超预算处理**：不要像 DSH 那样靠「先失败一次」，AgentForge 可以在投递前用 `bytes` 预算先算，超了就换占位文本：

```text
[图片已省略] id=ab12cd34 1440×900 PNG 412KB
只读路径: <data>/attachments/ab/ab12...png
需要细节时用文件工具读取该路径。
```

**验收判据**

- `admitImage` 对 1×1 PNG / JPEG / WebP / GIF 全部通过；对 `.png` 后缀的文本文件抛 `IMAGE_UNSUPPORTED_FORMAT`。
- 同一张图二次上传不产生第二个文件（内容寻址去重）。
- 端到端：任务里贴一张截图，成员消息中出现 `kind:'image'` 块，模型回答能说出图中内容。自动测试覆盖附件校验和视觉门禁；外部 CLI 的真实视觉端到端仍需逐项验收。
- 不支持视觉的成员收到图片时抛 `IMAGE_UNSUPPORTED_MODEL`，且消息不落库。

---

## 3. 上下文结构（性价比最高的一块）

### 3.1 DSH 的四层结构

**① 仅追加日志 → 表层投影 → 派生消息**

原则一句话：**模型可见即已记录**。每个模型请求都能从日志重建；`deriveMessages()` 从日志投影模型历史；每个 `assistant/message` 内嵌产生它的紧凑 stream。新增任何「模型能看见的输入」都必须落成 `SessionEvent`。

**② 系统提示词 = 分段注册表，且提示词本身是「表层第 0 号节点」**

```ts
interface PromptSection { name; order; text: string | (ctx) => string; interpolate?; complete? }
interface PromptContext { name; order; text: string | (ctx) => string; interpolate?; required? }
```

- 段按 `order` 升序，同 order 按名称 code-unit 序。
- `complete: true` 的段会成为唯一提示词段（>1 个有效 complete 直接组装失败）。
- 提示词不是请求字段，而是**以 `system/message` 形式提交的 surface 节点**：首步追加为第 0 号，之后文本变化时原地替换，或按 `systemPromptUpdate: 'in-history'` 追加。
- `PromptContext` 是「动态上下文」：作为 **durable user-role 快照**记录在保留历史之后，**只在快照变化或被 compaction 移除时才写**。这是「易变信息不污染前缀」的关键机制。

**③ 三层减法，按代价从低到高**

| 层 | 机制 | 是否调模型 | 触发 |
|---|---|---|---|
| 1 | `tool-result-pruner`：head/middle/tail 保留，按 **Unicode code point** 切（不切代理对） | 否 | 压缩条件满足后先跑；剪完够用就**跳过摘要调用** |
| 2 | `image-offload`：老图片换占位文本 | 否 | 路由报图片超预算 |
| 3 | `compaction-basic`：把最旧的平衡区间替换成一条摘要消息 | 是 | 压力超阈值 |

`pruneSession` 每替换一个节点，**紧邻其前**插一条 `compaction/prune` 影子价事件给被遮蔽节点定价，这样纯投影 fold 能 O(1) 相减，不需要每节点状态。

**④ 压缩是一个日志事务，不是一次写操作**

`compaction/start` → 生成摘要 → `compaction/summary` + 替换 → `compaction/end`。
锁括住整个操作，**最后释放**，所以中途崩溃表现为「可检测的遗留锁」（有 start 无 end），而不是假的「已完成」。

- 三个事件**只写日志、不进 surface**；真正的 surface 变更是另一条 `user/message` 带 `surfaceOp: { op:'replace', startSeq, endSeq }`。
- `shadowedRange` 是**位置跨度**不是数值区间：之前有过 replace 的话 `start` 可能大于 `end`。权威集合是 `shadowedSeqs`（按表层顺序）。
- 区域边界必须保持工具调用/结果配对（`toolPairingBalancedBefore/After`），但不保持整个轮次——所以超大轮次里较早关闭的步骤也能被压。

默认参数（`dsh-compaction-basic`，记下来当参考值）：

```
触发阈值 = floor(min(W × 0.8, W − O − 65536))     W=窗口, O=输出上限
逐字保留近期 = (W − O) × 0.16
摘要输出上限 = headroomTokens = 65536
compactionRetries = 1, maxOverflowRetries = 1
```

**⑤ 摘要调用复用热前缀**

摘要请求逐字回放「surface 0 号节点的 system/message + 上次已路由请求的工具声明 + 被遮蔽区域消息」，让辅助调用成为会话的**真前缀**，只有尾部指令与摘要输出未缓存。

**⑥ 计量：usage 锚点 + 增量估算**

```ts
interface TokenMeasurement {
  logRevision;            // 消费到第几条持久事件
  baseline: {kind:'usage'|'estimated'};
  surfaceDeltaTokens;     // 相对锚点的有符号重定价
  totalTokens;            // 请求+响应压力
  surfaceTokens;          // 表层路由定价总和 = 各节点价之和
  nodes: {seq, tokens, heuristicTokens}[];
}
```

`baseline.kind === 'usage'` 表示最近一次成功调用有相同的规范请求 envelope；否则退化为 `estimated`。
`contextPressure()` 只给 UI 看（`pressureTokens` / `projectedTokens` / `contextWindow`），**不参与门控**。

**⑦ spill：大输出落盘，给不透明定位符**

```ts
saveText({ owner:{sessionId}, source:{kind:'tool',toolName,callId,label}, suggestedName, content }) → { locator, bytes, retrievalHint }
```

`suggestedName` 是**命名提示不是路径**（后端会清洗成单个安全段）；`locator` 是品牌化不透明句柄，消费方**只能拿 `retrievalHint` 渲染，不许解析**。

### 3.2 设计初稿时 AgentForge 的三个硬伤（均已修复）

**硬伤 A：易变块曾排在最前，每一步都打掉前缀缓存**

`buildPrompt`（`orchestrator.mjs:319-364`）的第一行就是 `buildContextBlock(context, step?.title || '')`，而 `buildContextBlock`（L126-152）里有 `- 状态: ${context.status}`、`- 当前工序: ${step}`、工序账本、最近协作摘要、文件清单——**每步都在变**。

当时的后果是每个成员的每次调用，prompt 的第一个 token 都和上一次不同，提供方的前缀缓存命中率趋近 0。当前已拆出 `stableBlock()` / `volatileBlock()`，稳定段在前、易变段在后；以下保留原判断作为设计依据。

同样的账本信息，位置挪一下，成本立刻掉一截。

**硬伤 B：token 估算曾是错的量级**

`store.endMessage({ tokens: Math.ceil((res.stdout || '').length / 3) })`、`store.mjs:487` 的 `Math.ceil(delta.length / 2)`。
中文按 1 字 ≈ 1 token 量级，旧 `/3` 会把中文低估约 3 倍，两处系数还不一致（3 vs 2）。当前统一使用 `server/tokens.mjs` 的 CJK / ASCII / 其他字符估算。

**硬伤 C：依赖产物曾被 `clip` 掉中间，且不可恢复**

`clip(text, 6000)` = 头 75% + 尾 20%，中间写一句「…（中间省略 N 字）…」。
当时下游成员拿不到被裁掉的中间内容，也没有句柄能取回原文。当前已把超长内容写入 `data/spill/`，prompt 保留只读定位符和摘录。

### 3.3 落地设计（三步走，都不改协议；均已实现）

**第 1 步：重排 prompt 段序（30 分钟，立刻见效）**

把 `buildPrompt` 的数组顺序改成：

```
1. 人格与纪律        （成员身份、职责边界、输出格式）  ← 稳定
2. 项目目标          （task.goal，整任务不变）        ← 稳定
3. 全局规则          （中文、Markdown、只改职责内文件）← 稳定
4. ─────────────── 以下为易变区 ───────────────
5. 当前工序
6. 工序账本
7. 依赖产物
8. 最近协作摘要
9. 已知文件清单
```

判据：同一任务连续两步的 prompt，**最长公共前缀 ≥ 稳定区长度**（写个 20 行脚本断言即可）。
当时的改造点是把「一个函数吐一整块」拆成 `stableBlock()` / `volatileBlock()` 两个导出，同时保持 `index.mjs` 的 `/api/state` 中 `context` 兼容。该拆分已落地。

**第 2 步：token 计量换成可校准的估算 + usage 回填**

```js
// server/tokens.mjs
// 中文按 1.0 token/字，ASCII 按 1/3.6 token/字，其余按 1/2 —— 比单一系数好一个量级
export function estimateTokens(text) {
  const s = String(text || '');
  let cjk = 0, ascii = 0, other = 0;
  for (const ch of s) {
    const code = ch.codePointAt(0);
    if (code < 0x80) ascii++;
    else if ((code >= 0x4e00 && code <= 0x9fff) || (code >= 0x3040 && code <= 0x30ff)) cjk++;
    else other++;
  }
  return Math.ceil(cjk * 1.0 + ascii / 3.6 + other / 2);
}
```

有 provider usage 时（CLI 多数不报，直连 API 会报）以 usage 为锚，估算只算增量——这就是 DSH 的 `baseline: usage` / `surfaceDeltaTokens` 结构，抄它的形状就够。

**第 3 步：`clip` → spill + 句柄**

```js
// 依赖产物超过阈值时：原文落盘，prompt 里只放句柄
if (text.length > SPILL_AT) {          // 建议 8000 字
  const ref = spillText(task, { source: { kind: 'step', stepId, agentId }, content: text });
  return [
    `## ${label} · ${name}`,
    `工序：${title}`,
    '',
    `（产物 ${text.length} 字，已存为文件，需要细节时读取）`,
    `只读路径: ${ref.locator}`,
    '',
    clip(text, 1200),                  // 仍给头尾一小段，保证不读也能抓住主旨
  ].join('\n');
}
```

`data/spill/<taskId>/<stepId>-<hash>.md`，`retrievalHint` 直接写「用 read 工具读该路径」。

**第 4 步（可选，工作量最大）：压缩**

AgentForge 当时只在 `buildContextPack` 做粗暴裁剪：取最后 8 条消息、每条压空白后 300 字，而且不写压缩记录。当前已由 `server/context-budget.mjs` 提供预算、自动触发、来源范围、质量评估、历史与原文回放。

当时规划的最小压缩方案是：

```
触发：estimateTokens(prompt) > 预算 × 0.8
保留：最近 N 步的完整产物（逐字），更早的用抽取式摘要压缩
落库：task.contextState.compactions.push({ ...sourceMessageIds, sourceRange, quality })
替换：buildContextPack 读压缩记录，把被遮蔽区间替换成摘要段
```

`shadowedRange` 用「消息 id 区间」而不是数值区间，并且**记录被遮蔽的 id 列表**（对应 DSH 的 `shadowedSeqs` 是权威集合这一点）。

**验收判据**

- 段序：`stablePrefixLen(prompt_i, prompt_{i+1}) >= stableLen` 的断言脚本通过。
- 计量：`estimateTokens('这是一段中文')` 与真实分词差 < 25%（拿 claude/gemini 的 usage 回填校准一次）。
- spill：>8000 字的依赖产物在 prompt 里只出现句柄 + 1200 字摘录，原文件在 `data/spill/` 存在且 `bytes` 匹配。
- 压缩（若做）：`node --test tests/` 全绿 + 压缩后 `estimateTokens` 下降 ≥ 40% 且最近 3 步产物逐字保留。

---

## 4. 成本与缓存（单独拎出来说）

DSH 在每个「模型体验」小节都固定写一段 **KV Cache 影响**，这个习惯值得抄进 AgentForge 的每个改动说明里。三条规则：

1. **只追加的内容不动缓存**：新增可见内容位于可复用前缀之后 → 不失效。
2. **替换/改写会从第一个改动点起失效**：`image/offload` 换掉一张老图，缓存复用就止于那张图。
3. **可见工具集合、插件作用域、指导文本不变时前缀稳定**：一旦变（比如给某成员临时加了工具），从首个变化的 schema token 起失效。

AgentForge 的对应动作：

- 成员的工具/能力描述**不要每步拼进去**——放稳定区，或干脆不进 prompt（CLI 自己有工具）。
- 账本/文件清单放尾部。
- 图片投递会失效后缀，所以**同一张图别在多个步骤重复投递**；要么用路径（CLI 自己读），要么只在该步投一次。

---

## 5. 历史实施顺序与工作量

| 顺序 | 事项 | 文件 | 预估 | 风险 |
|---|---|---|---|---|
| 1 | prompt 段序重排（稳定区/易变区拆分） | `server/orchestrator.mjs` | 0.5h | 低（纯顺序） |
| 2 | `estimateTokens` 替换 `/3` `/2` 两处 | 新增 `server/tokens.mjs` + 2 处调用 | 0.5h | 低 |
| 3 | `writeFileAtomic` + `versionOf`，`writeWorkspaceFile` 与 `db.json` 接入 | 新增 `server/fs.mjs` + 2 处调用 | 1h | 低 |
| 4 | artifact 增 `version`，变更判定用版本 | `orchestrator.mjs` `cliMessage` | 1h | 中（需回归产物收集） |
| 5 | 依赖产物 spill + 句柄 | `orchestrator.mjs` `dependencyText` | 1h | 低 |
| 6 | 附件存储 + `admitImage` + 消息 `kind:'image'` | 新增 `server/attachments.mjs` + `store.mjs` + 前端 | 3h | 中（新能力，需 UI 配合） |
| 7 | 读后写守卫（`FS_NOT_OBSERVED` / `FS_STALE_VERSION`） | 新增 `server/fs-observe.mjs` | 1.5h | 中（会开始拒绝以前能通过的写） |
| 8 | 上下文压缩（compaction 记录 + 抽取式摘要替换） | `context-budget.mjs` + `store.mjs` | 4h+ | 高（影响模型可见历史） |

**建议先做 1→2→3→5**：四件事合计 3 小时，全部是「不改行为、只改成本与可靠性」，跑一遍 `node --test tests/` 就能验收。
**6/7/8 属于能力扩展**，各自独立，做不做都不影响前四件。

---

## 6. 明确不做与保留边界

- **不做 `ctx.fs` 那种服务 seam**：AgentForge 是单进程零依赖，一个模块 + 函数就够，抽象层是投机。
- **不做内核级沙箱代理**：成员仍是外部 CLI；平台在 `strict` 模式下映射各 CLI 的原生沙箱，无法强制的组合直接拒绝。网络代理、文件租约与系统调用拦截属于后续独立能力，不在文件上下文模块里硬塞。
- **不做图片规范化（重编码）**：本机没有零依赖的图片编码器。只做**校验 + 尺寸读取 + 原样存储**，超限直接拒。DSH 的 8-bit sRGB 规范化依赖它的原生管线，抄不来。
- **暂不做附件 GC**：内容寻址 + 不删，和 DSH 一样推迟。真需要时按 `data/attachments` 的引用计数另开一轮。
- **不改 `db.json` 的整体形状**：加字段可以，拆库是另一个话题；当前采用 200ms dirty 窗口、按子树序列化和原子替换，退出前 flush。

---

## 7. 历史实施快照（2026-11-25 已落地 1→2→3→5）

| 项 | 落点 | 验收结果 |
|---|---|---|
| prompt 段序重排 | `server/orchestrator.mjs` 新增 `stableBlock()` / `volatileBlock()`，`buildPrompt` / `buildPlanPrompt` / `buildSummaryPrompt` / `buildProposalPrompt` 全部改为「稳定区在前、易变区在尾」 | `tests/context-budget.test.mjs`：连续两步 prompt 的最长公共前缀 ≥ 稳定区长度，且 prompt 不以易变区开头 |
| token 估算 | 新增 `server/tokens.mjs`（CJK 1.0 / ASCII 1/3.6 / 其他 1/2）；`cliMessage` 与 `store.appendMessage` 都改用它，消灭 `/3` 与 `/2` 两套不一致系数 | 20 个汉字估到 20 token（旧算法 7），误差测试断言 16–26 区间 |
| 原子写 + 内容版本 | 新增 `server/fs.mjs` 的 `writeFileAtomic()`（同级临时文件 + `fsync` + `rename`，Windows 占用退避重试）与 `versionOf()`（sha256 前 16 位）；`writeWorkspaceFile` 与 artifact 记录接入 `version` | 测试断言：写入后无 `.tmp` 残留、等长改写产生新版本、缺失文件返回 null |
| 变更识别 | `listWorkspaceFiles` 改用 `statSync(..., { bigint: true })` 取纳秒 `mtimeNs`；`cliMessage` 先按 size+mtimeNs 粗筛，命中项再算内容版本 | 端到端实跑产物记录带 `v=xxxxxxxx` 版本号 |
| 上游产物 spill | `dependencyBody()`：>8000 字的产物落盘到 `data/spill/<taskId>/`，prompt 里只放「只读路径 + 摘录」；后续已推广到事件、消息、工具输出和导出 | 测试断言原文可完整取回、同内容不产生第二个文件 |

端到端实跑（任务 `a90f8253-31f5-46cc-97d1-aefd5dc447c4`，direct 模式）：plan / design / implement / test-design / review 全过，`VERDICT: PASS`，status=done，产出 requirements.md / architecture.md / notes.md / README.md，token 累计 3010（旧算法会算成约 1000）。

> 历史快照：这是 2026-11-25 的落地记录，任务编号、耗时和 token 数字只用于当时复盘，不是当前验收指标。

## 实施结果

| 原设计项 | 当前状态 | 落地内容与验证 |
| --- | --- | --- |
| 文件原子写与版本 | 已完成 | `server/fs.mjs` 提供原子写、内容版本和 spill；工作区变更与事务记录已接入 |
| 读后写守卫 | 已完成 | 写入已有文件需提交最近读取版本；陈旧写入返回冲突并留审计，覆盖人工与 Agent 通道 |
| 附件与读图 | 基础能力已完成 | 按签名识别 PNG / JPEG / WebP / GIF，校验体积、尺寸和像素；内容寻址保存；Provider 必须声明 `vision`，否则拒绝且不落消息。前端已支持上传与渲染；外部 CLI 的真实视觉端到端、图片重编码和附件 GC 仍未完成 |
| 上下文压缩 | 已完成 | 稳定前缀、预算、自动触发、来源范围、质量评估、历史与原文回放均已落地；摘要仍为抽取式 |

验证入口：`npm test` 与 `npm run check:syntax`。对应测试包括 `tests/workspace.test.mjs`、`tests/attachments.test.mjs` 与 `tests/context-budget.test.mjs`。具体数量随用例增减，不在文档中固定。
