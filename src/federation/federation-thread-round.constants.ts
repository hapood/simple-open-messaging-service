export const FEDERATION_THREAD_ROUND_DEFAULT_TAKE = 50;
export const FEDERATION_THREAD_SEQUENCE_MAX = Number.MAX_SAFE_INTEGER - 1;

export function resolveFederationThreadRoundTake(take?: number): number {
  const resolved = take ?? FEDERATION_THREAD_ROUND_DEFAULT_TAKE;
  if (!Number.isSafeInteger(resolved) || resolved <= 0) {
    throw new Error(
      'federation thread round take must be a positive safe integer',
    );
  }
  return resolved;
}
