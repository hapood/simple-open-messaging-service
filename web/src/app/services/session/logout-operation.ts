import type { LogoutOutcome } from './logout-outcome';

export type UnconfirmedLogout = Exclude<LogoutOutcome, { status: 'revoked' } | { status: 'superseded' }>;
export type LogoutDecision = 'retry' | 'localOnly';
export type LogoutCompletion = 'revoked' | 'localOnly' | 'superseded';

export interface LogoutOperation {
  /** Close business admission and cancel/drain work, retaining revocation credentials. */
  stopWork(): Promise<void>;
  /** One bounded attempt. Never automatically retry an uncertain remote mutation. */
  revoke(): Promise<LogoutOutcome>;
  decide(outcome: UnconfirmedLogout): Promise<LogoutDecision>;
  /** Unsubscribe and delete the original login's credentials/resources. */
  finalize(completion: 'revoked' | 'localOnly'): Promise<void>;
}

/** Host-independent logout ordering. Only the host adapter touches cookies or OS credentials. */
export async function completeLogout(operation: LogoutOperation): Promise<LogoutCompletion> {
  await operation.stopWork();
  while (true) {
    const outcome = await operation.revoke();
    if (outcome.status === 'superseded') throw new Error('Logout transport interrupted');
    if (outcome.status === 'revoked') {
      await operation.finalize('revoked');
      return 'revoked';
    }
    const decision = await operation.decide(outcome);
    if (decision === 'localOnly') {
      await operation.finalize('localOnly');
      return 'localOnly';
    }
    if (decision !== 'retry') throw new Error('Explicit logout decision required');
  }
}
