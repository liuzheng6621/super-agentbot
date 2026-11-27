import path from 'node:path';

/**
 * Normalize Windows and POSIX command paths without relying on the host path
 * implementation. Tests and shared configs may carry Windows paths on POSIX.
 */
export function commandBaseName(command) {
  const value = String(command || '').trim().replace(/^["']|["']$/g, '');
  const base = value.split(/[\\/]/).at(-1) || '';
  return base.replace(/\.(exe|cmd|bat|ps1)$/i, '').toLowerCase();
}

export function commandKey(command) {
  const base = commandBaseName(command);
  return /^[a-z0-9][a-z0-9_-]{0,63}$/.test(base) ? base : '';
}

/** Resolve a path using the host's native rules when possible. */
export function nativeBaseName(command) {
  return path.basename(String(command || '').trim());
}
