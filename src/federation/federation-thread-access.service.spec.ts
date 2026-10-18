import { beforeEach, describe, expect, it, vi } from 'vitest';
import { BusinessCode } from '../common/business-code.js';
import { isThreadMutuallyAuthorized } from '../relationship/shared/relationship-authorization.js';
import { FederationThreadAccessService } from './federation-thread-access.service.js';

vi.mock('../relationship/shared/relationship-authorization.js', () => ({
  isThreadMutuallyAuthorized: vi.fn(),
}));

function makeSubject(rows: unknown[][]) {
  const pendingRows = [...rows];
  const query: Record<string, unknown> = {};
  for (const method of ['from', 'innerJoin', 'leftJoin', 'where']) {
    query[method] = vi.fn(() => query);
  }
  query.limit = vi.fn(async () => pendingRows.shift() ?? []);
  const database = {
    db: {
      select: vi.fn(() => query),
      transaction: vi.fn(async (callback: (tx: unknown) => Promise<unknown>) =>
        callback(database.db),
      ),
    },
  };
  const namespaces = {
    captureActive: vi.fn(async (domain: string) => ({
      domain,
      namespaceId: 7,
      rootKeyFingerprint: 'sha256:root',
    })),
    captureActiveInTx: vi.fn().mockResolvedValue(undefined),
    requireCapturedInTx: vi.fn().mockResolvedValue(undefined),
  };
  return {
    subject: new FederationThreadAccessService(
      database as never,
      namespaces as never,
    ),
    database,
    namespaces,
  };
}

describe('FederationThreadAccessService', () => {
  beforeEach(() => {
    vi.mocked(isThreadMutuallyAuthorized).mockReset();
  });

  it('rejects a send through a retired federation namespace', async () => {
    const { subject } = makeSubject([
      [
        {
          authorityNamespaceId: 7,
          domain: 'peer.example',
          active: false,
        },
      ],
    ]);

    await expect(subject.assertGroupWritable(11)).rejects.toMatchObject({
      bizCode: BusinessCode.FEDERATION_NAMESPACE_INACTIVE,
      status: 409,
    });
  });

  it('rejects writes to a dissolved group after the namespace gate', async () => {
    const { subject } = makeSubject([
      [
        {
          authorityNamespaceId: 7,
          domain: 'peer.example',
          active: true,
        },
      ],
      [{ dissolvedAt: new Date() }],
    ]);

    await expect(subject.assertGroupWritable(11)).rejects.toMatchObject({
      bizCode: BusinessCode.GROUP_DISSOLVED,
    });
  });

  it('requires mutual authorization for a P2P write', async () => {
    vi.mocked(isThreadMutuallyAuthorized).mockResolvedValue(false);
    const { subject } = makeSubject([
      [
        {
          authorityNamespaceId: 0,
          domain: 'local',
          activeNamespaceId: null,
        },
      ],
    ]);

    await expect(subject.assertP2PWritable(11, 17)).rejects.toMatchObject({
      bizCode: BusinessCode.FRIEND_NOT_FOUND,
    });
    expect(isThreadMutuallyAuthorized).toHaveBeenCalledWith(
      expect.anything(),
      17,
      11,
    );
  });

  it('captures the peer namespace before asserting a thread exists', async () => {
    const { subject, database, namespaces } = makeSubject([[{ id: 11 }]]);

    await expect(
      subject.assertThreadExists(11, 'peer.example'),
    ).resolves.toBeUndefined();
    expect(namespaces.captureActiveInTx).toHaveBeenCalledWith(
      database.db,
      'peer.example',
    );
  });

  it('checks both peer identity and thread existence before persisting', async () => {
    const { subject, database, namespaces } = makeSubject([[{ id: 11 }]]);
    const peerToken = {
      domain: 'peer.example',
      namespaceId: 7,
      peerAssignedLocalNamespaceId: 11,
      rootKeyFingerprint: 'sha256:root',
      rootPublicKey: 'root-public-key',
    };

    await expect(
      subject.assertResourceResponseWritable(database.db as never, {
        threadId: 11,
        peerDomain: 'peer.example',
        peerToken,
      }),
    ).resolves.toBeUndefined();
    expect(namespaces.requireCapturedInTx).toHaveBeenCalledWith(
      database.db,
      peerToken,
    );
  });
});
