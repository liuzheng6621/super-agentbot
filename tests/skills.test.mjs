import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'agentforge-skills-'));
const userSkills = path.join(temp, 'user-skills');
process.env.AGENTFORGE_DATA_DIR = temp;
process.env.AGENTFORGE_USER_SKILLS_DIR = userSkills;

const { store } = await import('../server/store.mjs');
const {
  discoverSkills,
  selectSkills,
  skillPromptBlock,
  activateSkills,
  buildPrompt,
  clearSkillCache,
} = await import('../server/orchestrator.mjs');

function writeSkill(root, id, frontmatter, body) {
  const dir = path.join(root, '.agents', 'skills', id);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'SKILL.md'), `---\n${frontmatter}\n---\n\n${body}\n`);
}

test('从项目技能目录发现并按触发词激活技能', () => {
  const workspace = fs.mkdtempSync(path.join(temp, 'workspace-'));
  writeSkill(
    workspace,
    'frontend-ui',
    [
      'name: 前端界面规范',
      'description: 用现有组件体系实现界面',
      'triggers: [前端, ui]',
      'roles: coder, tester',
    ].join('\n'),
    '先读现有组件，再实现界面，最后检查响应式布局。',
  );
  const task = store.createTask({ goal: '优化前端 UI 的响应式布局', workspace });
  const agent = {
    id: 'skill-agent',
    name: 'Kilo',
    role: 'coder',
    title: '实现工程师',
    skills: [],
  };
  clearSkillCache();

  const skills = discoverSkills(task);
  assert.equal(skills.length, 1);
  assert.equal(skills[0].id, 'frontend-ui');
  assert.equal(skills[0].source, 'workspace');
  assert.deepEqual(skills[0].triggers, ['前端', 'ui']);

  const active = selectSkills(task, agent, { title: '实现响应式前端页面', role: 'coder' });
  assert.deepEqual(active.map((skill) => skill.id), ['frontend-ui']);
  const block = skillPromptBlock(active);
  assert.match(block, /已激活技能/);
  assert.match(block, /先读现有组件/);
  assert.match(block, /不能绕过工具权限/);
  const prompt = buildPrompt(
    task,
    agent,
    { id: 'implement', title: '实现页面', role: 'coder' },
    '上游产物',
    null,
    { skills: active },
  );
  assert.match(prompt, /已激活技能/);
  assert.match(prompt, /先读现有组件/);

  const record = activateSkills(task, agent, { id: 'implement', title: '实现页面' }, 'step');
  assert.equal(record.skills.length, 1);
  const saved = store.getTask(task.id);
  assert.equal(saved.skillActivations.length, 1);
  assert.equal(saved.skillActivations[0].skills[0].id, 'frontend-ui');
  assert.ok(
    saved.events.some(
      (event) =>
        event.type === 'skill.activated' &&
        event.stepId === 'implement' &&
        event.data.skills[0].id === 'frontend-ui',
    ),
  );
  assert.equal(store.taskSummary(saved).skillActivations.length, 1, '/api/state 摘要可见');
});

test('工作区技能覆盖同名用户技能，角色和显式技能选择都受控', () => {
  const workspace = fs.mkdtempSync(path.join(temp, 'workspace-'));
  writeSkill(
    userSkills,
    'shared',
    'name: 用户技能\ntriggers: 数据库\nroles: coder',
    'USER_SKILL_CONTENT',
  );
  writeSkill(
    workspace,
    'shared',
    'name: 项目技能\ntriggers: 数据库\nroles: coder',
    'WORKSPACE_SKILL_CONTENT',
  );
  const task = store.createTask({ goal: '迁移数据库', workspace });
  clearSkillCache();

  const skills = discoverSkills(task);
  const shared = skills.filter((skill) => skill.id === 'shared');
  assert.equal(shared.length, 1);
  assert.equal(shared[0].source, 'workspace');
  assert.match(shared[0].content, /WORKSPACE_SKILL_CONTENT/);

  const wrongRole = selectSkills(
    task,
    { id: 'reviewer', name: 'Lens', role: 'reviewer', title: '评审', skills: [] },
    { title: '评审数据库迁移', role: 'reviewer' },
  );
  assert.deepEqual(wrongRole, [], 'roles 限制必须生效');

  const explicit = selectSkills(
    task,
    { id: 'coder', name: 'Kilo', role: 'coder', title: '实现', skills: ['shared'] },
    { title: '处理普通任务', role: 'coder' },
  );
  assert.deepEqual(explicit.map((skill) => skill.id), ['shared'], '显式技能选择不依赖触发词');
});

test('禁用、超大和越界技能文件不会被装载', () => {
  const workspace = fs.mkdtempSync(path.join(temp, 'workspace-'));
  writeSkill(workspace, 'disabled', 'name: 禁用技能\ntriggers: 数据库\nenabled: false', 'SHOULD_NOT_LOAD');
  writeSkill(workspace, 'oversized', 'name: 超大技能\ntriggers: 数据库', 'x'.repeat(64 * 1024 + 1));
  const outside = path.join(temp, 'outside-skill.md');
  fs.writeFileSync(outside, 'OUTSIDE_SKILL');
  const linkDir = path.join(workspace, '.agents', 'skills', 'outside-link');
  fs.mkdirSync(linkDir, { recursive: true });
  try {
    fs.symlinkSync(outside, path.join(linkDir, 'SKILL.md'), 'file');
  } catch {
    /* Windows 未开启开发者模式时无法创建符号链接，超大文件仍覆盖边界。 */
  }

  const task = store.createTask({ goal: '数据库迁移', workspace });
  clearSkillCache();
  const skills = discoverSkills(task);
  assert.ok(!skills.some((skill) => skill.id === 'disabled'));
  assert.ok(!skills.some((skill) => skill.id === 'oversized'));
  assert.ok(!skills.some((skill) => skill.id === 'outside-link'));
});

test.after(() => {
  store.flush();
  clearSkillCache();
  try {
    fs.rmSync(temp, { recursive: true, force: true, maxRetries: 5, retryDelay: 120 });
  } catch {
    /* Windows 临时目录偶发占用 */
  }
});
