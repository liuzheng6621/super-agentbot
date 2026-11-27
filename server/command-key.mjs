/**
 * Normalize Windows and POSIX command paths without relying on the host path
 * implementation. Tests and shared configs may carry Windows paths on POSIX.
 */
export function commandBaseName(command) {
  let value = String(command || '').trim();
  if (!value) return '';
  const quoted = value.match(/^(["'])([\s\S]*?)\1(?:\s|$)/);
  if (quoted) {
    value = quoted[2];
  } else {
    const windowsExecutable = value.match(/^(.*?\.(?:exe|cmd|bat|ps1))(?:\s|$)/i);
    if (windowsExecutable) value = windowsExecutable[1];
    else if (!/[\\/]/.test(value)) value = value.match(/^\S+/)?.[0] || value;
  }
  value = value.trim().replace(/^["']|["']$/g, '');
  const base = value.split(/[\\/]/).at(-1) || '';
  return base.replace(/\.(exe|cmd|bat|ps1)$/i, '').toLowerCase();
}

export function commandKey(command) {
  const base = commandBaseName(command);
  return /^[a-z0-9][a-z0-9_-]{0,63}$/.test(base) ? base : '';
}
