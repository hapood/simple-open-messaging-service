const DEFAULT_COOLDOWN_SECONDS = 15 * 60;

/** Retry-After uses seconds. Invalid or absent values use the namespace default. */
export function cooldownDeadline(
  now: Date,
  retryAfter: unknown,
  current: Date | null,
): Date {
  const seconds =
    typeof retryAfter === 'number' &&
    Number.isSafeInteger(retryAfter) &&
    retryAfter >= 0
      ? retryAfter
      : DEFAULT_COOLDOWN_SECONDS;
  const deadline = now.getTime() + seconds * 1000;
  // Reject an unrepresentable remote duration before storing the in-memory deadline.
  const candidate =
    Number.isSafeInteger(deadline) && deadline <= 8_640_000_000_000_000
      ? deadline
      : now.getTime() + DEFAULT_COOLDOWN_SECONDS * 1000;
  return new Date(Math.max(candidate, current?.getTime() ?? candidate));
}
