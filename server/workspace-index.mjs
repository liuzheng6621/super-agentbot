import path from 'node:path';

const generations = new Map();
const invalidated = new Map();
const added = new Map();
const moved = new Map();

function keyFor(task) {
  return `${task?.id || ''}:${path.resolve(task?.workspace || '')}`;
}

export function invalidateWorkspaceIndex(task, relPaths = '') {
  const key = keyFor(task);
  generations.set(key, (generations.get(key) || 0) + 1);
  if (!relPaths) {
    invalidated.set(key, null);
    return;
  }
  const current = invalidated.get(key);
  const paths = current === null ? null : current || new Set();
  if (paths === null) return;
  for (const item of Array.isArray(relPaths) ? relPaths : [relPaths]) {
    const rel = String(item || '').replace(/\\/g, '/').replace(/^\/+|\/+$/g, '');
    if (rel) paths.add(rel);
  }
  invalidated.set(key, paths);
}

export function rememberWorkspaceIndexAdd(task, relPath) {
  const key = keyFor(task);
  const rel = String(relPath || '').replace(/\\/g, '/').replace(/^\/+|\/+$/g, '');
  if (!rel) return;
  if (!added.has(key)) added.set(key, new Set());
  added.get(key).add(rel);
}

export function takeWorkspaceIndexAdds(task) {
  const key = keyFor(task);
  const paths = added.get(key);
  added.delete(key);
  return paths ? [...paths] : [];
}

export function rememberWorkspaceIndexMove(task, from, to) {
  const key = keyFor(task);
  if (!moved.has(key)) moved.set(key, []);
  moved.get(key).push({
    from: String(from || '').replace(/\\/g, '/'),
    to: String(to || '').replace(/\\/g, '/'),
  });
}

export function takeWorkspaceIndexMoves(task) {
  const key = keyFor(task);
  const entries = moved.get(key);
  moved.delete(key);
  return entries || [];
}

export function workspaceIndexRevision(task) {
  const key = keyFor(task);
  return {
    key,
    generation: generations.get(key) || 0,
    invalidated: invalidated.get(key),
  };
}

export function clearWorkspaceIndexInvalidation(task) {
  invalidated.delete(keyFor(task));
}
