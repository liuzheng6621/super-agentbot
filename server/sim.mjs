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
  // 裸「文件」会把「确认文件存在」「读文件」也算成上传需求，只保留明确的传输语义
  [/(上传|附件|网盘|download|upload|file\s*upload)/i, 'upload', '文件上传'],
  [/(待办|任务清单|todo|kanban|看板)/i, 'todo', '任务清单'],
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
    {
      id: 'plan',
      title: `需求拆解与验收标准：${goal.slice(0, 40)}`,
      role: 'planner',
      needs: [],
      outputPaths: [],
    },
    {
      id: 'design',
      title: `${mod.label}技术方案与接口契约`,
      role: 'architect',
      needs: ['plan'],
      outputPaths: [`docs/${mod.name}-design.md`],
    },
    {
      id: 'implement',
      title: `实现 ${mod.name} 模块主链路`,
      role: 'coder',
      needs: ['design'],
      outputPaths: [`src/${mod.name}.js`],
    },
    {
      id: 'test-design',
      title: '测试用例设计与边界覆盖',
      role: 'tester',
      needs: ['design'],
      outputPaths: [`tests/${mod.name}.test.js`],
    },
    {
      id: 'review',
      title: '代码评审与质量门',
      role: 'reviewer',
      needs: ['implement', 'test-design'],
      outputPaths: [],
    },
  ];
}

const wrap = (s) => s.trim() + '\n';

/* ------------------------------------------------------------------ */
/* 各角色的产出                                                        */
/* ------------------------------------------------------------------ */

function plannerText({ goal, mod, outputs = {} }) {
  const decision = outputs.decision || null;
  const route = {
    contract: '先把接口契约冻结，再让实现与测试并行',
    mvp: '先跑通最小闭环，再补齐契约与边界',
    'test-first': '先落用例矩阵，再由实现把用例跑绿',
    'risk-first': '先做防护栏，再补功能主线',
    phased: '先交付 P0 主链路，再进 P1 加固',
  }[decision?.angleKey];
  const adopted = decision
    ? `
### 零、本轮已裁决的方案
讨论组采纳 **方案 ${decision.winnerId} · ${decision.angleLabel}**（${decision.winnerName} 提出，平均 ${decision.average ?? '—'} 分、${decision.votes} 票）。
后续工序按「${route || '该方案的路线'}」执行，评审以它为准；偏离必须在评审结论里写明理由。
`
    : '';

  return wrap(`
我已收到这个目标，先把它拆成可并行/可串行执行的工序，再分派给合适的成员。

> **目标**：${goal}
${adopted}
### 一、需求澄清（我的假设）
1. **交付形态**：可运行的 ${mod.label} 最小闭环，而不是一次性做全量特性。
2. **优先级**：主链路可用 > 边界完备 > 性能优化。
3. **验收口径**：能跑通一条端到端用例，核心分支有自动化测试，关键函数有注释。

### 二、工序拆解

| # | 工序 | 负责 | 交付物 | 阻塞关系 |
|---|------|------|--------|----------|
| 1 | 技术方案与接口契约 | Forge | \`docs/${mod.name}-design.md\` | 方案讨论 |
| 2 | 主链路实现 | Kilo | \`src/${mod.name}.js\` | 依赖 1 |
| 3 | 测试设计 | Probe | \`tests/${mod.name}.test.js\` | 依赖 1 |
| 4 | 评审与质量门 | Lens | 评审结论 | 依赖 2 / 3 |

> 第 2、3 道工序并行：Kilo 写实现，Probe 同步设计测试；汇合后真实执行测试质量门，再由 Lens 复评。

### 三、风险预判
- **接口漂移**：方案阶段先把契约写死，实现阶段不允许私自改字段名。
- **边界缺失**：空值、超长输入、并发重复提交这三类必须先覆盖。
- **过度设计**：本轮不引入数据库与鉴权体系，用内存态 + 可替换 repository 兜住。

### 四、我的编排决策
${decision ? `按已裁决的方案 ${decision.winnerId}（${decision.angleLabel}）：${route}。` : '先让 **Forge** 定契约 → **Kilo / Probe** 两路并行 → 汇合后执行质量门 → **Lens** 评审。'}
任何一步失败，我会阻断依赖它的下游；评审未通过则自动返工复评，不需要你重新描述需求。

现在开始分派。
`);
}

function architectText({ goal, mod, outputs = {} }) {
  const decision = outputs.decision || null;
  return wrap(`
方案定稿，先把**契约**写死，后面实现按契约走，避免来回改。
${decision ? `\n> 方案基线：讨论采纳 **方案 ${decision.winnerId} · ${decision.angleLabel}**，本设计按其路线收敛。\n` : ''}
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

function coderText({ goal, mod, outputs = {} }) {
  const repairRound = Number(outputs.repairRound || 0);
  if (repairRound > 0) {
    return wrap(`
收到评审反馈，本轮只修**阻塞项**，不扩大改动范围。

### 修复内容
- 写操作统一进入串行队列，避免并发 read-modify-write 丢更新。
- 对外错误只保留稳定错误码与中文提示，不再暴露内部堆栈。
- 回归用例已交给 Probe 复跑，修复不改变既有接口契约。

当前是第 ${repairRound} 轮返工，已按评审单逐项收口。
`);
  }
  return wrap(`
按契约实现，先跑通主链路，同时把边界挡在入口。
${outputs.decision ? `\n> 方案基线：本轮按讨论裁决的 **方案 ${outputs.decision.winnerId} · ${outputs.decision.angleLabel}** 执行。\n` : ''}
逐条对齐 Forge 的接口：\`create / list / close\` 三个方法全部落地，错误统一走 \`AppError\`。

**已完成的取舍**
- 列表查询用 **游标** 而不是 offset，避免数据增长后翻页抖动。
- \`close\` 做了幂等，重复关闭不报错只返回当前态。
- 标题超过 120 字符直接拒绝，不做静默截断（避免调用方以为存进去了）。

主链路自测通过，已进入与测试设计的汇合点。
`);
}

function testerText({ goal, mod, outputs = {} }) {
  const repairRound = Number(outputs.repairRound || 0);
  if (repairRound > 0) {
    return wrap(`
回归完成。本轮只验证修复项，同时重跑原有边界用例。

### 回归结果
| 编号 | 场景 | 结果 |
|------|------|------|
| T1 | 正常创建 | 通过 |
| T2 | 空标题 | 通过 |
| T3 | 超长标题 | 通过 |
| T4 | 关闭幂等 | 通过 |
| T5 | 并发创建不丢更新 | 通过 |

阻塞项已全部关闭，未发现新增回归。可交给 Lens 复评。
`);
  }
  return wrap(`
拿到契约后先设计测试，与实现并行推进；实现落地后再执行同一套用例。

### 用例矩阵
| 编号 | 场景 | 输入 | 期望 |
|------|------|------|------|
| T1 | 正常创建 | \`{title:"写周报"}\` | 返回实体，status=open |
| T2 | 空标题 | \`{title:"  "}\` | 抛 \`E_TITLE_REQUIRED\` |
| T3 | 超长标题 | 121 字符 | 抛 \`E_TITLE_TOO_LONG\` |
| T4 | 关闭幂等 | 连续 \`close\` 两次 | 两次成功，状态一致 |
| T5 | 并发创建 | 20 条并发 | 全部保留，不丢更新 |

### 风险
1. **[P1]** \`list({keyword})\` 对大小写敏感，需要归一。
2. **[P2]** \`tags\` 未去重。

测试文件已生成，等待实现汇合后由质量门实际执行。
`);
}

function reviewerText({ goal, mod, outputs = {} }) {
  const repairRound = Number(outputs.repairRound || 0);
  const quality = outputs.quality || {};
  if (repairRound > 0 && quality.status !== 'failed') {
    return wrap(`
复评完成。上一轮两个 Blocker 都已按评审单关闭，自动化用例全绿。

### 结论：**通过**

### 已关闭
- **B1｜并发写**：写路径已串行化，并发用例通过。
- **B2｜错误信息泄漏**：对外只返回错误码与中文文案，堆栈不再外泄。

### 遗留建议（不阻塞）
- S1：后续可把 \`create\` 里的校验与归一拆成独立函数。
- S2：魔法数字统一提为常量。

可以交付。第 ${repairRound} 轮返工闭环完成。

VERDICT: {"decision":"PASS","blockers":0,"should":1}
`);
  }
  return wrap(`
评审完成。整体结构是干净的，但有几个点必须在上线前改掉。

### 结论：**有条件通过**

### 必须改（Blocker）
- **B1｜并发写**：\`store\` 里 \`read-modify-write\` 没有串行化，两个并发 \`create\` 可能拿到同一个自增序号。→ 加一个 promise 队列锁。
- **B2｜错误信息泄漏**：\`transport\` 直接把 \`err.stack\` 返回给调用方，生产环境会漏内部路径。→ 只回错误码 + 中文文案。

### 建议改（Should）
- **S1**：\`domain\` 里有个 47 行的 \`create\`，能拆出 \`validate\` 与 \`normalize\` 两段，可读性会好很多。
- **S2**：魔法数字 \`120\` 提为常量 \`MAX_TITLE_LEN\`。

### 做得好
- 错误码体系完整，调用方可以精准分支。
- 幂等设计到位，重试是安全的。

${quality.status === 'failed' ? '自动化测试未通过，必须先修复失败用例。' : ''}

Kilo 改完 B1、B2 后我再复评一次。

VERDICT: {"decision":"FAIL","blockers":2,"should":2}
`);
}

function summaryText({ goal, mod, outputs = {} }) {
  const passed = outputs.passed !== false;
  const repairRound = Number(outputs.repairRound || 0);
  const decision = outputs.decision || null;
  const done = ['方案文档', `${mod.name} 模块实现`, '自动化测试', '评审结论'];
  return wrap(`
## ${passed ? '交付完成' : '需要人工确认'}

**目标**：${goal}

本轮 ${done.length} 项工序全部走完${repairRound ? `，经过 ${repairRound} 轮返工复评` : ''}。
质量门${passed ? '已通过' : '仍未通过，不能按完成交付'}。
${decision ? `实施采用的是讨论后胜出的 **方案 ${decision.winnerId} · ${decision.angleLabel}**（${decision.average ?? '—'} 分）。` : ''}

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

/* ------------------------------------------------------------------ */
/* 方案讨论：提案 / 交叉质询 / 裁决                                     */
/* ------------------------------------------------------------------ */

export const ANGLES = [
  {
    key: 'contract',
    label: '契约先行',
    tag: '先把接口与数据结构钉死，实现只做填空题',
    why: '需求边界清楚、后续还要长期维护时，返工最少',
  },
  {
    key: 'mvp',
    label: '最小闭环',
    tag: '用最少代码先跑通一条端到端链路，结构后补',
    why: '首版交付最快，能最早拿到真实反馈',
  },
  {
    key: 'test-first',
    label: '测试先行',
    tag: '先把验收标准写成可执行用例，再让实现满足它',
    why: '边界和回归有保障，评审时不用靠人眼兜底',
  },
  {
    key: 'risk-first',
    label: '风险优先',
    tag: '先处理并发、错误泄漏、越权这三类会出事故的点',
    why: '上线风险最低，故障排查成本最小',
  },
  {
    key: 'phased',
    label: '分阶段交付',
    tag: '拆成两个可独立验收的阶段，先主链路再加固',
    why: '能分段验收，任何一段出问题都不会拖垮整体',
  },
];

export function angleByIndex(index) {
  return ANGLES[((index % ANGLES.length) + ANGLES.length) % ANGLES.length];
}

export function angleByKey(key) {
  return ANGLES.find((a) => a.key === key) || ANGLES[0];
}

function hash(text) {
  let h = 2166136261;
  for (const ch of String(text)) {
    h ^= ch.charCodeAt(0);
    h = Math.imul(h, 16777619);
  }
  return Math.abs(h);
}

const ROLE_TEXT = {
  planner: '规划师',
  architect: '架构师',
  coder: '实现工程师',
  tester: '测试工程师',
  reviewer: '代码评审',
};

function angleBody({ angle, goal, mod, agent }) {
  const cap = mod.name.charAt(0).toUpperCase() + mod.name.slice(1);
  const head = `> 提案人：${agent?.name || '成员'}（${agent?.title || ROLE_TEXT[agent?.role] || '成员'}） · 主张：${angle.tag}\n\n**目标**：${goal}\n`;

  if (angle.key === 'contract') {
    return wrap(`
${head}
### 一、核心主张
先把**接口与数据结构钉死**，实现阶段只做填空题。这样实现、测试、评审三条线可以同时开工，不互相等。

### 二、技术路线
- 边界：\`transport → domain → repository\` 三层，依赖单向，domain 不碰 IO。
- 契约：\`create / list / close\` 三个方法先写进文档，字段名当天冻结。
- 存储：内存 repository，接口不变，后面换数据库不用改业务代码。

### 三、落地工序

| # | 工序 | 负责 | 产出 | 依赖 |
|---|------|------|------|------|
| 1 | 契约与数据结构定稿 | 架构 | \`docs/${mod.name}-design.md\` | 无 |
| 2 | 实现与用例设计并行 | 实现 / 测试 | \`src/${mod.name}.js\`、\`tests/${mod.name}.test.js\` | 1 |
| 3 | 评审与质量门 | 评审 | VERDICT | 2 |

### 四、代价与风险
1. 前置设计要花时间，需求如果还在变，契约会返工。
2. 对很小的需求来说偏重，容易过度设计。
3. 契约一旦定错，错误会被三条线同时放大。

### 五、工作量
约 3 个文件、1 轮返工。适合边界清楚、要长期维护的 ${mod.label}。
`);
  }

  if (angle.key === 'mvp') {
    return wrap(`
${head}
### 一、核心主张
先用最少的代码跑通一条**端到端主链路**，把结构留给第二轮。首版能演示、能验收，比纸面完美更重要。

### 二、技术路线
- 一个领域文件 + 内存仓储，先不分层。
- 只实现 \`create / list / close\` 主路径，校验集中放在入口。
- 测试只覆盖主链路和两个高频错误，边界在第二轮补。

### 三、落地工序

| # | 工序 | 负责 | 产出 | 依赖 |
|---|------|------|------|------|
| 1 | 主链路实现（含最小用例） | 实现 | \`src/${mod.name}.js\`、\`tests/${mod.name}.test.js\` | 无 |
| 2 | 补契约文档 | 架构 | \`docs/${mod.name}-design.md\` | 1 |
| 3 | 评审与质量门 | 评审 | VERDICT | 1 |

### 四、代价与风险
1. 结构后补，第二批需求进来时大概率要重构。
2. 边界覆盖不足，空值和并发是最可能漏的两处。
3. 先写实现再补文档，文档容易变成事后描述而不是约束。

### 五、工作量
约 2 个文件、半天内可交付。适合先验证方向、再决定是否投入的场景。
`);
  }

  if (angle.key === 'test-first') {
    return wrap(`
${head}
### 一、核心主张
先把**验收标准写成可执行用例**，实现的目标就是让这些用例变绿。测试即文档，评审不用靠人眼兜底。

### 二、技术路线
- 先出用例矩阵：正常、空值、超长、幂等、并发五类。
- 契约由用例反推：用例里出现过的字段才算契约的一部分。
- 质量门真实执行测试，不通过就不交付。

### 三、落地工序

| # | 工序 | 负责 | 产出 | 依赖 |
|---|------|------|------|------|
| 1 | 用例矩阵与验收口径 | 测试 | \`tests/${mod.name}.test.js\` | 无 |
| 2 | 契约草案（由用例反推） | 架构 | \`docs/${mod.name}-design.md\` | 1 |
| 3 | 实现并跑绿 | 实现 | \`src/${mod.name}.js\` | 1、2 |
| 4 | 质量门 + 评审 | 评审 | VERDICT | 3 |

### 四、代价与风险
1. 用例写多会拖慢首版，需求没定稿时容易白写。
2. 测试本身有盲区，用例没覆盖到的地方依然是风险。
3. 实现可能为了过用例写死逻辑，评审要盯这一点。

### 五、工作量
约 3 个文件、1 轮返工。适合错误代价高、需要长期回归的 ${mod.label}。
`);
  }

  if (angle.key === 'risk-first') {
    return wrap(`
${head}
### 一、核心主张
先处理**会出事故的三类点**：并发写丢更新、错误信息泄漏、越权与非法入参。功能少一点可以接受，事故不能有。

### 二、技术路线
- 写路径统一进 promise 队列，读多写少也不放松。
- 对外只返回错误码 + 中文文案，堆栈只进日志。
- 入口统一校验，超长直接拒绝，不做静默截断。

### 三、落地工序

| # | 工序 | 负责 | 产出 | 依赖 |
|---|------|------|------|------|
| 1 | 风险清单与防护设计 | 评审 | 风险清单 | 无 |
| 2 | 防护栏实现（锁 / 错误码 / 校验） | 实现 | \`src/${mod.name}.js\` | 1 |
| 3 | 对抗性用例 | 测试 | \`tests/${mod.name}.test.js\` | 2 |
| 4 | 复评与质量门 | 评审 | VERDICT | 3 |

### 四、代价与风险
1. 防护栏先做，功能进度看起来会慢。
2. 过度防护会增加复杂度，评审要能区分必要与多余。
3. 风险清单如果凭经验拍脑袋，可能漏掉真正的业务风险。

### 五、工作量
约 3 个文件、1 轮返工。适合涉及资金、权限或对外接口的 ${mod.label}。
`);
  }

  return wrap(`
${head}
### 一、核心主张
拆成两个**可独立验收**的阶段：P0 主链路先上线，P1 再补边界与运维。任何一段出问题都不会拖垮整体。

### 二、技术路线
- P0：领域模块 + 内存仓储 + 主链路用例，先拿到可演示版本。
- P1：并发锁、错误码文档、持久化替换点。
- 每阶段单独跑质量门，通过才进下一阶段。

### 三、落地工序

| # | 工序 | 负责 | 产出 | 依赖 |
|---|------|------|------|------|
| 1 | P0 契约与主链路 | 架构 / 实现 | \`docs/${mod.name}-design.md\`、\`src/${mod.name}.js\` | 无 |
| 2 | P0 用例与验收 | 测试 | \`tests/${mod.name}.test.js\` | 1 |
| 3 | P1 加固项 | 实现 | 并发锁、错误码 | 2 |
| 4 | 整体评审 | 评审 | VERDICT | 3 |

### 四、代价与风险
1. 两阶段之间要做一次完整回归，成本不能省。
2. 阶段切分如果错了，同一块代码会被改两遍。
3. 多一次验收就多一次沟通开销。

### 五、工作量
约 3 个文件、2 次质量门。适合目标明确但需要分步上线的 ${mod.label}。
`);
}

/* ------------------------------------------------------------------ */
/* 方案讨论文本                                                        */
/* ------------------------------------------------------------------ */

export function proposalFor({ goal, agent, index, id }) {
  const angle = angleByIndex(index);
  const mod = pickModule(goal);
  return {
    angle,
    text: `## 方案 ${id || ''} · ${angle.label}\n\n${angleBody({ angle, goal, mod, agent })}`,
  };
}

const PREFERENCE = {
  contract: { contract: 9, mvp: 6, 'test-first': 8, 'risk-first': 8, phased: 7 },
  mvp: { contract: 6, mvp: 9, 'test-first': 7, 'risk-first': 6, phased: 7 },
  'test-first': { contract: 8, mvp: 6, 'test-first': 9, 'risk-first': 8, phased: 7 },
  'risk-first': { contract: 8, mvp: 5, 'test-first': 8, 'risk-first': 9, phased: 7 },
  phased: { contract: 8, mvp: 7, 'test-first': 7, 'risk-first': 7, phased: 9 },
};

const REASONS = {
  contract: [
    '契约清楚，实现和测试能同时开工',
    '字段冻结后返工少，但前置设计偏重',
    '结构最稳，首版会慢一些',
  ],
  mvp: [
    '交付最快，能最早拿到真实反馈',
    '结构先欠着，第二批需求会还债',
    '主链路清爽，边界覆盖偏薄',
  ],
  'test-first': [
    '用例先行，质量门有真实依据',
    '边界最完整，但首版周期最长',
    '测试即文档，评审成本最低',
  ],
  'risk-first': [
    '事故面最小，防护栏做得实',
    '功能进度慢，防护可能过度',
    '错误处理最扎实，体验层偏弱',
  ],
  phased: [
    '分阶段验收，风险可控',
    '多一次回归，沟通成本更高',
    '节奏稳，但整体交付被拉长',
  ],
};

const WEAKNESS = {
  contract: '契约定得早，如果需求还会变，返工面会同时压到三条线。',
  mvp: '边界覆盖不足，空值和并发最可能在上线后暴露。',
  'test-first': '用例写多会拖慢首版，且测试本身有盲区。',
  'risk-first': '防护栏先做，功能观感上会明显偏慢。',
  phased: '阶段切分如果错了，同一块代码要改两遍。',
};

function scoreFor(criticAngle, targetAngle, salt) {
  const base = PREFERENCE[criticAngle]?.[targetAngle] ?? 7;
  const jitter = (hash(salt) % 3) - 1; // -1 / 0 / 1
  return Math.max(5, Math.min(10, Math.round(base + jitter)));
}

export function critiqueFor({ goal, agent, index, proposals }) {
  const ownAngle = angleByIndex(index);
  const own = proposals.find((p) => p.own);
  const targets = proposals.filter((p) => !p.own);
  const criticAngle = own?.angleKey || ownAngle.key;

  const rows = targets.map((p) => {
    const score = scoreFor(criticAngle, p.angleKey, `${agent?.name}|${p.id}|${p.angleKey}`);
    const pool = REASONS[p.angleKey] || REASONS.contract;
    const reason = pool[hash(`${agent?.name}${p.id}`) % pool.length];
    const risk = WEAKNESS[p.angleKey] || WEAKNESS.contract;
    return { id: p.id, score, reason, risk };
  });

  const table = [
    '| 方案 | 评分 | 关键理由 | 我看到的硬伤 |',
    '|------|------|----------|--------------|',
    ...rows.map((r) => `| ${r.id} | ${r.score} | ${r.reason} | ${r.risk} |`),
  ].join('\n');

  const best = [...rows].sort((a, b) => b.score - a.score)[0];
  const selfLine = own
    ? `我自己的方案（${own.id}）不参与打分。它的短板我认：${WEAKNESS[own.angleKey] || WEAKNESS.contract}`
    : `我这一轮没有提交方案，只做评审。`;

  return {
    scores: rows.map((r) => ({ id: r.id, score: r.score, reason: r.reason })),
    text: wrap(`
## 交叉质询 · ${agent?.name || '成员'}

目标：${goal}

### 评分

${table}

### 我的判断
${best ? `我会优先选 **方案 ${best.id}**：${best.reason}。` : '本轮没有可评的方案。'}

${selfLine}

### 一句话
${rows.length ? `方案之间存在真实分歧，不是措辞差异；实施时必须明确采纳哪一条路线。` : '提案不足，无法比较。'}
`),
  };
}

const WINNER_WHY = {
  contract: [
    '实现与测试可以在契约冻结后并行，整体周期最短',
    '评审有明确基准，返工范围可控',
    '后面换存储或加接口，不用动业务代码',
  ],
  mvp: [
    '能最快拿到可运行版本，方向错了也及时止损',
    '工作量最小，首版验收压力低',
    '后续优化有真实反馈作为依据',
  ],
  'test-first': [
    '每条验收标准都可执行，质量门不是形式',
    '边界覆盖最完整，回归成本最低',
    '实现目标明确，评审争议最少',
  ],
  'risk-first': [
    '上线风险最低，事故成本最小',
    '错误处理与并发控制一次做到位',
    '后续加功能不用回头补防护栏',
  ],
  phased: [
    '两个阶段都能独立验收，风险不会累积',
    '主链路先上线，反馈来得早',
    '加固项有明确边界，不会无限扩散',
  ],
};

export function decisionFor({ goal, ranking, winner, judge, participants }) {
  const avg = winner.average == null ? '无有效评分' : `${winner.average.toFixed(1)} 分`;
  const rows = ranking
    .map(
      (p, i) =>
        `| ${p.id} | ${p.name} | ${p.angleLabel} | ${p.average == null ? '—' : p.average.toFixed(1)} | ${p.votes} | ${
          p.id === winner.id ? '**采纳**' : i === 1 ? '备选' : '未采纳'
        } |`,
    )
    .join('\n');

  const absorbed = ranking
    .filter((p) => p.id !== winner.id)
    .slice(0, 2)
    .map((p) => `- 吸收 **方案 ${p.id}（${p.angleLabel}）** 的一点：${(REASONS[p.angleKey] || REASONS.contract)[0]}。`)
    .join('\n');

  return wrap(`
## 裁决完成

**采纳方案 ${winner.id} · ${winner.angleLabel}**（${winner.name} 提出，平均 ${avg}，${winner.votes} 票）

目标：${goal}

### 评分汇总

| 方案 | 提案人 | 主张 | 平均分 | 票数 | 结论 |
|------|--------|------|--------|------|------|
${rows}

### 为什么是它
${(WINNER_WHY[winner.angleKey] || WINNER_WHY.contract).map((line) => `- ${line}`).join('\n')}

### 吸收了其他方案的什么
${absorbed || '- 本轮没有可吸收的备选方案。'}

### 实施约束
1. 后续工序按方案 ${winner.id} 的路线执行，不得擅自更换技术路线。
2. 评审以本方案为基准；发现硬伤必须在结论里写明，不能默默改道。
3. 质量门不通过就返工，不允许退回其他方案重来。

由 ${judge?.name || '主持人'} 主持裁决，共 ${participants} 位成员参与。现在进入实施。
`);
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
