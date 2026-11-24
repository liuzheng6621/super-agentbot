/**
 * 内置「模拟智能体」内容引擎。
 * 不依赖任何外部模型 / API Key，保证平台离线可跑通完整协作链路。
 * 接入真实 CLI 后，本文件只在 sim 模式下使用。
 */

const MODULE_HINTS = [
  [/(登录|认证|鉴权|auth|login|注册)/i, 'auth', '认证与会话'],
  [/(支付|订单|pay|order|结算|退款)/i, 'payment', '支付与订单'],
  [/(聊天|消息|对话|chat|message|im\b|客服)/i, 'chat', '实时消息'],
  [/(搜索|检索|search|query|筛选)/i, 'search', '搜索检索'],
  [/(图表|可视|看板|chart|dashboard|报表|数据大屏)/i, 'chart', '数据可视化'],
  [/(上传|文件|附件|upload|file|网盘)/i, 'upload', '文件上传'],
  [/(待办|任务|todo|清单|kanban|看板)/i, 'todo', '任务清单'],
  [/(用户|账号|profile|会员|后台|admin)/i, 'account', '用户与权限'],
  [/(爬虫|采集|抓取|crawler|scrape)/i, 'crawler', '数据采集'],
  [/(api|接口|服务端|后端|server|微服务)/i, 'service', '服务端接口'],
];

export function pickModule(goal) {
  for (const [re, name, label] of MODULE_HINTS) {
    if (re.test(goal)) return { name, label };
  }
  return { name: 'feature', label: '核心功能' };
}

export function planFor(goal) {
  const mod = pickModule(goal);
  return [
    { title: `需求拆解与验收标准：${goal.slice(0, 40)}`, role: 'planner' },
    { title: `${mod.label}技术方案与接口契约`, role: 'architect' },
    { title: `实现 ${mod.name} 模块主链路`, role: 'coder' },
    { title: `测试用例设计与边界覆盖`, role: 'tester' },
    { title: `代码评审与质量门`, role: 'reviewer' },
  ];
}

const wrap = (s) => s.trim() + '\n';

/* ------------------------------------------------------------------ */
/* 各角色的产出                                                        */
/* ------------------------------------------------------------------ */

function plannerText({ goal, mod }) {
  return wrap(`
我已收到这个目标，先把它拆成可并行/可串行执行的工序，再分派给合适的成员。

> **目标**：${goal}

### 一、需求澄清（我的假设）
1. **交付形态**：可运行的 ${mod.label} 最小闭环，而不是一次性做全量特性。
2. **优先级**：主链路可用 > 边界完备 > 性能优化。
3. **验收口径**：能跑通一条端到端用例，核心分支有自动化测试，关键函数有注释。

### 二、工序拆解

| # | 工序 | 负责 | 交付物 | 阻塞关系 |
|---|------|------|--------|----------|
| 1 | 技术方案与接口契约 | Forge | \`docs/${mod.name}-design.md\` | 无 |
| 2 | 主链路实现 | Kilo | \`src/${mod.name}.js\` | 依赖 1 |
| 3 | 测试覆盖 | Probe | \`tests/${mod.name}.test.js\` | 依赖 2 |
| 4 | 评审与质量门 | Lens | 评审结论 | 依赖 2 / 3 |

### 三、风险预判
- **接口漂移**：方案阶段先把契约写死，实现阶段不允许私自改字段名。
- **边界缺失**：空值、超长输入、并发重复提交这三类必须先覆盖。
- **过度设计**：本轮不引入数据库与鉴权体系，用内存态 + 可替换 repository 兜住。

### 四、我的编排决策
先让 **Forge** 出方案 → **Kilo** 并行开工 → **Probe** 跟测 → **Lens** 卡门。
任何一步失败，我会重新拆解并回收上下文，不需要你重新描述需求。

现在开始分派。
`);
}

function architectText({ goal, mod }) {
  return wrap(`
方案定稿，先把**契约**写死，后面实现按契约走，避免来回改。

### 一、模块边界
\`\`\`
${mod.name}/
├─ domain/     业务规则（纯函数，无副作用，可单测）
├─ transport/  对外接口（参数校验 + 错误映射）
└─ store/      数据访问（内存实现，接口可替换）
\`\`\`

### 二、接口契约
\`\`\`ts
// createXxx：入参 → 校验 → 返回实体
interface CreateInput { title: string; tags?: string[]; }
interface Entity { id: string; title: string; tags: string[]; createdAt: number; status: 'open' | 'closed'; }

interface ${mod.name.charAt(0).toUpperCase() + mod.name.slice(1)}Service {
  create(input: CreateInput): Promise<Entity>;
  list(query?: { status?: Entity['status']; keyword?: string }): Promise<Entity[]>;
  close(id: string): Promise<Entity>;
}
\`\`\`

### 三、关键决策（含被否掉的方案）
| 决策点 | 选择 | 否掉的原因 |
|--------|------|-----------|
| 状态管理 | 不可变更新 | 可变对象在并发下难追踪 |
| 校验位置 | transport 层前置 | 下沉到 domain 会出现重复校验 |
| 错误形态 | 领域错误码 + 中文提示 | 直接抛字符串无法被调用方区分 |

### 四、目标：${goal.slice(0, 60)}
实现时请严格对齐上面的接口。**Kilo 可以从第 2 步直接取用契约。**

交付：\`docs/${mod.name}-design.md\`
`);
}

function coderText({ goal, mod }) {
  return wrap(`
按契约实现，先跑通主链路，同时把边界挡在入口。

逐条对齐 Forge 的接口：\`create / list / close\` 三个方法全部落地，错误统一走 \`AppError\`。

**已完成的取舍**
- 列表查询用 **游标** 而不是 offset，避免数据增长后翻页抖动。
- \`close\` 做了幂等，重复关闭不报错只返回当前态。
- 标题超过 120 字符直接拒绝，不做静默截断（避免调用方以为存进去了）。

主链路自测通过，已交给 Probe 跟测。
`);
}

function testerText({ goal, mod }) {
  return wrap(`
拿到实现，先从「哪里最容易炸」入手，再补正常路径。

### 用例矩阵
| 编号 | 场景 | 输入 | 期望 |
|------|------|------|------|
| T1 | 正常创建 | \`{title:"写周报"}\` | 返回实体，status=open |
| T2 | 空标题 | \`{title:"  "}\` | 抛 \`E_TITLE_REQUIRED\` |
| T3 | 超长标题 | 121 字符 | 抛 \`E_TITLE_TOO_LONG\` |
| T4 | 关闭幂等 | 连续 \`close\` 两次 | 两次成功，状态一致 |
| T5 | 关键词筛选 | \`keyword:"周"\` | 只返回匹配项 |

### 发现的问题
1. **[P1]** \`list({keyword})\` 对大小写敏感，中文没问题但英文标签搜不到 → 建议 \`toLowerCase\` 归一。
2. **[P2]** \`tags\` 未去重，\`["a","a"]\` 会原样存进去。
3. **[P3]** 空数组返回 \`null\` 而不是 \`[]\`，调用方要额外判空。

除 P1 外都不阻塞上线。P1 已回抛给 Kilo 修。
`);
}

function reviewerText({ goal, mod }) {
  return wrap(`
评审完成。整体结构是干净的，但有几个点必须在上线前改掉。

### 结论：**有条件通过**

### 必须改（Blocker）
- **B1｜并发写**：\`store\` 里 \`read-modify-write\` 没有串行化，两个并发 \`create\` 可能拿到同一个自增序号。→ 加一个 promise 队列锁。
- **B2｜错误信息泄漏**：\`transport\` 直接把 \`err.stack\` 返回给调用方，生产环境会漏内部路径。→ 只回错误码 + 中文文案。

### 建议改（Should）
- **S1**：\`domain\` 里有个 47 行的 \`create\`，能拆出 \`validate\` 与 \`normalize\` 两段，可读性会好很多。
- **S2**：魔法数字 \`120\` 提为常量 \`MAX_TITLE_LEN\`。
- **S3**：\`list\` 的过滤逻辑抽成纯函数，才有办法单测。

### 做得好
- 错误码体系完整，调用方可以精准分支。
- 幂等设计到位，重试是安全的。

Kilo 改完 B1、B2 后我再复评一次，预计一轮就能过。
`);
}

function summaryText({ goal, mod, outputs }) {
  const done = ['方案文档', `${mod.name} 模块实现`, '自动化测试', '评审结论'];
  return wrap(`
## 交付完成

**目标**：${goal}

本轮 ${done.length} 项工序全部走完，协作链路没有回退重跑。

### 产物
${done.map((d, i) => `${i + 1}. ${d}`).join('\n')}

### 需要你决策的 3 件事
1. **B1 并发锁**：现在用的是进程内队列，多实例部署时要换成 Redis 锁 —— 要不要本轮就做？
2. **错误码是否对外**：目前是内部码 + 中文文案，如果要做开放平台，建议补一份错误码文档。
3. **下一轮方向**：我建议优先补「持久化」，把内存 store 换成真实库，其余特性都建立在它之上。

需要我继续往下推哪一条？直接说，或者 @ 某位成员单独拉他进来。
`);
}

function chatReply({ role, goal, text }) {
  const map = {
    planner: `收到。就「${text.slice(0, 40)}」这件事，我的判断是：先别急着写代码，把它拆成 2~3 个可验收的小步骤更稳。\n\n如果你希望我直接排期，回复「继续」我就把工序排出来。`,
    architect: `从架构角度看，「${text.slice(0, 40)}」的关键不在实现量，而在**边界在哪**。\n\n建议先把输入/输出的契约钉死，再谈性能。要我出一版接口草案吗？`,
    coder: `可以，这个我直接写。\n\n给我两个信息就够了：字段有哪些、失败时希望怎么返回。其余我按现有风格补齐。`,
    tester: `我先把边界列出来给你：空值、超长、并发重复、非法枚举。\n\n这四类在「${text.slice(0, 30)}」里最容易出事，建议至少覆盖前三个。`,
    reviewer: `评审视角提醒一句：「${text.slice(0, 40)}」里最容易埋雷的是**错误处理**。\n\n先问自己：失败时调用方能不能区分是参数错还是系统错？不能的话先补错误码。`,
  };
  const base = map[role] || `收到，我来跟进「${text.slice(0, 40)}」。`;
  return wrap(`${base}\n\n---\n*当前运行在模拟模式，接入真实 CLI 后这里会返回模型的实际回答。目标上下文：${goal.slice(0, 50)}*`);
}

/* ------------------------------------------------------------------ */
/* 代码产物                                                            */
/* ------------------------------------------------------------------ */

function codeArtifact({ mod, goal }) {
  const Cap = mod.name.charAt(0).toUpperCase() + mod.name.slice(1);
  const content = `/**
 * ${mod.label} —— 核心领域模块
 * 目标：${goal.replace(/\*\//g, '* /')}
 * 契约见 docs/${mod.name}-design.md
 */

export const MAX_TITLE_LEN = 120;

export const ErrorCode = {
  TITLE_REQUIRED: 'E_TITLE_REQUIRED',
  TITLE_TOO_LONG: 'E_TITLE_TOO_LONG',
  NOT_FOUND: 'E_NOT_FOUND',
};

export class AppError extends Error {
  constructor(code, message, status = 400) {
    super(message);
    this.name = 'AppError';
    this.code = code;
    this.status = status;
  }
}

/** 串行化写操作，避免并发 read-modify-write 丢更新 */
function createLock() {
  let tail = Promise.resolve();
  return (fn) => {
    const run = tail.then(fn, fn);
    tail = run.catch(() => {});
    return run;
  };
}

const normalizeTitle = (raw) => String(raw ?? '').trim();

function validateTitle(raw) {
  const title = normalizeTitle(raw);
  if (!title) throw new AppError(ErrorCode.TITLE_REQUIRED, '标题不能为空');
  if (title.length > MAX_TITLE_LEN) {
    throw new AppError(ErrorCode.TITLE_TOO_LONG, \`标题不能超过 \${MAX_TITLE_LEN} 个字符\`);
  }
  return title;
}

const normalizeTags = (tags) =>
  Array.isArray(tags)
    ? [...new Set(tags.map((t) => String(t).trim().toLowerCase()).filter(Boolean))]
    : [];

export function create${Cap}Service({ repository, clock = Date.now, idgen = () => crypto.randomUUID() }) {
  const withLock = createLock();

  return {
    /** 创建实体 */
    async create(input = {}) {
      const title = validateTitle(input.title);
      const tags = normalizeTags(input.tags);
      return withLock(async () => {
        const entity = {
          id: idgen(),
          title,
          tags,
          status: 'open',
          createdAt: clock(),
        };
        await repository.insert(entity);
        return entity;
      });
    },

    /** 列表查询，keyword 大小写不敏感 */
    async list(query = {}) {
      const keyword = String(query.keyword ?? '').trim().toLowerCase();
      const rows = await repository.all();
      return rows.filter((row) => {
        if (query.status && row.status !== query.status) return false;
        if (!keyword) return true;
        return (
          row.title.toLowerCase().includes(keyword) ||
          row.tags.some((tag) => tag.includes(keyword))
        );
      });
    },

    /** 关闭，幂等 */
    async close(id) {
      return withLock(async () => {
        const row = await repository.find(id);
        if (!row) throw new AppError(ErrorCode.NOT_FOUND, '记录不存在', 404);
        if (row.status === 'closed') return row;
        const next = { ...row, status: 'closed', closedAt: clock() };
        await repository.update(next);
        return next;
      });
    },
  };
}

/** 内存仓储，可替换为任意数据库实现 */
export function createMemoryRepository() {
  const rows = new Map();
  return {
    async insert(entity) {
      rows.set(entity.id, entity);
    },
    async all() {
      return [...rows.values()];
    },
    async find(id) {
      return rows.get(id) ?? null;
    },
    async update(entity) {
      rows.set(entity.id, entity);
    },
  };
}
`;
  const test = `import { create${Cap}Service, createMemoryRepository, ErrorCode } from '../src/${mod.name}.js';

const service = () => create${Cap}Service({ repository: createMemoryRepository() });
const assert = (cond, msg) => {
  if (!cond) throw new Error('断言失败: ' + msg);
};

const cases = [];
const test = (name, fn) => cases.push({ name, fn });

test('正常创建返回 open 状态', async () => {
  const s = service();
  const entity = await s.create({ title: '写周报' });
  assert(entity.id, '应有 id');
  assert(entity.status === 'open', 'status 应为 open');
});

test('空标题抛 E_TITLE_REQUIRED', async () => {
  const s = service();
  await s.create({ title: '   ' }).then(
    () => { throw new Error('不该成功'); },
    (err) => assert(err.code === ErrorCode.TITLE_REQUIRED, '错误码应为 TITLE_REQUIRED'),
  );
});

test('超长标题抛 E_TITLE_TOO_LONG', async () => {
  const s = service();
  await s.create({ title: 'x'.repeat(121) }).then(
    () => { throw new Error('不该成功'); },
    (err) => assert(err.code === ErrorCode.TITLE_TOO_LONG, '错误码应为 TITLE_TOO_LONG'),
  );
});

test('关闭幂等', async () => {
  const s = service();
  const e = await s.create({ title: 'A' });
  const a = await s.close(e.id);
  const b = await s.close(e.id);
  assert(a.status === 'closed' && b.status === 'closed', '两次关闭状态应一致');
});

test('并发创建不丢更新', async () => {
  const s = service();
  await Promise.all(Array.from({ length: 20 }, (_, i) => s.create({ title: 'T' + i })));
  const rows = await s.list();
  assert(rows.length === 20, '应有 20 条记录，实际 ' + rows.length);
});

let passed = 0;
for (const c of cases) {
  try {
    await c.fn();
    passed++;
    console.log('  ✓ ' + c.name);
  } catch (err) {
    console.log('  ✗ ' + c.name + ' -> ' + err.message);
  }
}
console.log(\`\\n\${passed}/\${cases.length} 通过\`);
if (passed !== cases.length) process.exitCode = 1;
`;
  return { main: content, test };
}

/* ------------------------------------------------------------------ */
/* 对外接口                                                            */
/* ------------------------------------------------------------------ */

export function compose({ kind, goal, agent, outputs = {} }) {
  const mod = pickModule(goal);
  const ctx = { goal, mod, outputs };

  switch (kind) {
    case 'plan':
      return { text: plannerText(ctx), artifacts: [] };
    case 'architect':
      return { text: architectText(ctx), artifacts: [] };
    case 'coder': {
      const code = codeArtifact(ctx);
      return {
        text: coderText(ctx),
        artifacts: [
          { path: `src/${mod.name}.js`, content: code.main, lang: 'js' },
        ],
      };
    }
    case 'tester': {
      const code = codeArtifact(ctx);
      return {
        text: testerText(ctx),
        artifacts: [{ path: `tests/${mod.name}.test.js`, content: code.test, lang: 'js' }],
      };
    }
    case 'reviewer':
      return { text: reviewerText(ctx), artifacts: [] };
    case 'summary':
      return { text: summaryText(ctx), artifacts: [] };
    case 'chat':
      return { text: chatReply({ role: agent?.role, goal, text: outputs.userText || '' }), artifacts: [] };
    default:
      return { text: `收到：${goal}`, artifacts: [] };
  }
}

export function designDoc({ goal }) {
  const mod = pickModule(goal);
  return `# ${mod.label} · 技术方案\n\n> 目标：${goal}\n> 作者：Forge（架构师）\n\n## 1. 模块边界\n\n\`\`\`\n${mod.name}/\n├─ domain/     业务规则（纯函数，无副作用）\n├─ transport/  对外接口（参数校验 + 错误映射）\n└─ store/      数据访问（内存实现，可替换）\n\`\`\`\n\n## 2. 接口契约\n\n| 方法 | 入参 | 出参 | 异常 |\n|------|------|------|------|\n| create | { title, tags? } | Entity | E_TITLE_REQUIRED / E_TITLE_TOO_LONG |\n| list | { status?, keyword? } | Entity[] | - |\n| close | id | Entity | E_NOT_FOUND |\n\n## 3. 关键决策\n\n1. **状态不可变**：所有更新返回新对象，便于回溯与并发安全。\n2. **校验前置**：放在 transport 层，domain 只接收已校验数据。\n3. **错误码化**：领域错误用稳定 code，展示文案与 code 分离。\n4. **写操作串行化**：进程内 promise 队列，避免 read-modify-write 丢更新。\n\n## 4. 已知限制\n\n- 数据存内存，进程重启即丢；下一轮换持久化。\n- 单实例锁，多实例需换分布式锁。\n`;
}

export function thinkingFor(kind, goal) {
  const map = {
    plan: `读取目标 → 识别动词与交付物 → 拆解工序 → 检查依赖与风险`,
    architect: `比对 ${pickModule(goal).label} 的常见实现 → 挑最简可行的一组 → 写死契约`,
    coder: `对齐契约 → 先写主链路 → 再补边界 → 自查`,
    tester: `列边界 → 按爆炸半径排优先级 → 补正常路径`,
    reviewer: `看并发 → 看错误处理 → 看可测性 → 看命名`,
    summary: `汇总产物 → 挑出需要人拍板的分歧点`,
  };
  return map[kind] || `处理中…`;
}
