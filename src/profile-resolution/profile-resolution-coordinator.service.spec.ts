import { describe, expect, it, vi } from 'vitest';
import { PgDialect } from 'drizzle-orm/pg-core';
import type { SQL } from 'drizzle-orm';
import { BusinessCode } from '../common/business-code.js';
import { S2sResponseError } from '../federation/federation-errors.js';
import { ProfileLookup } from './profile-resolution-demand.js';
import { ProfileResolutionCoordinatorService } from './profile-resolution-coordinator.service.js';

function createSubject(options?: {
  namespaceDomain?: string;
  storedProfile?: object | null;
}) {
  const database = {
    db: {
      query: {
        identityNamespace: {
          findFirst: vi
            .fn()
            .mockResolvedValue(
              options?.namespaceDomain === undefined
                ? { domain: 'publisher.test' }
                : { domain: options.namespaceDomain },
            ),
        },
      },
      execute: vi.fn().mockResolvedValue({ rows: [{ allowed: 1 }] }),
    },
  };
  const profiles = {
    fetchExactAccountProfile: vi.fn(),
    fetchExactIntentProfile: vi.fn(),
    fetchExactGroupMemberProfile: vi.fn(),
    materializeExactForeignProfile: vi.fn().mockResolvedValue(undefined),
    getStoredProfile: vi.fn().mockResolvedValue(options?.storedProfile ?? null),
  };
  const sse = {
    onProfileAvailable: vi.fn(),
    onProfileUnavailable: vi.fn(),
  };
  const subject = new ProfileResolutionCoordinatorService(
    database as never,
    profiles as never,
    sse as never,
  );
  return { subject, database, profiles, sse };
}

const accountDemand = {
  publisherNamespaceId: 7,
  lookup: ProfileLookup.ACCOUNT_PROFILE,
  target: {
    profileNamespaceId: 12,
    account: 'alice',
    domain: 'member.test',
    rev: 4,
  },
} as const;

const wireProfile = {
  namespaceId: 12,
  account: 'alice',
  domain: 'member.test',
  displayName: 'Alice',
  bio: 'Biography',
  avatar: null,
  profileRev: 4,
};

describe('ProfileResolutionCoordinatorService', () => {
  it('preserves disclosed profile failure semantics from S2S responses', () => {
    const { subject } = createSubject();

    expect(
      subject['failureReason'](
        new S2sResponseError(
          'not disclosed',
          200,
          BusinessCode.FEDERATION_PROFILE_NOT_DISCLOSED,
        ),
      ),
    ).toBe('NOT_DISCLOSED');
    expect(
      subject['failureReason'](
        new S2sResponseError('not found', 200, BusinessCode.NOT_FOUND),
      ),
    ).toBe('NOT_FOUND');
  });

  it('uses the namespace publisher domain for ACCOUNT_PROFILE transport', async () => {
    const { subject, profiles } = createSubject();
    profiles.fetchExactAccountProfile.mockResolvedValue(wireProfile);
    profiles.getStoredProfile.mockResolvedValue(wireProfile);

    await subject['fetch'](
      {
        publisherNamespaceId: 7,
        profileNamespaceId: 12,
        account: 'alice',
        domain: 'member.test',
        rev: 4,
      },
      accountDemand,
    );

    expect(profiles.fetchExactAccountProfile).toHaveBeenCalledWith(
      'alice',
      4,
      'publisher.test',
      12,
    );
    expect(profiles.materializeExactForeignProfile).toHaveBeenCalledWith(
      wireProfile,
      7,
    );
  });

  it('dispatches RELATIONSHIP_INTENT_PROFILE with its peer account', async () => {
    const { subject, profiles } = createSubject();
    profiles.fetchExactIntentProfile.mockResolvedValue(wireProfile);
    profiles.getStoredProfile.mockResolvedValue(wireProfile);
    const demand = {
      publisherNamespaceId: 7,
      lookup: ProfileLookup.RELATIONSHIP_INTENT_PROFILE,
      target: accountDemand.target,
      peerAccount: 'bob',
    } as const;

    await subject['fetch'](
      {
        publisherNamespaceId: 7,
        profileNamespaceId: 12,
        account: 'alice',
        domain: 'member.test',
        rev: 4,
      },
      demand,
    );

    expect(profiles.fetchExactIntentProfile).toHaveBeenCalledWith(
      'alice',
      'bob',
      4,
      'publisher.test',
      12,
    );
  });

  it('dispatches GROUP_MEMBER_PROFILE through the group publisher namespace', async () => {
    const { subject, profiles } = createSubject({
      namespaceDomain: 'group-origin.test',
    });
    profiles.fetchExactGroupMemberProfile.mockResolvedValue(wireProfile);
    profiles.getStoredProfile.mockResolvedValue(wireProfile);
    const demand = {
      publisherNamespaceId: 7,
      lookup: ProfileLookup.GROUP_MEMBER_PROFILE,
      target: accountDemand.target,
      groupAccount: '!group',
    } as const;

    await subject['fetch'](
      {
        publisherNamespaceId: 7,
        profileNamespaceId: 12,
        account: 'alice',
        domain: 'member.test',
        rev: 4,
      },
      demand,
    );

    expect(profiles.fetchExactGroupMemberProfile).toHaveBeenCalledWith(
      '!group',
      'member.test',
      'alice',
      4,
      'group-origin.test',
      12,
    );
  });

  it('authorizes account profiles by exact established pair or visible history', async () => {
    const { subject, database } = createSubject();

    await subject['authorizeAccountDemand'](3, accountDemand);

    const statement = database.db.execute.mock.calls[0][0] as SQL;
    const query = new PgDialect().sqlToQuery(statement).sql;
    expect(query).toContain("pair.kind = 'P2P'");
    expect(query).toContain('pair.established = true');
    expect(query).toMatch(
      /pair\."endpointAAccount" = self\.account[\s\S]+pair\."endpointBAccount" = \$\d+/,
    );
    expect(query).toContain('message.seq > COALESCE(thread."clearedSeq", 0)');
    expect(query).toContain('message.seq <= state."messageEndSeq"');
    expect(query).toContain('message."sourceNamespaceId"');
    expect(query).toContain('message."profileNamespaceId"');
    expect(query).toContain('message."localState" = \'READY\'');
    expect(query).not.toContain('message."isDeleted"');
  });

  it('requires exact namespace/revision matches for local disclosure proofs', async () => {
    const { subject, database } = createSubject();

    await subject['authorizeGroupMemberDemand'](
      3,
      {
        publisherNamespaceId: 7,
        lookup: ProfileLookup.GROUP_MEMBER_PROFILE,
        target: accountDemand.target,
        groupAccount: '!team',
      },
      'publisher.test',
    );
    let query = new PgDialect().sqlToQuery(
      database.db.execute.mock.calls.at(-1)![0] as SQL,
    ).sql;
    expect(query).toContain("latest.body ->> 'profileNamespaceId'");
    expect(query).toContain("latest.body ->> 'profileRev'");
    expect(query).toContain('message."localState" = \'READY\'');
    expect(query).not.toContain('message."isDeleted"');

    await subject['authorizeIntentDemand'](3, {
      publisherNamespaceId: 7,
      lookup: ProfileLookup.RELATIONSHIP_INTENT_PROFILE,
      target: accountDemand.target,
      peerAccount: 'bob',
    });
    query = new PgDialect().sqlToQuery(
      database.db.execute.mock.calls.at(-1)![0] as SQL,
    ).sql;
    expect(query).toContain('intent."profileNamespaceId"');
    expect(query).toContain('intent."profileRev"');
    expect(query).toContain('pair."endpointAAccount" = self.account');
    expect(query).toContain('pair."endpointANamespaceId" = 0');

    await subject['authorizeAccountDemand'](3, {
      ...accountDemand,
      target: { ...accountDemand.target, account: '!team' },
    });
    query = new PgDialect().sqlToQuery(
      database.db.execute.mock.calls.at(-1)![0] as SQL,
    ).sql;
    expect(query).toContain("latest.body ->> 'profileNamespaceId'");
    expect(query).toContain("latest.body ->> 'profileRev'");
    expect(query).toContain('thread."authorityNamespaceId"');
  });

  it('registers only the invoking session and deduplicates it per exact key', async () => {
    const { subject } = createSubject();
    vi.spyOn(subject as never, 'authorizeDemand').mockResolvedValue(undefined);
    vi.spyOn(subject as never, 'drain').mockImplementation(() => undefined);

    await subject.start(3, 41, accountDemand);
    await subject.start(3, 41, accountDemand);

    const pending = subject['pending'].values().next().value!;
    expect(pending.listeners).toEqual(new Set([41]));
    expect(pending.demand).toEqual(accountDemand);
  });

  it('keeps different sessions of one user as independent listeners', async () => {
    const { subject } = createSubject();
    vi.spyOn(subject as never, 'authorizeDemand').mockResolvedValue(undefined);
    vi.spyOn(subject as never, 'drain').mockImplementation(() => undefined);

    await subject.start(3, 41, accountDemand);
    await subject.start(3, 42, accountDemand);

    const pending = subject['pending'].values().next().value!;
    expect(pending.listeners).toEqual(new Set([41, 42]));
  });

  it('warns and fails new profile work when the pending queue is full', async () => {
    const { subject } = createSubject();
    const warn = vi
      .spyOn(subject['logger'], 'warn')
      .mockImplementation(() => undefined);
    vi.spyOn(subject as never, 'authorizeDemand').mockResolvedValue(undefined);
    vi.spyOn(subject['pending'], 'size', 'get').mockReturnValue(1000);

    await expect(subject.start(3, 41, accountDemand)).rejects.toMatchObject({
      bizCode: BusinessCode.PROFILE_RESOLUTION_CAPACITY,
    });
    expect(warn).toHaveBeenCalledWith('profile resolution queue is full');
  });

  it('queues internal prefetch without a session listener or SSE delivery', async () => {
    const { subject, sse } = createSubject();
    vi.spyOn(subject as never, 'drain').mockImplementation(() => undefined);

    await subject.resolveDemand(accountDemand);

    const pending = subject['pending'].values().next().value!;
    expect(pending.listeners).toEqual(new Set());
    expect(pending.demand).toEqual(accountDemand);
    expect(sse.onProfileAvailable).not.toHaveBeenCalled();
    expect(sse.onProfileUnavailable).not.toHaveBeenCalled();
  });

  it('does not enqueue namespace-zero work', async () => {
    const { subject } = createSubject();
    const drain = vi.spyOn(subject as never, 'drain');

    await subject.resolveDemand({
      ...accountDemand,
      publisherNamespaceId: 0,
      target: {
        ...accountDemand.target,
        profileNamespaceId: 0,
        domain: 'local',
      },
    });

    expect(subject['pending'].size).toBe(0);
    expect(drain).not.toHaveBeenCalled();
  });

  it('notifies each exact-key session only after the materialized profile is durable', async () => {
    const order: string[] = [];
    let releaseFetch!: (profile: typeof wireProfile) => void;
    const fetched = new Promise<typeof wireProfile>((resolve) => {
      releaseFetch = resolve;
    });
    const { subject, profiles, sse } = createSubject();
    profiles.fetchExactAccountProfile.mockReturnValue(fetched);
    profiles.materializeExactForeignProfile.mockImplementation(async () => {
      order.push('materialized');
    });
    profiles.getStoredProfile
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(null)
      .mockImplementation(async () => {
        order.push('read-durable');
        return wireProfile;
      });
    sse.onProfileAvailable.mockImplementation(() => {
      order.push('sse');
    });
    vi.spyOn(subject as never, 'authorizeDemand').mockResolvedValue(undefined);

    await subject.start(3, 41, accountDemand);
    await subject.start(3, 42, accountDemand);
    releaseFetch(wireProfile);
    await vi.waitFor(() =>
      expect(sse.onProfileAvailable).toHaveBeenCalledTimes(2),
    );

    expect(order.indexOf('materialized')).toBeLessThan(order.indexOf('sse'));
    expect(order.indexOf('read-durable')).toBeLessThan(order.indexOf('sse'));
    expect(sse.onProfileAvailable.mock.calls).toEqual([
      [
        41,
        {
          publisherNamespaceId: 7,
          profileNamespaceId: 12,
          account: 'alice',
          domain: 'member.test',
          rev: 4,
        },
      ],
      [
        42,
        {
          publisherNamespaceId: 7,
          profileNamespaceId: 12,
          account: 'alice',
          domain: 'member.test',
          rev: 4,
        },
      ],
    ]);
  });

  it('keeps snapshot-only prefetch in the profile resolution queue only', async () => {
    const { subject } = createSubject();
    await subject.resolveDemand(accountDemand);

    expect(subject['pending'].size).toBe(1);
  });

  it('touches the profile LRU immediately after a successful fetch result', async () => {
    const { subject, profiles } = createSubject();
    profiles.fetchExactAccountProfile.mockResolvedValue(wireProfile);
    profiles.getStoredProfile.mockResolvedValue(wireProfile);

    await subject['fetch'](
      {
        publisherNamespaceId: 7,
        profileNamespaceId: 12,
        account: 'alice',
        domain: 'member.test',
        rev: 4,
      },
      accountDemand,
    );

    expect(subject['cache'].get('[7,12,"alice","member.test",4]')).toEqual({
      publisherNamespaceId: 7,
      profileNamespaceId: 12,
      account: 'alice',
      domain: 'member.test',
      rev: 4,
      name: 'Alice',
      bio: 'Biography',
      avatarBase64: null,
    });
  });
});
