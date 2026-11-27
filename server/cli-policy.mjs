import path from 'node:path';

export const EXECUTION_POLICY_IDS = Object.freeze(['inherit', 'strict']);

const TOOL_EFFECTS = Object.freeze({
  'workspace.read': Object.freeze({ read: true }),
  'workspace.search': Object.freeze({ read: true }),
  'workspace.write': Object.freeze({ write: true }),
  'workspace.move': Object.freeze({ write: true }),
  'workspace.delete': Object.freeze({ write: true, destructive: true }),
  'history_search': Object.freeze({ read: true }),
  'history_read': Object.freeze({ read: true }),
  'mcp.call': Object.freeze({ read: true }),
  shell: Object.freeze({ execute: true }),
});

const OPTION_SPECS = {
  codex: [
    { names: ['--sandbox', '-s'], arity: 1 },
    { names: ['--dangerously-bypass-approvals-and-sandbox'], arity: 0 },
    { names: ['--full-auto'], arity: 0 },
  ],
  dsh: [
    { names: ['--permission-mode'], arity: 1 },
    { names: ['--approval-policy'], arity: 1 },
    { names: ['--add-dir'], arity: 'many' },
  ],
  claude: [
    { names: ['--permission-mode'], arity: 1 },
    { names: ['--tools'], arity: 'many' },
    { names: ['--allowedTools', '--allowed-tools'], arity: 'many' },
    { names: ['--disallowedTools', '--disallowed-tools'], arity: 'many' },
    { names: ['--add-dir'], arity: 'many' },
    { names: ['--mcp-config'], arity: 'many' },
    { names: ['--strict-mcp-config'], arity: 0 },
    { names: ['--dangerously-skip-permissions'], arity: 0 },
    { names: ['--allow-dangerously-skip-permissions'], arity: 0 },
    { names: ['--no-chrome'], arity: 0 },
  ],
};

const ADAPTERS = Object.freeze({
  codex: {
    command: 'codex',
    label: 'Codex CLI',
    boundary: 'OS 沙箱',
    readOnly: true,
    readOnlyShell: true,
    workspaceWrite: true,
    writeWithoutExecute: false,
    argsFor: (sandbox) => ['--sandbox', sandbox],
  },
  dsh: {
    command: 'dsh',
    label: 'DSH Agent',
    boundary: '权限预设 + 沙箱',
    readOnly: true,
    readOnlyShell: true,
    workspaceWrite: true,
    writeWithoutExecute: false,
    argsFor: (sandbox) => [
      '--permission-mode',
      sandbox,
      '--approval-policy',
      'never',
    ],
  },
  claude: {
    command: 'claude',
    label: 'Claude Code',
    boundary: '内置工具白名单',
    readOnly: true,
    readOnlyShell: false,
    workspaceWrite: false,
    writeWithoutExecute: false,
    argsFor: () => [
      '--permission-mode',
      'plan',
      '--tools',
      'Read,Glob,Grep',
      '--strict-mcp-config',
      '--no-chrome',
    ],
  },
});

export function normalizeExecutionPolicy(value) {
  const id = String(value || '').trim().toLowerCase();
  return EXECUTION_POLICY_IDS.includes(id) ? id : 'inherit';
}

export function commandKey(command) {
  return path
    .basename(String(command || '').trim().replace(/^["']|["']$/g, ''))
    .replace(/\.(exe|cmd|bat|ps1)$/i, '')
    .toLowerCase();
}

export function toolCapabilities(tools = []) {
  const list = Array.isArray(tools)
    ? [...new Set(tools.map((tool) => String(tool || '').trim()).filter(Boolean))]
    : [];
  const capabilities = {
    read: false,
    write: false,
    execute: false,
    destructive: false,
  };
  const unknownTools = [];
  for (const tool of list) {
    const effect = TOOL_EFFECTS[tool];
    if (!effect) {
      unknownTools.push(tool);
      continue;
    }
    if (effect.read) capabilities.read = true;
    if (effect.write) capabilities.write = true;
    if (effect.execute) capabilities.execute = true;
    if (effect.destructive) capabilities.destructive = true;
  }
  return {
    tools: list,
    unknownTools,
    ...capabilities,
    sandbox: capabilities.write
      ? 'workspace-write'
      : capabilities.read
        ? 'read-only'
        : 'none',
  };
}

export function executionPolicyCatalog() {
  return {
    policies: [
      {
        id: 'inherit',
        label: '沿用 CLI 参数',
        description: '保持现有调用方式，平台不额外收紧真实 CLI 的文件与命令能力。',
      },
      {
        id: 'strict',
        label: '严格强制',
        description: '按工具白名单映射 CLI 原生沙箱；无法强制的组合会在启动前拒绝。',
      },
    ],
    adapters: Object.values(ADAPTERS).map((adapter) => ({
      command: adapter.command,
      label: adapter.label,
      boundary: adapter.boundary,
      readOnly: adapter.readOnly,
      readOnlyShell: adapter.readOnlyShell,
      workspaceWrite: adapter.workspaceWrite,
      writeWithoutExecute: adapter.writeWithoutExecute,
    })),
  };
}

function policyResult({
  policy,
  command,
  requested,
  status,
  ok,
  enforced = false,
  sandbox = 'none',
  boundary = 'none',
  adapter = '',
  args = [],
  reason = '',
}) {
  return {
    policy,
    command,
    status,
    ok,
    enforced,
    sandbox,
    boundary,
    adapter,
    requested,
    args: [...args],
    reason,
  };
}

function unsupported(policy, command, requested, reason) {
  return policyResult({
    policy,
    command,
    requested,
    status: 'unsupported',
    ok: false,
    sandbox: requested.sandbox,
    reason,
  });
}

export function resolveCliPolicy(agent = {}) {
  const policy = normalizeExecutionPolicy(agent.executionPolicy);
  const requested = toolCapabilities(agent.tools);
  const command = commandKey(agent.cli?.command);

  if (policy === 'inherit') {
    return policyResult({
      policy,
      command,
      requested,
      status: 'inherit',
      ok: true,
      sandbox: 'cli-default',
      reason: '沿用 CLI 自身参数，平台不强制真实子进程的工具边界。',
    });
  }

  if (!command) {
    return unsupported(policy, command, requested, '严格策略要求配置真实 CLI 命令。');
  }
  if (!requested.tools.length) {
    return unsupported(
      policy,
      command,
      requested,
      '严格策略要求至少声明一个工具；空工具白名单无法验证 CLI 的实际能力。',
    );
  }
  if (requested.unknownTools.length) {
    return unsupported(
      policy,
      command,
      requested,
      `工具白名单包含无法映射的能力：${requested.unknownTools.join('、')}`,
    );
  }
  if (!requested.read && (requested.write || requested.execute)) {
    return unsupported(
      policy,
      command,
      requested,
      '工具白名单允许写入或执行，却没有允许读取；CLI 无法安全完成这类工作。',
    );
  }
  if (!requested.read) {
    return unsupported(
      policy,
      command,
      requested,
      '严格策略不允许没有工作区读取能力的 CLI 运行。',
    );
  }

  const adapter = ADAPTERS[command];
  if (!adapter) {
    return unsupported(
      policy,
      command,
      requested,
      `命令「${command}」没有可验证的严格策略映射；请改用 Codex、DSH 或 Claude，或切回 inherit。`,
    );
  }

  if (requested.sandbox === 'workspace-write') {
    if (!adapter.workspaceWrite) {
      return unsupported(
        policy,
        command,
        requested,
        `${adapter.label} 无法把写入限制在任务工作区，严格模式拒绝启动。`,
      );
    }
    if (!requested.execute && !adapter.writeWithoutExecute) {
      return unsupported(
        policy,
        command,
        requested,
        `${adapter.label} 的可写沙箱会同时开放命令执行；工具白名单未允许 shell，无法精确强制。`,
      );
    }
  }
  if (
    requested.sandbox === 'read-only' &&
    requested.execute &&
    !adapter.readOnlyShell
  ) {
    return unsupported(
      policy,
      command,
      requested,
      `${adapter.label} 无法在开放 shell 的同时保证只读，严格模式拒绝启动。`,
    );
  }

  const args = adapter.argsFor(requested.sandbox);
  return policyResult({
    policy,
    command,
    requested,
    status: 'enforced',
    ok: true,
    enforced: true,
    sandbox: requested.sandbox,
    boundary: adapter.boundary,
    adapter: adapter.label,
    args,
    reason: `${adapter.label} 将使用 ${requested.sandbox} 边界，由${adapter.boundary}强制。`,
  });
}

export function policySummary(policy = {}) {
  return {
    policy: normalizeExecutionPolicy(policy.policy),
    command: String(policy.command || ''),
    status: String(policy.status || 'inherit'),
    ok: policy.ok !== false,
    enforced: !!policy.enforced,
    sandbox: String(policy.sandbox || 'cli-default'),
    boundary: String(policy.boundary || 'none'),
    adapter: String(policy.adapter || ''),
    reason: String(policy.reason || ''),
    requested: policy.requested
      ? {
          tools: [...(policy.requested.tools || [])],
          read: !!policy.requested.read,
          write: !!policy.requested.write,
          execute: !!policy.requested.execute,
          destructive: !!policy.requested.destructive,
          sandbox: String(policy.requested.sandbox || 'none'),
        }
      : null,
  };
}

function removeOption(args, spec) {
  const out = [];
  for (let index = 0; index < args.length; index += 1) {
    const token = String(args[index]);
    const matched = spec.names.find(
      (name) => token === name || token.startsWith(`${name}=`),
    );
    if (!matched) {
      out.push(token);
      continue;
    }
    if (token.includes('=')) continue;
    if (spec.arity === 0) continue;
    if (spec.arity === 1) {
      index += 1;
      continue;
    }
    while (index + 1 < args.length && !String(args[index + 1]).startsWith('-')) {
      index += 1;
    }
  }
  return out;
}

function insertBeforePrompt(args, policyArgs) {
  const promptIndex = args.findIndex((arg) => String(arg).includes('{{prompt}}'));
  if (promptIndex >= 0) {
    return [...args.slice(0, promptIndex), ...policyArgs, ...args.slice(promptIndex)];
  }
  if (args.length && args[args.length - 1] === '-') {
    return [...args.slice(0, -1), ...policyArgs, '-'];
  }
  return [...args, ...policyArgs];
}

export function applyCliPolicyArgs(command, args = [], sandbox = '') {
  const key = commandKey(command);
  const adapter = ADAPTERS[key];
  if (!adapter || !['read-only', 'workspace-write'].includes(sandbox)) {
    return args.map((arg) => String(arg));
  }
  let next = args.map((arg) => String(arg));
  for (const spec of OPTION_SPECS[key] || []) next = removeOption(next, spec);
  return insertBeforePrompt(next, adapter.argsFor(sandbox));
}

export function prepareCliExecution(agent = {}, { args } = {}) {
  const baseArgs = Array.isArray(args)
    ? args.map((arg) => String(arg))
    : Array.isArray(agent.cli?.args)
      ? agent.cli.args.map((arg) => String(arg))
      : [];
  const policy = resolveCliPolicy(agent);
  const nextAgent = {
    ...agent,
    cli: {
      ...(agent.cli || {}),
      args: baseArgs,
    },
  };
  if (!policy.ok || !policy.enforced) return { ok: policy.ok, policy, agent: nextAgent };

  nextAgent.cli.args = applyCliPolicyArgs(
    agent.cli?.command,
    baseArgs,
    policy.sandbox,
  );
  return {
    ok: true,
    policy: {
      ...policy,
      argsApplied: nextAgent.cli.args,
    },
    agent: nextAgent,
  };
}
