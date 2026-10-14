import { describe, expect, it, vi } from 'vitest';
import { FederationCallDelivery } from './federation-call-delivery.js';
import {
  FederationTransportError,
  S2sResponseError,
} from './federation-errors.js';
import { BusinessCode } from '../common/business-code.js';

function serviceWithPost(post: (...args: unknown[]) => Promise<void>) {
  const delivery = new FederationCallDelivery();
  const postFrame = vi.fn(post);
  return {
    sendCallFrame: (
      params: Parameters<FederationCallDelivery['send']>[0],
      peerDomain: string,
    ) => delivery.send(params, peerDomain, postFrame),
    post: postFrame,
  };
}

const params = (op: 'ringing' | 'accepted' | 'connected') => ({
  fromLocalUserId: 1,
  to: { account: 'bob', domain: 'b.example' },
  callSid: '550e8400-e29b-41d4-a716-446655440000',
  op,
  callType: 'AUDIO' as const,
});

const answerParams = () => ({
  fromLocalUserId: 1,
  to: { account: 'bob', domain: 'b.example' },
  callSid: '550e8400-e29b-41d4-a716-446655440000',
  op: 'signal' as const,
  callType: 'AUDIO' as const,
  signalType: 'answer' as const,
  inReplyTo: 'c0a80101-0000-4000-8000-000000000002',
  data: 'v=0',
  signalId: 'c0a80101-0000-4000-8000-000000000001',
});

describe('Federation call lifecycle ordering', () => {
  it.each(['offer', 'answer'] as const)(
    'retries an identical %s inside the queue before connected',
    async (signalType) => {
      const frame =
        signalType === 'answer'
          ? answerParams()
          : {
              ...params('accepted'),
              op: 'signal' as const,
              signalType,
              signalId: 'offer-id',
              data: 'opaque offer',
            };
      const attempts: unknown[] = [];
      const { sendCallFrame } = serviceWithPost(async (body) => {
        attempts.push(structuredClone(body));
        if (attempts.length === 1)
          throw new S2sResponseError('unavailable', 503);
      });
      const signal = sendCallFrame(frame, 'b.example');
      const connected = sendCallFrame(params('connected'), 'b.example');
      await Promise.all([signal, connected]);
      expect(attempts).toEqual([frame, frame, params('connected')]);
    },
  );

  it('stops retries when terminal convergence happens during backoff', async () => {
    const delivery = new FederationCallDelivery();
    const post = vi.fn(async () => {
      delivery.stop('b.example', answerParams().callSid);
      throw new FederationTransportError('response lost before termination');
    });
    await expect(
      delivery.send(answerParams(), 'b.example', post),
    ).rejects.toMatchObject({
      bizCode: BusinessCode.CALL_TERMINATED,
    });
    expect(post).toHaveBeenCalledTimes(1);
  });

  it('bounds persistent transport failure and never sends dependent connected', async () => {
    const { sendCallFrame, post } = serviceWithPost(async () => {
      throw new FederationTransportError('network unavailable');
    });
    const answer = sendCallFrame(answerParams(), 'b.example');
    const connected = sendCallFrame(params('connected'), 'b.example');
    const results = await Promise.allSettled([answer, connected]);
    expect(results.map((result) => result.status)).toEqual([
      'rejected',
      'rejected',
    ]);
    expect(post).toHaveBeenCalledTimes(3);
    for (const [body] of post.mock.calls) expect(body).toEqual(answerParams());
  });

  it.each([
    new S2sResponseError('malformed', 400, BusinessCode.FEDERATION_MALFORMED),
    new S2sResponseError('terminal', 200, BusinessCode.CALL_TERMINATED),
  ])('does not retry fatal business responses: %s', async (error) => {
    const { sendCallFrame, post } = serviceWithPost(async () => {
      throw error;
    });
    await expect(sendCallFrame(answerParams(), 'b.example')).rejects.toBe(
      error,
    );
    expect(post).toHaveBeenCalledTimes(1);
  });

  it('does not let an in-flight or failed advisory ringing block accepted', async () => {
    let releaseRinging!: () => void;
    const ringingGate = new Promise<void>((resolve) => {
      releaseRinging = resolve;
    });
    let failRinging = false;
    const order: string[] = [];
    const { sendCallFrame } = serviceWithPost(async (frame) => {
      const op = (frame as { op: string }).op;
      order.push(op);
      if (op === 'ringing') {
        await ringingGate;
        if (failRinging) throw new Error('ringing delivery failed');
      }
    });

    const ringing = sendCallFrame(params('ringing'), 'b.example');
    await vi.waitFor(() => expect(order).toEqual(['ringing']));
    await expect(
      sendCallFrame(params('accepted'), 'b.example'),
    ).resolves.toBeUndefined();
    expect(order).toEqual(['ringing', 'accepted']);

    failRinging = true;
    releaseRinging();
    await expect(ringing).rejects.toThrow('ringing delivery failed');
    await expect(
      sendCallFrame(params('accepted'), 'b.example'),
    ).resolves.toBeUndefined();
  });

  it('does not send connected until accepted has completed', async () => {
    let releaseAccepted!: () => void;
    const acceptedGate = new Promise<void>((resolve) => {
      releaseAccepted = resolve;
    });
    const order: string[] = [];
    const { sendCallFrame } = serviceWithPost(async (frame) => {
      const op = (frame as { op: string }).op;
      order.push(op);
      if (op === 'accepted') await acceptedGate;
    });

    const accepted = sendCallFrame(params('accepted'), 'b.example');
    const connected = sendCallFrame(params('connected'), 'b.example');
    await vi.waitFor(() => expect(order).toEqual(['accepted']));

    releaseAccepted();
    await Promise.all([accepted, connected]);
    expect(order).toEqual(['accepted', 'connected']);
  });

  it('does not let connected overtake an in-flight answer', async () => {
    let releaseAnswer!: () => void;
    const answerGate = new Promise<void>((resolve) => {
      releaseAnswer = resolve;
    });
    const order: string[] = [];
    const { sendCallFrame } = serviceWithPost(async (frame) => {
      const typed = frame as { op: string; signalType?: string };
      order.push(typed.signalType ?? typed.op);
      if (typed.signalType === 'answer') await answerGate;
    });

    const answer = sendCallFrame(answerParams(), 'b.example');
    const connected = sendCallFrame(params('connected'), 'b.example');
    await vi.waitFor(() => expect(order).toEqual(['answer']));
    await Promise.resolve();
    expect(order).toEqual(['answer']);

    releaseAnswer();
    await Promise.all([answer, connected]);
    expect(order).toEqual(['answer', 'connected']);
  });

  it('blocks connected after an answer failure until the answer retry succeeds', async () => {
    let fail = true;
    const { sendCallFrame, post } = serviceWithPost(async (frame) => {
      if ((frame as { op: string }).op === 'signal' && fail)
        throw new Error('answer delivery failed');
    });
    await expect(sendCallFrame(answerParams(), 'b.example')).rejects.toThrow(
      'answer delivery failed',
    );
    await expect(
      sendCallFrame(params('connected'), 'b.example'),
    ).rejects.toThrow('answer delivery failed');
    expect(post).toHaveBeenCalledTimes(1);
    fail = false;
    await sendCallFrame(answerParams(), 'b.example');
    await sendCallFrame(params('connected'), 'b.example');
    expect(post).toHaveBeenCalledTimes(3);
  });

  it('blocks a dependent op after failure but permits retrying the failed op', async () => {
    let failAccepted = true;
    const { sendCallFrame, post } = serviceWithPost(async (frame) => {
      if ((frame as { op: string }).op === 'accepted' && failAccepted) {
        throw new Error('peer did not accept the frame');
      }
    });

    await expect(
      sendCallFrame(params('accepted'), 'b.example'),
    ).rejects.toThrow('peer did not accept the frame');
    await expect(
      sendCallFrame(params('connected'), 'b.example'),
    ).rejects.toThrow('peer did not accept the frame');
    expect(post).toHaveBeenCalledTimes(1);

    failAccepted = false;
    await expect(
      sendCallFrame(params('accepted'), 'b.example'),
    ).resolves.toBeUndefined();
    await expect(
      sendCallFrame(params('connected'), 'b.example'),
    ).resolves.toBeUndefined();
    expect(post).toHaveBeenCalledTimes(3);
  });
});
