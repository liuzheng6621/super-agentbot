import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'agentforge-profiles-'));
process.env.AGENTFORGE_DATA_DIR = temp;

const { store } = await import('../server/store.mjs');
const { redactAgentProfile } = await import('../server/profiles.mjs');
const { withProviderProfile } = await import('../server/providers.mjs');

after(() => {
  store.flush();
  try {
    fs.rmSync(temp, { recursive: true, force: true, maxRetries: 5, retryDelay: 120 });
  } catch {
    /* Windows may hold a workspace handle briefly. */
  }
});

test('profiles support CRUD, agent binding and persisted reload', () => {
  const provider = store.addProvider({
    id: 'profile-provider',
    name: 'Profile Provider',
    model: 'provider-model',
  });
  const profile = store.addProfile({
    id: 'profile-reviewer',
    name: 'Strict Reviewer',
    role: 'reviewer',
    skills: ['code-review'],
    tools: ['workspace.read'],
    providerId: provider.id,
    model: 'profile-model',
    maxConcurrency: 2,
    workspacePolicy: { mode: 'private', crossTask: false },
  });
  assert.equal(profile.id, 'profile-reviewer');
  assert.equal(store.getProfile(profile.id).model, 'profile-model');

  const agent = store.addAgent({
    name: 'Bound Reviewer',
    role: 'reviewer',
    profileId: profile.id,
    mode: 'sim',
  });
  assert.equal(agent.profileId, profile.id);
  assert.equal(agent.model, 'profile-model');
  assert.equal(agent.maxConcurrency, 2);
  assert.deepEqual(agent.tools, ['workspace.read']);

  store.updateProfile(profile.id, { model: 'updated-model', maxConcurrency: 3 });
  assert.equal(store.getAgent(agent.id).model, 'updated-model');
  assert.equal(store.getAgent(agent.id).maxConcurrency, 3);

  store.updateAgent(agent.id, { model: 'explicit-agent-model' });
  assert.equal(store.getAgent(agent.id).model, 'explicit-agent-model');
  store.updateProfile(profile.id, { tagline: 'keeps explicit override' });
  assert.equal(store.getAgent(agent.id).model, 'explicit-agent-model');

  store.flush();
  const db = JSON.parse(fs.readFileSync(path.join(temp, 'db.json'), 'utf8'));
  assert.ok(db.profiles.some((item) => item.id === profile.id));

  const storeUrl = pathToFileURL(path.resolve('server/store.mjs')).href;
  const script = [
    `import { store } from ${JSON.stringify(storeUrl)};`,
    `const profile = store.getProfile('profile-reviewer');`,
    `console.log(JSON.stringify(profile));`,
  ].join('\n');
  const child = spawnSync(process.execPath, ['--input-type=module', '-e', script], {
    cwd: path.resolve('.'),
    env: { ...process.env, AGENTFORGE_DATA_DIR: temp },
    encoding: 'utf8',
    timeout: 15000,
  });
  assert.equal(child.status, 0, child.stderr || child.stdout);
  assert.ok(JSON.parse(child.stdout.trim()).id);
});

test('profile export and import strip credential-shaped fields', () => {
  const profile = store.addProfile({
    id: 'profile-export',
    name: 'Export Me',
    role: 'coder',
    providerId: 'local-default',
    cli: { command: 'secret-command' },
    env: { API_KEY: 'secret' },
    apiKey: 'secret',
    apiKeyRef: 'SECRET_REF',
    token: 'secret',
    password: 'secret',
    secret: 'secret',
  });
  const exported = store.exportProfile(profile.id);
  const serialized = JSON.stringify(exported);
  for (const forbidden of [
    'secret-command',
    'SECRET_REF',
    '"apiKey"',
    '"token"',
    '"password"',
    '"secret"',
  ]) {
    assert.equal(serialized.includes(forbidden), false, forbidden);
  }
  const imported = store.importProfile({ ...exported, id: 'profile-imported' });
  assert.equal(imported.id, 'profile-imported');
  assert.equal(imported.role, 'coder');
  assert.equal(JSON.stringify(redactAgentProfile(imported)).includes('SECRET_REF'), false);
});

test('deleting providers and MCP servers cleans profile references', () => {
  const provider = store.addProvider({ id: 'profile-clean-provider', name: 'Clean' });
  const server = store.addMcpServer({
    id: 'profile-clean-mcp',
    label: 'Clean MCP',
    command: process.execPath,
    args: ['tests/fixtures/mcp-readonly-server.mjs'],
    transport: 'stdio',
  });
  const profile = store.addProfile({
    id: 'profile-clean',
    name: 'Clean Me',
    providerId: provider.id,
    fallbackProviderIds: [provider.id],
    mcpServers: [server.id],
  });
  store.removeProvider(provider.id);
  store.removeMcpServer(server.id);
  const updated = store.getProfile(profile.id);
  assert.equal(updated.providerId, 'local-default');
  assert.deepEqual(updated.fallbackProviderIds, []);
  assert.deepEqual(updated.mcpServers, []);
});

test('agent model overrides provider model on the real execution copy', () => {
  const provider = store.addProvider({
    id: 'profile-model-provider',
    name: 'Model Provider',
    model: 'provider-model',
    cliBindings: {
      codex: {
        args: ['exec', '-c', 'model={{model}}', '{{prompt}}'],
        env: { OPENAI_MODEL: '{{model}}' },
      },
    },
  });
  const agent = store.findAgentByRole('coder');
  store.updateAgent(agent.id, {
    providerId: provider.id,
    model: 'agent-model',
    cli: { command: 'codex', args: ['-p', '{{prompt}}'] },
  });
  const execution = withProviderProfile(store.getAgent(agent.id), provider, {});
  assert.equal(execution.provider.model, 'agent-model');
  assert.equal(execution.cli.env.AGENTFORGE_MODEL, 'agent-model');
  assert.deepEqual(execution.cli.args, ['exec', '-c', 'model=agent-model', '{{prompt}}']);
});
