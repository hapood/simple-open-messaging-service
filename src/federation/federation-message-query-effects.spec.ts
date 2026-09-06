import { expect, it, vi } from 'vitest';
import type { Message } from '../message/message.service.js';
import { FederationService } from './federation.service.js';

it('announces the committed local seq rather than the incoming publisher seq', async () => {
  const service = Object.create(
    FederationService.prototype,
  ) as FederationService;
  const signalOutbound = vi.fn().mockResolvedValue(undefined);
  Object.assign(service, {
    config: { forwardedResourcePolicy: 'retain' },
    signalOutbound,
    notifyCurrentClientStateFeedHeads: vi.fn().mockResolvedValue(undefined),
  });
  await service.publishMessageQueryEffects('peer.test', [
    {
      kind: 'message',
      historical: false,
      threadId: 7,
      originSeq: 102,
      recipients: [],
      toAccount: '!group',
      author: { account: 'alice', domain: 'peer.test' },
      message: {
        seq: 2,
        creatorAccount: 'alice',
        creatorDomain: 'peer.test',
        isDeleted: false,
        profileRev: 0,
      } as Message,
    },
  ]);
  expect(signalOutbound).toHaveBeenCalledWith(
    7,
    { account: 'alice', domain: 'peer.test' },
    2,
    'peer.test',
  );
});
