/** Shared outcome contract for bounded host-owned session revocation. */
export type LogoutOutcome =
  | { status: 'revoked' }
  | { status: 'httpFailure'; status_code: number }
  | { status: 'transportFailure' }
  | { status: 'timedOut' }
  | { status: 'taskFailure' }
  | { status: 'unknownTicket' }
  | { status: 'superseded' };

export function classifyLogoutFailure(error: unknown): LogoutOutcome {
  const status = error && typeof error === 'object'
    ? (error as { status?: unknown }).status : undefined;
  return typeof status === 'number' && Number.isInteger(status) && status >= 100 && status <= 599
    ? { status: 'httpFailure', status_code: status }
    : { status: 'transportFailure' };
}
