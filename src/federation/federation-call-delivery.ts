import type {
  CallEndReason,
  CallSignalType,
  S2SCallOperation,
} from '../calls/federated-call-protocol.js';

type OutboundCallFrameBase = {
  fromLocalUserId: number;
  to: { account: string; domain: string };
  callSid: string;
  callType: 'AUDIO' | 'VIDEO';
};

type PayloadlessOutboundCallOperation = Exclude<
  S2SCallOperation,
  'incoming' | 'signal' | 'connected' | 'ended'
>;

export type OutboundCallFrameParams = OutboundCallFrameBase &
  (
    | { op: 'incoming' }
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
  private readonly lifecycleTails = new Map<string, Promise<void>>();
  private readonly answerDeliveries = new Map<string, Set<Promise<void>>>();
  private readonly lifecycleFailures = new Map<
    string,
    { op: S2SCallOperation; error: unknown }
  >();

  async send(
    params: OutboundCallFrameParams,
    peerDomain: string,
    deliver: DeliverCallFrame,
  ): Promise<void> {
    const queueKey = JSON.stringify([peerDomain, params.callSid]);
    if (params.op === 'ringing') return deliver(params, peerDomain);

    const previous = this.lifecycleTails.get(queueKey);
    const failed = this.lifecycleFailures.get(queueKey);
    if (params.op === 'incoming') {
      this.lifecycleFailures.delete(queueKey);
    } else if (failed && params.op !== failed.op) {
      throw failed.error;
    }

    if (params.op === 'signal') {
      await previous;
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
      failed?.op === params.op
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
