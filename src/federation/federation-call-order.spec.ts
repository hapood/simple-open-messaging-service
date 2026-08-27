import { describe, expect, it, vi } from 'vitest';
import { FederationService } from './federation.service.js';

function serviceWithPost(post: (...args: unknown[]) => Promise<void>) {
  const raw = Object.create(FederationService.prototype) as Record<
    string,
    unknown
  >;
  raw.callLifecycleTails = new Map();
  raw.callAnswerDeliveries = new Map();
  raw.callLifecycleFailures = new Map();
  raw.postCallFrame = vi.fn(post);
  return {
    service: raw as unknown as FederationService,
    post: raw.postCallFrame as ReturnType<typeof vi.fn>,
  };
}

const params = (op: 'ringing' | 'accepted' | 'connected') => ({
  fromLocalUserId: 1,
  to: { account: 'bob', domain: 'b.example' },
  callSid: '550e8400-e29b-41d4-a716-446655440000',
  op,
  callType: 'AUDIO' as const,
  ...(op === 'connected' ? { startedAt: 1_700_000_000_000 } : {}),
});

const answerParams = () => ({
  fromLocalUserId: 1,
  to: { account: 'bob', domain: 'b.example' },
  callSid: '550e8400-e29b-41d4-a716-446655440000',
  op: 'signal' as const,
  callType: 'AUDIO' as const,
  signalType: 'answer' as const,
  data: 'v=0',
  signalId: 'c0a80101-0000-4000-8000-000000000001',
});

describe('Federation call lifecycle ordering', () => {
  it('does not let an in-flight or failed advisory ringing block accepted', async () => {
    let releaseRinging!: () => void;
    const ringingGate = new Promise<void>((resolve) => {
      releaseRinging = resolve;
    });
    let failRinging = false;
    const order: string[] = [];
    const { service } = serviceWithPost(async (frame) => {
      const op = (frame as { op: string }).op;
      order.push(op);
      if (op === 'ringing') {
        await ringingGate;
        if (failRinging) throw new Error('ringing delivery failed');
      }
    });

    const ringing = service.sendCallFrame(params('ringing'), 'b.example');
    await vi.waitFor(() => expect(order).toEqual(['ringing']));
    await expect(
      service.sendCallFrame(params('accepted'), 'b.example'),
    ).resolves.toBeUndefined();
    expect(order).toEqual(['ringing', 'accepted']);

    failRinging = true;
    releaseRinging();
    await expect(ringing).rejects.toThrow('ringing delivery failed');
    await expect(
      service.sendCallFrame(params('accepted'), 'b.example'),
    ).resolves.toBeUndefined();
  });

  it('does not send connected until accepted has completed', async () => {
    let releaseAccepted!: () => void;
    const acceptedGate = new Promise<void>((resolve) => {
      releaseAccepted = resolve;
    });
    const order: string[] = [];
    const { service } = serviceWithPost(async (frame) => {
      const op = (frame as { op: string }).op;
      order.push(op);
      if (op === 'accepted') await acceptedGate;
    });

    const accepted = service.sendCallFrame(params('accepted'), 'b.example');
    const connected = service.sendCallFrame(params('connected'), 'b.example');
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
    const { service } = serviceWithPost(async (frame) => {
      const typed = frame as { op: string; signalType?: string };
      order.push(typed.signalType ?? typed.op);
      if (typed.signalType === 'answer') await answerGate;
    });

    const answer = service.sendCallFrame(answerParams(), 'b.example');
    await vi.waitFor(() => expect(order).toEqual(['answer']));
    const connected = service.sendCallFrame(params('connected'), 'b.example');
    await Promise.resolve();
    expect(order).toEqual(['answer']);

    releaseAnswer();
    await Promise.all([answer, connected]);
    expect(order).toEqual(['answer', 'connected']);
  });

  it('blocks a dependent op after failure but permits retrying the failed op', async () => {
    let failAccepted = true;
    const { service, post } = serviceWithPost(async (frame) => {
      if ((frame as { op: string }).op === 'accepted' && failAccepted) {
        throw new Error('peer did not accept the frame');
      }
    });

    await expect(
      service.sendCallFrame(params('accepted'), 'b.example'),
    ).rejects.toThrow('peer did not accept the frame');
    await expect(
      service.sendCallFrame(params('connected'), 'b.example'),
    ).rejects.toThrow('peer did not accept the frame');
    expect(post).toHaveBeenCalledTimes(1);

    failAccepted = false;
    await expect(
      service.sendCallFrame(params('accepted'), 'b.example'),
    ).resolves.toBeUndefined();
    await expect(
      service.sendCallFrame(params('connected'), 'b.example'),
    ).resolves.toBeUndefined();
    expect(post).toHaveBeenCalledTimes(3);
  });
});
