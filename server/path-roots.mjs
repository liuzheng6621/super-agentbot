import path from 'node:path';

/**
 * Normalize a configured root list into absolute paths.
 * Accepts an array or a comma separated string so the same helper works for
 * settings patches and environment variables.
 */
export function normalizeRoots(value) {
  const raw = Array.isArray(value)
    ? value
    : String(value || '')
        .split(',')
        .map((item) => item.trim())
        .filter(Boolean);
  const roots = [];
  for (const item of raw) {
    const text = String(item || '').trim();
    if (!text) continue;
    const abs = path.resolve(text);
    if (!roots.includes(abs)) roots.push(abs);
  }
  return roots;
}

function comparable(value) {
  const abs = path.resolve(String(value || ''));
  return process.platform === 'win32' ? abs.toLowerCase() : abs;
}

/**
 * Containment check that respects path boundaries: `/data/ab` is not inside
 * `/data/a`, and a parent directory is not inside its own child.
 */
export function withinRoot(target, root) {
  const child = comparable(target);
  const parent = comparable(root);
  if (child === parent) return true;
  const withSep = parent.endsWith(path.sep) ? parent : parent + path.sep;
  return child.startsWith(withSep);
}

/** Empty root list means "not configured"; callers decide whether that is open or closed. */
export function withinAnyRoot(target, roots = []) {
  return (roots || []).some((root) => withinRoot(target, root));
}

/** Returns the matched root, or '' when the target is outside every configured root. */
export function matchRoot(target, roots = []) {
  return (roots || []).find((root) => withinRoot(target, root)) || '';
}
