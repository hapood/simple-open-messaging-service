import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { FederatedMemberProfileGcService } from './federated-member-profile-gc.service.js';

describe('FederatedMemberProfileGcService', () => {
  beforeEach(() => vi.stubEnv('SOMS_DOMAIN', 'local.example'));
  afterEach(() => vi.unstubAllEnvs());

  it('runs a source-wide sweep through the database', async () => {
    const execute = vi.fn().mockResolvedValue(undefined);
    const service = new FederatedMemberProfileGcService({
      db: { execute },
    } as never);

    await service.sweepSourcePeer('peer.example');

    expect(execute).toHaveBeenCalledOnce();
  });

  it('checks one profile through the caller transaction', async () => {
    const execute = vi.fn().mockResolvedValue(undefined);
    const service = new FederatedMemberProfileGcService({
      db: { execute: vi.fn() },
    } as never);

    await service.deleteProfileIfUnreferencedInTx({ execute } as never, {
      sourcePeerDomain: 'peer.example',
      memberAccount: 'alice',
      memberDomain: 'member.example',
    });

    expect(execute).toHaveBeenCalledOnce();
  });
});
