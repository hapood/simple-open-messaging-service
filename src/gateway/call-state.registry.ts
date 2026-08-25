import { Injectable } from '@nestjs/common';

/**
 * A participant's active-call summary, surfaced in the HELLO so a reconnecting / freshly-booted client can
 * reconcile: "am I in a call, and with whom?" The native CallController survives an SSE drop (process-global),
 * but a WebView reclaim or a device that was offline when the CALL_EVENT frames fired re-derives from this.
 *
 * Mirrored from CallsService's authoritative LiveCall on each transition (Calls writes, SseService reads for
 * the HELLO). This mirror exists to break what would otherwise be a Sse↔Calls DI cycle — SseService can't
 * inject CallsService (Calls already injects Sse), and `forwardRef` is unusable here (ESM TDZ — see the
 * [[esm-circular-di-tdz]] memory). A tiny read-optimized mirror avoids both.
 *
 * Per-user (one entry per participant). State is best-effort (ringing → connected): the native FSM driven by
 * CALL_EVENT is the live authority; this is the connect-time snapshot. Cleared on the call's terminal
 * transition (CallsService.release), so a reconnect after the call ended sees `null`.
 */
export interface ActiveCallSummary {
  callSid: string;
  /** ringing | connected (best-effort — the connect-time snapshot; accepted is transient, skipped). */
  state: string;
  /** The OTHER participant's userId. */
  peerUserId: number;
  peerAccount: string;
  peerDomain: string;
  callType: 'AUDIO' | 'VIDEO';
  isCaller: boolean;
  /** Connect epoch-ms (null until connected). */
  startedAt: number | null;
}

@Injectable()
export class CallStateRegistry {
  private readonly byUser = new Map<number, ActiveCallSummary>();

  set(userId: number, summary: ActiveCallSummary): void {
    this.byUser.set(userId, summary);
  }

  /** Patch one participant's entry (state + startedAt); a no-op if they have no active call. */
  patch(
    userId: number,
    patch: Partial<Pick<ActiveCallSummary, 'state' | 'startedAt'>>,
  ): void {
    const cur = this.byUser.get(userId);
    if (cur) this.byUser.set(userId, { ...cur, ...patch });
  }

  setPeerIdentity(userId: number, peerAccount: string, peerDomain: string): void {
    const cur = this.byUser.get(userId);
    if (cur) this.byUser.set(userId, { ...cur, peerAccount, peerDomain });
  }

  clear(userId: number): void {
    this.byUser.delete(userId);
  }

  /** The user's active-call summary, or null. Read by SseService for the HELLO. */
  get(userId: number): ActiveCallSummary | null {
    return this.byUser.get(userId) ?? null;
  }
}
