import { randomUUID } from 'node:crypto';
import { normalizeExecutionPolicy } from './cli-policy.mjs';
import { DEFAULT_PROVIDER_ID } from './providers.mjs';
import { normalizeTimeoutOverrides } from './timeouts.mjs';

const PROFILE_ID = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,79}$/;
const WORKSPACE_MODES = new Set(['shared', 'private']);

function text(value, max = 200) {
  return String(value ?? '').trim().slice(0, max);
}

function integer(value, min, max, fallback) {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.min(max, Math.max(min, Math.round(number)));
}

function list(value, max = 32) {
  if (!Array.isArray(value)) return [];
  return [...new Set(value.map((item) => text(item, 120)).filter(Boolean))].slice(0, max);
}

function defaultNormalizeTools(value) {
  if (!Array.isArray(value)) return [];
  return [...new Set(value.map((item) => text(item, 120)).filter(Boolean))].slice(0, 32);
}

function defaultNormalizeSkills(value) {
  if (!Array.isArray(value)) return [];
  return [...new Set(value.map((item) => text(item, 120)).filter(Boolean))].slice(0, 40);
}

function workspacePolicy(value = {}, fallback = {}) {
  const source = { ...fallback, ...(value && typeof value === 'object' ? value : {}) };
  const mode = WORKSPACE_MODES.has(source.mode) ? source.mode : 'shared';
  return {
    mode,
    crossTask: source.crossTask === true,
    sharedDir: text(source.sharedDir, 80) || 'Shared',
    privateDir: text(source.privateDir, 80) || 'Agents',
  };
}

export function normalizeAgentProfile(
  input = {},
  fallback = {},
  {
    providers = [],
    normalizeTools: normalizeToolList = defaultNormalizeTools,
    normalizeSkills: normalizeSkillList = defaultNormalizeSkills,
  } = {},
) {
  const source = { ...fallback, ...input };
  const rawId = text(source.id || fallback.id, 80);
  const id = PROFILE_ID.test(rawId)
    ? rawId
    : `profile-${randomUUID().replace(/-/g, '').slice(0, 10)}`;
  const role = ['planner', 'architect', 'coder', 'tester', 'reviewer'].includes(source.role)
    ? source.role
    : 'coder';
  const providerIds = new Set((providers || []).map((provider) => provider.id));
  const providerId =
    providerIds.has(text(source.providerId, 64)) ? text(source.providerId, 64) : DEFAULT_PROVIDER_ID;
  return {
    id,
    schemaVersion: 1,
    name: text(source.name, 80) || text(source.title, 80) || '未命名 Profile',
    title: text(source.title, 80) || '自定义智能体',
    role,
    tagline: text(source.tagline, 240),
    tags: list(source.tags, 20),
    skills: normalizeSkillList(
      Array.isArray(source.skills) ? source.skills : undefined,
    ),
    tools: normalizeToolList(
      Array.isArray(source.tools) ? source.tools : undefined,
      role,
    ),
    mcpServers: list(source.mcpServers, 16),
    providerId,
    model: text(source.model, 160),
    fallbackProviderIds: list(source.fallbackProviderIds, 16).filter(
      (id) => id !== providerId && providerIds.has(id),
    ),
    maxConcurrency: integer(source.maxConcurrency, 1, 16, 1),
    workspacePolicy: workspacePolicy(source.workspacePolicy, fallback.workspacePolicy),
    executionPolicy: normalizeExecutionPolicy(source.executionPolicy),
    timeouts: normalizeTimeoutOverrides(source.timeouts),
    builtin: source.builtin === true || fallback.builtin === true,
    createdAt: Number(source.createdAt) || Date.now(),
    updatedAt: Number(source.updatedAt) || Date.now(),
  };
}

/** Profiles are shareable configuration, never credential stores. */
export function redactAgentProfile(profile, options = {}) {
  const normalized = normalizeAgentProfile(profile, {}, options);
  return {
    id: normalized.id,
    schemaVersion: normalized.schemaVersion,
    name: normalized.name,
    title: normalized.title,
    role: normalized.role,
    tagline: normalized.tagline,
    tags: normalized.tags,
    skills: normalized.skills,
    tools: normalized.tools,
    mcpServers: normalized.mcpServers,
    providerId: normalized.providerId,
    model: normalized.model,
    fallbackProviderIds: normalized.fallbackProviderIds,
    maxConcurrency: normalized.maxConcurrency,
    workspacePolicy: normalized.workspacePolicy,
    executionPolicy: normalized.executionPolicy,
    timeouts: normalized.timeouts,
    builtin: normalized.builtin,
    createdAt: normalized.createdAt,
    updatedAt: normalized.updatedAt,
  };
}

export function profileToAgentPatch(profile, options = {}) {
  const normalized = normalizeAgentProfile(profile, {}, options);
  return {
    profileId: normalized.id,
    name: normalized.name,
    title: normalized.title,
    role: normalized.role,
    tagline: normalized.tagline,
    skills: normalized.skills,
    tools: normalized.tools,
    mcpServers: normalized.mcpServers,
    providerId: normalized.providerId,
    model: normalized.model,
    fallbackProviderIds: normalized.fallbackProviderIds,
    maxConcurrency: normalized.maxConcurrency,
    workspacePolicy: normalized.workspacePolicy,
    executionPolicy: normalized.executionPolicy,
    timeouts: normalized.timeouts,
  };
}

export function agentToProfile(agent, options = {}) {
  return normalizeAgentProfile(
    {
      id: agent?.profileId || agent?.id,
      name: agent?.name,
      title: agent?.title,
      role: agent?.role,
      tagline: agent?.tagline,
      tags: agent?.skills,
      skills: agent?.skills,
      tools: agent?.tools,
      mcpServers: agent?.mcpServers,
      providerId: agent?.providerId,
      model: agent?.model,
      fallbackProviderIds: agent?.fallbackProviderIds,
      maxConcurrency: agent?.maxConcurrency,
      workspacePolicy: agent?.workspacePolicy,
      executionPolicy: agent?.executionPolicy,
      timeouts: agent?.timeouts,
    },
    {},
    options,
  );
}

export function defaultAgentWorkspacePolicy() {
  return {
    mode: 'shared',
    crossTask: false,
    sharedDir: 'Shared',
    privateDir: 'Agents',
  };
}

export function normalizeAgentWorkspacePolicy(value, fallback = defaultAgentWorkspacePolicy()) {
  return workspacePolicy(value, fallback);
}

export function normalizeAgentModel(value) {
  return text(value, 160);
}

export function normalizeAgentConcurrency(value) {
  return integer(value, 1, 16, 1);
}

export function normalizeAgentProfileId(value) {
  const id = text(value, 80);
  return PROFILE_ID.test(id) ? id : '';
}

export function providerExists(providers, id) {
  return (providers || []).some((provider) => provider.id === id);
}

export function normalizeProfileImport(value, options = {}) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Profile 必须是 JSON 对象');
  }
  return redactAgentProfile(value, options);
}
