/** Wait for the lab's own children to exit; force only survivors after the grace period. */
export async function stopLabChildren(
  children,
  { timeoutMs = 60_000, onTimeout = () => {} } = {},
) {
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1)
    throw new Error('lab shutdown timeout must be a positive integer');
  const alive = (child) =>
    child.pid !== undefined &&
    child.exitCode === null &&
    child.signalCode === null;
  const active = children.filter(alive);
  if (!active.length) return true;
  const exits = active.map(
    (child) => new Promise((resolve) => child.once('exit', resolve)),
  );
  for (const child of active) child.kill('SIGTERM');
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
    for (const child of survivors) child.kill('SIGKILL');
  }
  return graceful;
}
