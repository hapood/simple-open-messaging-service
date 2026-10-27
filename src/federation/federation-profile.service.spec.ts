import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { SQL } from 'drizzle-orm';
import { PgDialect } from 'drizzle-orm/pg-core';
import { BusinessCode } from '../common/business-code.js';
import type { S2SProfile } from './federation-profile.js';
import { FederationProfileService } from './federation-profile.service.js';

process.env.SOMS_DOMAIN ??= 'chat.example';

const dialect = new PgDialect();

const profile = (profileRev: number): S2SProfile => ({
  namespaceId: 0,
  account: 'alice',
  displayName: 'Alice',
  avatar: null,
  bio: 'hello',
  profileRev,
  generatedAt: 1_700_000_000_000,
});

function makeSubject() {
  const values = vi.fn(() => ({
    onConflictDoNothing: () => ({
      returning: async () => [{ account: 'alice' }],
    }),
  }));
  const query = {
    account: { findFirst: vi.fn().mockResolvedValue(null) },

    identityNamespace: {
      findFirst: vi.fn().mockResolvedValue({ id: 12, domain: 'peer.example' }),
    },
    profileTable: {
      findFirst: vi.fn().mockResolvedValue({
        account: 'alice',
        domain: 'local',
        publisherNamespaceId: 0,
        profileNamespaceId: 0,
        profileRev: 1,
        createdAt: new Date(1_800_000_000_000),
        generatedAt: 1_700_000_000_000,
        displayName: 'Alice',
        avatar: '',
        bio: 'hello',
      }),
    },
  };
  const groupResult = vi.fn().mockResolvedValue([]);
  const tx = {
    select: () => ({ from: () => ({ where: () => ({ limit: groupResult }) }) }),
    query,
    insert: vi.fn(() => ({ values })),
  };
  const database = {
    db: {
      ...tx,
      transaction: vi.fn(async (operation: (value: typeof tx) => unknown) =>
        operation(tx),
      ),
    },
  };
  const upload = { readAvatarAsWire: vi.fn(), saveAvatarFromWire: vi.fn() };
  return {
    subject: new FederationProfileService(
      database as never,
      upload as never,
      { get: vi.fn() } as never,
      {} as never,
      {} as never,
    ),
    database,
    upload,
    values,
  };
}

describe('FederationProfileService localization', () => {
  beforeEach(() => vi.clearAllMocks());

  it('keeps the publisher-local marker for local identity', async () => {
    const { subject, database } = makeSubject();
    database.db.query.account.findFirst.mockResolvedValueOnce({
      account: 'alice',
      domain: 'local',
      namespaceId: 0,
      name: 'Alice',
      avatar: '',
      bio: 'hello',
      defaultProfileRev: 1,
    } as never);
    const serialize = vi.spyOn(subject, 'toS2SProfile').mockResolvedValueOnce({
      namespaceId: 0,
      account: 'alice',
      displayName: 'Alice',
      avatar: null,
      bio: 'hello',
      profileRev: 1,
      generatedAt: 1_700_000_000_000,
    });

    await subject.getLocalAccountProfile({
      account: 'alice',
      domain: 'local',
    });

    expect(serialize).toHaveBeenCalledWith({
      profileNamespaceId: 0,
      account: 'alice',
      name: 'Alice',
      avatar: '',
      bio: 'hello',
      profileRev: 1,
      generatedAt: 1_700_000_000_000,
    });
  });

  it('returns revision zero for an existing user without reading a snapshot', async () => {
    const { subject, database } = makeSubject();
    database.db.query.account.findFirst.mockResolvedValueOnce({
      account: 'alice',
      namespaceId: 0,
      defaultProfileRev: 0,
      kind: 'USER',
    } as never);
    await expect(
      subject.getLocalAccountProfile({ account: 'alice', domain: 'local' }),
    ).resolves.toEqual({
      account: 'alice',
      namespaceId: 0,
      profileRev: 0,
      generatedAt: 0,
      displayName: 'alice',
      bio: '',
      avatar: null,
    });
    expect(database.db.query.profileTable.findFirst).not.toHaveBeenCalled();
  });

  it('keeps the stored version time across repeated reads instead of using the current clock', async () => {
    const { subject } = makeSubject();
    for (const now of [1_800_000_000_000, 1_900_000_000_000]) {
      const clock = vi.spyOn(Date, 'now').mockReturnValue(now);
      try {
        await expect(
          subject.getStoredProfile(0, 'alice', 0, 1),
        ).resolves.toMatchObject({
          generatedAt: 1_700_000_000_000,
        });
      } finally {
        clock.mockRestore();
      }
    }
  });

  it('does not expose a missing or system account as a no-profile user', async () => {
    const { subject, database } = makeSubject();
    await expect(
      subject.getLocalAccountProfile({ account: 'missing', domain: 'local' }),
    ).resolves.toBeNull();
    database.db.query.account.findFirst.mockResolvedValueOnce({
      account: '$system',
      namespaceId: 0,
      defaultProfileRev: 0,
      kind: 'SYSTEM',
    } as never);
    await expect(
      subject.getLocalAccountProfile({ account: '$system', domain: 'local' }),
    ).resolves.toBeNull();
  });

  it('returns revision zero for a live group without a profile', async () => {
    const { subject, database } = makeSubject();
    database.db
      .select()
      .from()
      .where()
      .limit.mockResolvedValueOnce([
        { account: '!group', namespaceId: 0, profileRev: 0, dissolvedAt: null },
      ] as never);
    await expect(
      subject.getLocalAccountProfile({ account: '!group', domain: 'local' }),
    ).resolves.toMatchObject({
      account: '!group',
      profileRev: 0,
    });
    expect(database.db.query.profileTable.findFirst).not.toHaveBeenCalled();
  });

  it('returns no group profile when only a presentation fallback is available', async () => {
    const { subject, database } = makeSubject();
    database.db
      .select()
      .from()
      .where()
      .limit.mockResolvedValueOnce([
        {
          account: '!group',
          domain: 'local',
          namespaceId: 0,
          name: 'Federated group',
          avatar: '',
          description: 'Group biography',
          profileRev: 2,
          dissolvedAt: null,
        },
      ] as never);
    const stored = vi
      .spyOn(subject, 'getStoredProfile')
      .mockResolvedValue(null);

    await expect(
      subject.getLocalAccountProfile({
        account: '!group',
        domain: 'local',
      }),
    ).resolves.toBeNull();
    expect(stored).toHaveBeenCalledWith(0, '!group', 0, 2);
  });

  it('stores a referenced third-party snapshot without an Account or a default pointer', async () => {
    const { subject, database, values } = makeSubject();
    await subject.materializeExactForeignProfile(profile(8), 12);
    expect(values).toHaveBeenCalledWith({
      publisherNamespaceId: 12,
      account: 'alice',
      profileNamespaceId: 0,
      profileRev: 8,
      generatedAt: 1_700_000_000_000,
      displayName: 'Alice',
      avatar: '',
      bio: 'hello',
    });
    expect(database.db.query.account.findFirst).not.toHaveBeenCalled();
    expect(database.db.query).not.toHaveProperty('group');
  });

  it('clears an over-limit avatar and truncates text before storing the exact revision', async () => {
    const { subject, upload, values } = makeSubject();
    const bytes = Buffer.from('avatar');
    upload.saveAvatarFromWire.mockRejectedValueOnce(
      new Error('avatar exceeds dimension limit'),
    );
    await subject.materializeExactForeignProfile(
      {
        ...profile(2),
        displayName: `${'😀'.repeat(31)}tail`,
        bio: `${'界'.repeat(120)}tail`,
        avatar: {
          mimeType: 'image/webp',
          base64: bytes.toString('base64'),
          width: 513,
          height: 513,
        },
      },
      12,
    );
    expect(values).toHaveBeenCalledWith({
      publisherNamespaceId: 12,
      account: 'alice',
      profileNamespaceId: 0,
      profileRev: 2,
      generatedAt: 1_700_000_000_000,
      displayName: '😀'.repeat(31),
      bio: '界'.repeat(120),
      avatar: '',
    });
  });

  it('materializes text when inline avatar localization fails', async () => {
    const { subject, values, upload } = makeSubject();
    upload.saveAvatarFromWire.mockRejectedValueOnce(new Error('invalid image'));
    await subject.materializeExactForeignProfile(
      {
        ...profile(9),
        avatar: {
          mimeType: 'image/webp',
          base64: 'AAAA',
          width: 1,
          height: 1,
        },
      },
      12,
    );
    expect(values).toHaveBeenCalledWith(
      expect.objectContaining({ profileRev: 9, avatar: '' }),
    );
    expect(upload.saveAvatarFromWire).toHaveBeenCalledWith({
      mimeType: 'image/webp',
      b64: 'AAAA',
      w: 1,
      h: 1,
    });
  });

  it.each([undefined, null, -1, 0.5, '1', Number.MAX_SAFE_INTEGER + 1])(
    'rejects invalid generation time %s before storing a foreign snapshot',
    async (generatedAt) => {
      const { subject, database } = makeSubject();
      await expect(
        subject.materializeExactForeignProfile(
          { ...profile(1), generatedAt } as S2SProfile,
          12,
        ),
      ).rejects.toMatchObject({ bizCode: BusinessCode.FEDERATION_MALFORMED });
      expect(database.db.transaction).not.toHaveBeenCalled();
    },
  );

  it('rejects revision zero before opening a transaction', async () => {
    const { subject, database } = makeSubject();
    await expect(
      subject.materializeExactForeignProfile(profile(0), 12),
    ).rejects.toMatchObject({ bizCode: BusinessCode.FEDERATION_MALFORMED });
    expect(database.db.transaction).not.toHaveBeenCalled();
  });

  it('does not write when the captured publisher namespace is missing', async () => {
    const { subject, database, values } = makeSubject();
    database.db.query.identityNamespace.findFirst.mockResolvedValueOnce(
      null as never,
    );
    await expect(
      subject.materializeExactForeignProfile(profile(2), 12),
    ).rejects.toThrow('publisher namespace is unavailable');
    expect(values).not.toHaveBeenCalled();
    const lookup = database.db.query.identityNamespace.findFirst.mock
      .calls[0]![0] as { where: SQL };
    expect(dialect.sqlToQuery(lookup.where).params).toEqual([12]);
  });

  it('never materializes a remote snapshot in the local namespace', async () => {
    const { subject, values } = makeSubject();
    await expect(
      subject.materializeExactForeignProfile(profile(2), 0),
    ).rejects.toThrow('publisher namespace is unavailable');
    expect(values).not.toHaveBeenCalled();
  });
});
