import type {
  CallEndReason,
  CallSignalType,
  S2SCallOperation,
} from '../calls/federated-call-protocol.js';
import { CALL_REPLAY_RETENTION_MS } from '../calls/call-timing.js';
import { BusinessCode } from '../common/business-code.js';
import { BusinessException } from '../common/business.exception.js';

type OutboundCallFrameBase = {
  fromLocalUserId: number;
  to: { account: string; domain: string };
  callSid: string;
  /** Local transport metadata; never part of the call frame body. */
  signatureExpiresAtSec?: number;
};

type PayloadlessOutboundCallOperation = Exclude<
  S2SCallOperation,
  'incoming' | 'signal' | 'connected' | 'ended'
>;

export type OutboundCallFrameParams = OutboundCallFrameBase &
  (
    | { op: 'incoming'; callType: 'AUDIO' | 'VIDEO' }
    | {
        op: 'signal';
        signalId: string;
        signalType: CallSignalType;
        data: string;
      }
    | { op: 'connected'; startedAt: number }
    | { op: 'ended'; endReason: CallEndReason }
    | { op: PayloadlessOutboundCallOperation }
  );

type DeliverCallFrame = (
  params: OutboundCallFrameParams,
  peerDomain: string,
) => Promise<void>;

/**
 * Orders ephemeral call frames for each peer/call pair.
 *
 * Lifecycle frames are serialized, SDP answers finish before `connected`, and
 * advisory ringing plus ICE candidates remain independent of that queue.
 */
export class FederationCallDelivery {
  private readonly stopped = new Map<string, ReturnType<typeof setTimeout>>();
  private readonly lifecycleTails = new Map<string, Promise<void>>();
  private readonly answerDeliveries = new Map<string, Set<Promise<void>>>();
  private readonly lifecycleFailures = new Map<
    string,
    { op: S2SCallOperation; error: unknown }
  >();

  stop(peerDomain: string, callSid: string): void {
    const key = JSON.stringify([peerDomain, callSid]);
    if (this.stopped.has(key)) return;
    const timer = setTimeout(() => {
      this.stopped.delete(key);
      this.lifecycleFailures.delete(key);
    }, CALL_REPLAY_RETENTION_MS);
    timer.unref?.();
    this.stopped.set(key, timer);
  }

  async send(
    params: OutboundCallFrameParams,
    peerDomain: string,
    deliver: DeliverCallFrame,
  ): Promise<void> {
    const queueKey = JSON.stringify([peerDomain, params.callSid]);
    const terminal = ['declined', 'cancelled', 'missed', 'ended'].includes(
      params.op,
    );
    const checkActive = () => {
      if (!terminal && this.stopped.has(queueKey)) {
        throw new BusinessException(
          BusinessCode.CALL_TERMINATED,
          'call delivery is terminal',
        );
      }
    };
    checkActive();
    if (terminal) this.stop(peerDomain, params.callSid);
    if (params.op === 'ringing') return deliver(params, peerDomain);

    const previous = this.lifecycleTails.get(queueKey);
    const failed = this.lifecycleFailures.get(queueKey);
    if (params.op === 'incoming') {
      this.lifecycleFailures.delete(queueKey);
    } else if (failed && params.op !== failed.op && !terminal) {
      throw failed.error;
    }

    if (params.op === 'signal') {
      await previous;
      checkActive();
      const delivery = deliver(params, peerDomain);
      if (params.signalType !== 'answer') return delivery;
      const pending = this.answerDeliveries.get(queueKey) ?? new Set();
      pending.add(delivery);
      this.answerDeliveries.set(queueKey, pending);
      try {
        await delivery;
      } finally {
        pending.delete(delivery);
        if (pending.size === 0) this.answerDeliveries.delete(queueKey);
      }
      return;
    }

    const lifecyclePredecessor =
      terminal || failed?.op === params.op
        ? (previous ?? Promise.resolve()).catch(() => undefined)
        : (previous ?? Promise.resolve());
    const pendingAnswers =
      params.op === 'connected'
        ? [...(this.answerDeliveries.get(queueKey) ?? [])]
        : [];
    const predecessor = Promise.all([
      lifecyclePredecessor,
      ...pendingAnswers,
    ]).then(() => undefined);
    const current = predecessor.then(async () => {
      checkActive();
      try {
        await deliver(params, peerDomain);
        this.lifecycleFailures.delete(queueKey);
      } catch (error) {
        this.lifecycleFailures.set(queueKey, { op: params.op, error });
        throw error;
      }
    });
    this.lifecycleTails.set(queueKey, current);
    try {
      await current;
    } finally {
      if (this.lifecycleTails.get(queueKey) === current) {
        this.lifecycleTails.delete(queueKey);
      }
    }
  }
}
