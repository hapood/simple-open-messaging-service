import { describe, expect, it, vi } from 'vitest';
import { ProfileLookup } from '../profile-resolution/profile-resolution-demand.js';
import { MessageProfileWorkDispatcherService } from './message-profile-work-dispatcher.service.js';

describe('MessageProfileWorkDispatcherService', () => {
  it('dispatches committed message profile fetch and evidence work independently', async () => {
    const resolveDemand = vi.fn().mockResolvedValue(undefined);
    const resolveEvidence = vi.fn().mockResolvedValue(undefined);
    const service = new MessageProfileWorkDispatcherService(
      { resolveDemand } as never,
      { resolve: resolveEvidence } as never,
    );
    const demand = {
      namespaceId: 7,
      lookup: ProfileLookup.ACCOUNT_PROFILE,
      target: { account: 'alice', domain: 'remote.test', rev: 3 },
    };
    const evidence = {
      profile: {
        namespaceId: 7,
        account: 'alice',
        domain: 'remote.test',
        rev: 3,
      },
      lookup: ProfileLookup.ACCOUNT_PROFILE,
      projection: { threadId: 11, messageSeq: 5 },
    };

    service.dispatch({ demands: [demand], evidenceProjections: [evidence] });
    await Promise.resolve();

    expect(resolveDemand).toHaveBeenCalledExactlyOnceWith(demand);
    expect(resolveEvidence).toHaveBeenCalledExactlyOnceWith(evidence);
  });
});
