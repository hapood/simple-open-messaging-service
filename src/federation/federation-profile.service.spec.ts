import { beforeEach, describe, expect, it, vi } from 'vitest';
import { BusinessCode } from '../common/business-code.js';
import type { S2SProfile } from './federation-profile.js';
import { FederationProfileService } from './federation-profile.service.js';

process.env.SOMS_DOMAIN ??= 'chat.example';

const profile = (profileRev: number): S2SProfile => ({
  account: 'alice',
  domain: 'peer.example',
  displayName: 'Alice',
  avatar: null,
  bio: 'hello',
  profileRev,
});

function makeSubject(storedProfileRev = 1) {
  const where = vi.fn().mockResolvedValue(undefined);
  const set = vi.fn(() => ({ where }));
  const update = vi.fn(() => ({ set }));
  const tx = { update };
  const database = {
    db: {
      query: {
        user: {
          findFirst: vi.fn().mockResolvedValue({
            avatar: '/old.webp',
            profileRev: storedProfileRev,
          }),
        },
      },
      update,
      transaction: vi.fn(async (operation: (value: typeof tx) => unknown) =>
        operation(tx),
      ),
    },
  };
  const upload = {
    readAvatarAsWire: vi.fn(),
    saveAvatarFromWire: vi.fn(),
  };
  const peerHttp = { get: vi.fn() };
  const threadAccess = {
    capturePeerResponseToken: vi.fn(),
    assertPeerResponseWritable: vi.fn().mockResolvedValue(undefined),
    assertResponseWritable: vi.fn().mockResolvedValue(undefined),
  };
  const users = { ensureForeignUserInTransaction: vi.fn() };
  return {
    subject: new FederationProfileService(
      database as never,
      upload as never,
      peerHttp as never,
      threadAccess as never,
      users as never,
    ),
    database,
    upload,
    threadAccess,
    update,
    set,
  };
}

describe('FederationProfileService localization', () => {
  beforeEach(() => vi.clearAllMocks());

  it('skips an equal or older profile revision', async () => {
    const { subject, upload, update } = makeSubject(7);

    await subject.localizeForeignProfile(17, profile(7));

    expect(upload.saveAvatarFromWire).not.toHaveBeenCalled();
    expect(update).not.toHaveBeenCalled();
  });

  it('checks the captured peer identity before updating a foreign profile', async () => {
    const { subject, database, threadAccess, set } = makeSubject(1);
    const peerToken = {
      domain: 'peer.example',
      namespaceId: 3,
      rootKeyFingerprint: 'sha256:root',
    };

    await subject.localizeForeignProfile(17, profile(2), { peerToken });

    expect(threadAccess.assertPeerResponseWritable).toHaveBeenCalledWith(
      expect.anything(),
      peerToken,
    );
    expect(database.db.transaction).toHaveBeenCalledOnce();
    expect(set).toHaveBeenCalledWith(
      expect.objectContaining({
        name: 'Alice',
        bio: 'hello',
        avatar: '',
        profileRev: 2,
        updatedAt: expect.any(Date),
      }),
    );
  });

  it('rejects a peer token for a different domain before opening a transaction', async () => {
    const { subject, database } = makeSubject();

    await expect(
      subject.upsertForeignUserFromPeerResponse(
        'alice',
        'peer.example',
        profile(2),
        {
          domain: 'other.example',
          namespaceId: 3,
          rootKeyFingerprint: 'sha256:root',
        },
      ),
    ).rejects.toMatchObject({
      bizCode: BusinessCode.FEDERATION_MALFORMED,
      status: 400,
    });
    expect(database.db.transaction).not.toHaveBeenCalled();
  });
});
