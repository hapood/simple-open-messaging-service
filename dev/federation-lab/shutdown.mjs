/**
 * Signal the child's whole process group. Lab children are spawned detached,
 * so the subtree beneath them (npm → sh → vite) shares one group and is
 * reached together — a plain signal to the direct child stops npm while vite
 * lives on and keeps its port. A group also survives its leader's death, so
 * this still reaches grandchildren orphaned by an early-exiting direct child.
 * ESRCH simply means the group is already gone.
 */
export function signalProcessGroup(child, signal) {
  if (child.pid === undefined) return;
  try {
    process.kill(-child.pid, signal);
  } catch (error) {
    if (error?.code === 'ESRCH') return;
    child.kill(signal);
  }
}

/** Wait for the lab's own children to exit; force only survivors after the grace period. */
export async function stopLabChildren(
  children,
  { timeoutMs = 60_000, onTimeout = () => {}, signal = signalProcessGroup } = {},
) {
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1)
    throw new Error('lab shutdown timeout must be a positive integer');
  const alive = (child) =>
    child.pid !== undefined &&
    child.exitCode === null &&
    child.signalCode === null;
  const active = children.filter(alive);
  if (!children.length) return true;
  const exits = active.map(
    (child) => new Promise((resolve) => child.once('exit', resolve)),
  );
  // Exited children are included on purpose: their group can still hold
  // grandchildren that must go down with the lab.
  for (const child of children) signal(child, 'SIGTERM');
  let timer;
  const graceful = await Promise.race([
    Promise.all(exits).then(() => true),
    new Promise((resolve) => {
      timer = setTimeout(() => resolve(false), timeoutMs);
    }),
  ]);
  clearTimeout(timer);
  if (!graceful) {
    const survivors = active.filter(alive);
    onTimeout(survivors);
    for (const child of survivors) signal(child, 'SIGKILL');
  }
  return graceful;
}
