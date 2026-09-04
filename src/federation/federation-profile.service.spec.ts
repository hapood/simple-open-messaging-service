import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { SQL } from 'drizzle-orm';
import { PgDialect } from 'drizzle-orm/pg-core';
import { createHash } from 'node:crypto';
import { BusinessCode } from '../common/business-code.js';
import type { S2SProfile } from './federation-profile.js';
import { FederationProfileService } from './federation-profile.service.js';
import { loadFederationConfig } from './federation.config.js';

process.env.SOMS_DOMAIN ??= 'chat.example';

const dialect = new PgDialect();

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
        group: {
          findFirst: vi.fn().mockResolvedValue(null),
        },
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

  it('maps the internal local identity to the public server domain', async () => {
    const { subject, database } = makeSubject();
    database.db.query.user.findFirst.mockResolvedValueOnce({
      account: 'alice',
      domain: 'local',
      namespaceId: 0,
      name: 'Alice',
      avatar: '',
      bio: 'hello',
      defaultProfileRev: 1,
    } as never);
    const serialize = vi.spyOn(subject, 'toS2SProfile').mockResolvedValueOnce({
      account: 'alice',
      domain: loadFederationConfig().domain,
      displayName: 'Alice',
      avatar: null,
      bio: 'hello',
      profileRev: 1,
    });

    await subject.getLocalAccountProfile({
      account: 'alice',
      domain: loadFederationConfig().domain,
    });

    expect(serialize).toHaveBeenCalledWith({
      account: 'alice',
      domain: loadFederationConfig().domain,
      name: 'Alice',
      avatar: '',
      bio: 'hello',
      profileRev: 1,
    });
  });

  it('publishes a live local group through the account resolver', async () => {
    const { subject, database } = makeSubject();
    database.db.query.group.findFirst.mockResolvedValueOnce({
      account: '!group',
      domain: 'local',
      namespaceId: 0,
      name: 'Federated group',
      avatar: '',
      description: 'Group biography',
      defaultProfileRev: 2,
      dissolvedAt: null,
    } as never);
    const serialize = vi.spyOn(subject, 'toS2SProfile').mockResolvedValueOnce({
      account: '!group',
      domain: loadFederationConfig().domain,
      displayName: 'Federated group',
      avatar: null,
      bio: 'Group biography',
      profileRev: 2,
    });

    await subject.getLocalAccountProfile({
      account: '!group',
      domain: loadFederationConfig().domain,
    });

    expect(serialize).toHaveBeenCalledWith({
      account: '!group',
      domain: loadFederationConfig().domain,
      name: 'Federated group',
      avatar: '',
      bio: 'Group biography',
      profileRev: 2,
    });
  });

  it('authorizes an intent author profile for either remote user or group endpoints', async () => {
    const execute = vi.fn().mockResolvedValue({ rows: [{}] });
    const limit = vi.fn().mockResolvedValue([
      {
        userId: 17,
        account: 'alice',
        displayName: 'Alice',
        avatar: '',
        bio: 'hello',
        profileRev: 3,
      },
    ]);
    const where = vi.fn(() => ({ limit }));
    const innerJoin = vi.fn(() => ({ where }));
    const from = vi.fn(() => ({ innerJoin }));
    const database = {
      db: {
        select: vi.fn(() => ({ from })),
        execute,
      },
    };
    const subject = new FederationProfileService(
      database as never,
      { readAvatarAsWire: vi.fn().mockResolvedValue(null) } as never,
      {} as never,
      {} as never,
      {} as never,
    );

    await expect(
      subject.getAuthorizedLocalProfile('alice', 3, 'peer.example', 9),
    ).resolves.toMatchObject({
      account: 'alice',
      domain: loadFederationConfig().domain,
      profileRev: 3,
    });

    const authorization = dialect.sqlToQuery(execute.mock.calls[0]![0] as SQL);
    expect(authorization.sql).toMatch(
      /intent\."authorSide" = 'A'[\s\S]+pair\."endpointADomain" = 'local'[\s\S]+pair\."endpointBDomain" = \$\d+[\s\S]+pair\."endpointBNamespaceId" = \$\d+/,
    );
    expect(authorization.sql).toMatch(
      /intent\."authorSide" = 'B'[\s\S]+pair\."endpointBDomain" = 'local'[\s\S]+pair\."endpointADomain" = \$\d+[\s\S]+pair\."endpointANamespaceId" = \$\d+/,
    );
    expect(authorization.sql).not.toContain('"endpointANamespaceId" = 0');
    expect(authorization.sql).not.toContain('"endpointBNamespaceId" = 0');
    expect(authorization.sql).not.toContain('pair.kind =');
    expect(
      authorization.sql.match(/pair\."endpointAType" = 'USER'/g),
    ).toHaveLength(1);
    expect(
      authorization.sql.match(/pair\."endpointBType" = 'USER'/g),
    ).toHaveLength(1);
    expect(authorization.sql).toContain(
      'intent."expiresAt" > CURRENT_TIMESTAMP',
    );
    expect(authorization.params).toEqual(
      expect.arrayContaining(['peer.example', 9]),
    );
  });

  it('adopts the directory-selected revision without numeric ordering', async () => {
    const { subject, upload, update } = makeSubject(7);

    await subject.localizeForeignProfile(17, profile(7));

    expect(upload.saveAvatarFromWire).not.toHaveBeenCalled();
    expect(update).toHaveBeenCalledOnce();
  });

  it('clears an over-limit avatar and truncates profile text before updating the projection', async () => {
    const { subject, upload, set } = makeSubject();
    const bytes = Buffer.from('avatar');
    upload.saveAvatarFromWire.mockRejectedValueOnce(
      new Error('federated avatar exceeds dimension limit'),
    );

    await subject.localizeForeignProfile(17, {
      ...profile(2),
      displayName: `${'😀'.repeat(30)}tail`,
      bio: `${'界'.repeat(120)}tail`,
      avatar: {
        digest: createHash('sha256').update(bytes).digest('hex'),
        mimeType: 'image/webp',
        base64: bytes.toString('base64'),
        width: 513,
        height: 513,
      },
    });

    expect(set).toHaveBeenCalledWith({
      name: '😀'.repeat(30),
      bio: '界'.repeat(120),
      avatar: '',
      defaultProfileRev: 2,
      updatedAt: expect.any(Date),
    });
  });

  it('retains a complete referenced snapshot without changing the user projection', async () => {
    const onConflictDoUpdate = vi.fn().mockResolvedValue(undefined);
    const values = vi.fn(() => ({ onConflictDoUpdate }));
    const insert = vi.fn(() => ({ values }));
    const database = {
      db: {
        query: {
          user: { findFirst: vi.fn().mockResolvedValue({ id: 17 }) },
        },
        insert,
      },
    };
    const upload = {
      readAvatarAsWire: vi.fn(),
      saveAvatarFromWire: vi.fn(),
    };
    const subject = new FederationProfileService(
      database as never,
      upload as never,
      { get: vi.fn() } as never,
      {} as never,
      {} as never,
    );

    await subject.materializeExactForeignProfile(
      {
        account: 'alice',
        domain: 'peer.example',
        displayName: 'Group Alice',
        bio: 'Group biography',
        avatar: null,
        profileRev: 8,
      },
      'group-host.example',
      12,
    );

    expect(insert).toHaveBeenCalledOnce();
    expect(values).toHaveBeenCalledWith({
      userId: 17,
      profileRev: 8,
      displayName: 'Group Alice',
      avatar: '',
      bio: 'Group biography',
    });
    expect(database.db.query.user.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({ columns: { id: true } }),
    );
    expect(upload.saveAvatarFromWire).not.toHaveBeenCalled();
  });

  it('materializes text-only data when a referenced profile avatar is invalid', async () => {
    const onConflictDoUpdate = vi.fn().mockResolvedValue(undefined);
    const values = vi.fn(() => ({ onConflictDoUpdate }));
    const database = {
      db: {
        query: {
          user: { findFirst: vi.fn().mockResolvedValue({ id: 17 }) },
        },
        insert: vi.fn(() => ({ values })),
      },
    };
    const subject = new FederationProfileService(
      database as never,
      {
        readAvatarAsWire: vi.fn(),
        saveAvatarFromWire: vi.fn(),
      } as never,
      {} as never,
      {} as never,
      {} as never,
    );

    await subject.materializeExactForeignProfile(
      {
        account: 'alice',
        domain: 'peer.example',
        displayName: `${'A'.repeat(30)}tail`,
        bio: `${'B'.repeat(120)}tail`,
        avatar: {
          digest: 'invalid',
          mimeType: 'image/webp',
          base64: 'AAAA',
          width: 1,
          height: 1,
        },
        profileRev: 9,
      },
      'peer.example',
      12,
    );

    expect(values).toHaveBeenCalledWith({
      userId: 17,
      profileRev: 9,
      displayName: 'A'.repeat(30),
      avatar: '',
      bio: 'B'.repeat(120),
    });
  });

  it('rejects revision zero before materializing a referenced snapshot', async () => {
    const { subject, database } = makeSubject();

    await expect(
      subject.materializeExactForeignProfile(
        {
          account: 'alice',
          domain: 'peer.example',
          displayName: 'Alice',
          bio: '',
          avatar: null,
          profileRev: 0,
        },
        'group-host.example',
        12,
      ),
    ).rejects.toMatchObject({
      bizCode: BusinessCode.FEDERATION_MALFORMED,
    });
    expect(database.db.update).not.toHaveBeenCalled();
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
        defaultProfileRev: 2,
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
