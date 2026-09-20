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

function makeSubject() {
  const values = vi.fn(() => ({
    onConflictDoNothing: () => ({
      returning: async () => [{ account: 'alice' }],
    }),
  }));
  const query = {
    account: { findFirst: vi.fn().mockResolvedValue(null) },

    identityNamespace: { findFirst: vi.fn().mockResolvedValue({ id: 12 }) },
    profileTable: {
      findFirst: vi.fn().mockResolvedValue({
        account: 'alice',
        domain: 'local',
        namespaceId: 0,
        profileRev: 1,
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
    ),
    database,
    upload,
    values,
  };
}

describe('FederationProfileService localization', () => {
  beforeEach(() => vi.clearAllMocks());

  it('maps the internal local identity to the public server domain', async () => {
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

  it('stores a referenced third-party snapshot without an Account or a default pointer', async () => {
    const { subject, database, values } = makeSubject();
    await subject.materializeExactForeignProfile(
      profile(8),
      'group-host.example',
      12,
    );
    expect(values).toHaveBeenCalledWith({
      account: 'alice',
      domain: 'peer.example',
      namespaceId: 12,
      profileRev: 8,
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
          digest: createHash('sha256').update(bytes).digest('hex'),
          mimeType: 'image/webp',
          base64: bytes.toString('base64'),
          width: 513,
          height: 513,
        },
      },
      'peer.example',
      12,
    );
    expect(values).toHaveBeenCalledWith({
      account: 'alice',
      domain: 'peer.example',
      namespaceId: 12,
      profileRev: 2,
      displayName: '😀'.repeat(31),
      bio: '界'.repeat(120),
      avatar: '',
    });
  });

  it('materializes text when an avatar digest is invalid', async () => {
    const { subject, values, upload } = makeSubject();
    await subject.materializeExactForeignProfile(
      {
        ...profile(9),
        avatar: {
          digest: 'invalid',
          mimeType: 'image/webp',
          base64: 'AAAA',
          width: 1,
          height: 1,
        },
      },
      'peer.example',
      12,
    );
    expect(values).toHaveBeenCalledWith(
      expect.objectContaining({ profileRev: 9, avatar: '' }),
    );
    expect(upload.saveAvatarFromWire).not.toHaveBeenCalled();
  });

  it('rejects revision zero before opening a transaction', async () => {
    const { subject, database } = makeSubject();
    await expect(
      subject.materializeExactForeignProfile(profile(0), 'peer.example', 12),
    ).rejects.toMatchObject({ bizCode: BusinessCode.FEDERATION_MALFORMED });
    expect(database.db.transaction).not.toHaveBeenCalled();
  });

  it('does not write when the captured publisher namespace is missing or mismatched', async () => {
    const { subject, database, values } = makeSubject();
    database.db.query.identityNamespace.findFirst.mockResolvedValueOnce(
      null as never,
    );
    await expect(
      subject.materializeExactForeignProfile(profile(2), 'peer.example', 12),
    ).rejects.toThrow('publisher namespace is unavailable');
    expect(values).not.toHaveBeenCalled();
    const lookup = database.db.query.identityNamespace.findFirst.mock
      .calls[0]![0] as { where: SQL };
    expect(dialect.sqlToQuery(lookup.where).params).toEqual([
      12,
      'peer.example',
    ]);
  });

  it('never materializes a remote snapshot in the local namespace', async () => {
    const { subject, values } = makeSubject();
    await expect(
      subject.materializeExactForeignProfile(profile(2), 'peer.example', 0),
    ).rejects.toThrow('publisher namespace is unavailable');
    expect(values).not.toHaveBeenCalled();
  });
});
