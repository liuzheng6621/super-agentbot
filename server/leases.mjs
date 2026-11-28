/** Task / automation / provider lease primitives shared by the store façade. */

export const LEASE_VERSION = 1;
export const DEFAULT_TASK_LEASE_MS = 30000;
export const DEFAULT_AUTOMATION_CLAIM_MS = 15 * 60 * 1000;

export function processIsAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err?.code === 'EPERM';
  }
}

export function taskLeaseIsLive(lease, now = Date.now()) {
  return !!lease && Number(lease.expiresAt) > now && processIsAlive(Number(lease.pid));
}

/** Drop expired tasks / automations / provider slots in one pass. */
export function pruneExpiredLeases(data, now = Date.now()) {
  const result = data && typeof data === 'object' ? data : {};
  result.version = LEASE_VERSION;
  result.tasks ||= {};
  result.automations ||= {};
  result.providers ||= {};
  for (const [id, lease] of Object.entries(result.tasks)) {
    if (!taskLeaseIsLive(lease, now)) delete result.tasks[id];
  }
  for (const [id, claim] of Object.entries(result.automations)) {
    if (!taskLeaseIsLive(claim, now)) delete result.automations[id];
  }
  for (const [id, slots] of Object.entries(result.providers)) {
    const live = (Array.isArray(slots) ? slots : []).filter((slot) =>
      taskLeaseIsLive(slot, now),
    );
    if (live.length) result.providers[id] = live;
    else delete result.providers[id];
  }
  return result;
}
