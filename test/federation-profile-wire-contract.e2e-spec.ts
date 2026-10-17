import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { and, eq, isNull } from 'drizzle-orm';
import {
  bootFederationPair,
  makeInMemoryKeypair,
  FED_DOMAIN_A,
  FED_DOMAIN_B,
  type FedApp,
  type S2sProxy,
} from './federation-harness.js';
import {
  establishFederatedFriendship,
  registerAndLogin,
  resolveFederatedCard,
} from './federation-test-helpers.js';
import * as tables from '../src/database/schema.js';
import { SignatureService } from '../src/federation/signature.service.js';
import { FederationProfileService } from '../src/federation/federation-profile.service.js';
import { S2sResponseError } from '../src/federation/federation-errors.js';
import { BusinessCode } from '../src/common/business-code.js';
import { assertFederationWireSchema } from './support/federation-wire-schema.js';

/** Actual controller responses cross signed HTTP before the production consumer sees them. */
describe('profile wire contracts across isolated federation servers', () => {
  let appA: FedApp;
  let appB: FedApp;
  let proxy: S2sProxy;
  let consumer: FederationProfileService;
  let publisherNamespaceId: number;
  const owner = 'wirealice';
  const member = 'wirebob';
  const group = '!wireprofiles';
  const signer = new SignatureService(
    makeInMemoryKeypair(FED_DOMAIN_B) as never,
  );
  const observed: string[] = [];

  async function get(path: string, domain: string): Promise<unknown> {
    expect(domain).toBe(FED_DOMAIN_A);
    const url = new URL(path, appA.baseUrl);
    const headers = await signer.signOutbound({ method: 'GET', url, body: '' });
    const response = await fetch(url, { headers });
    const envelope: unknown = await response.json();
    if (
      !envelope ||
      typeof envelope !== 'object' ||
      Array.isArray(envelope) ||
      !('code' in envelope) ||
      typeof envelope.code !== 'number' ||
      !('message' in envelope) ||
      typeof envelope.message !== 'string' ||
      !('data' in envelope)
    ) {
      throw new Error('invalid federation response envelope');
    }
    if (envelope.code !== BusinessCode.OK) {
      throw new S2sResponseError(
        envelope.message,
        response.status,
        envelope.code,
        envelope.data,
      );
    }
    expect(response.status).toBe(200);
    assertFederationWireSchema('urn:somfp:v1:evidence-profile', envelope.data);
    observed.push(url.pathname);
    return envelope.data;
  }

  beforeAll(async () => {
    ({ appA, appB, proxy } = await bootFederationPair());
    const alice = await registerAndLogin(appA, owner, 'Wire Alice');
    const bob = await registerAndLogin(appB, member, 'Wire Bob');
    const card = await resolveFederatedCard(
      appB,
      bob.token,
      owner,
      FED_DOMAIN_A,
    );
    expect(card.event).toBe('resolved');
    await establishFederatedFriendship({
      local: appA,
      remote: appB,
      localUserId: alice.id,
      remoteUserId: bob.id,
      localToken: alice.token,
      remoteToken: bob.token,
      localAccount: owner,
      remoteAccount: member,
      localDomain: FED_DOMAIN_A,
      remoteDomain: FED_DOMAIN_B,
    });
    const publisher = await appB.database.query.identityNamespace.findFirst({
      where: and(
        eq(tables.identityNamespace.domain, FED_DOMAIN_A),
        isNull(tables.identityNamespace.retiredAt),
      ),
    });
    publisherNamespaceId = publisher!.id;
    const peer = await appA.database.query.identityNamespace.findFirst({
      where: and(
        eq(tables.identityNamespace.domain, FED_DOMAIN_B),
        isNull(tables.identityNamespace.retiredAt),
      ),
    });
    const [control] = await appA.database
      .insert(tables.groupAccount)
      .values({ account: group, defaultProfileRev: 1 })
      .returning();
    const [thread] = await appA.database
      .insert(tables.messageThread)
      .values({
        type: 'GROUP',
        groupAccount: group,
        groupDomain: FED_DOMAIN_A,
        groupAccountId: control.id,
        authorityNamespaceId: 0,
        updatedAt: new Date(),
      })
      .returning();
    await appA.database.insert(tables.relationshipPair).values({
      kind: 'GROUP_MEMBER',
      threadId: thread.id,
      active: true,
      established: true,
      endpointAType: 'GROUP',
      endpointAAccount: group,
      endpointANamespaceId: 0,
      endpointBType: 'USER',
      endpointBAccount: member,
      endpointBNamespaceId: peer!.id,
    });
    await appA.database.insert(tables.relationshipIntent).values({
      authorAccount: group,
      authorNamespaceId: 0,
      receiverAccount: member,
      receiverNamespaceId: peer!.id,
      profileNamespaceId: 0,
      status: 'ACCEPTED',
      messageEndSeq: 0,
      tombstoneEndSeq: 0,
      profileRev: 1,
      note: '',
      requestedAt: new Date(),
      expiresAt: null,
    });
    await appA.database.insert(tables.groupMetaMemberFeed).values({
      threadId: thread.id,
      feedId: 1,
      operation: 'MEMBER_UPSERT',
      body: { account: owner, namespaceId: 0, role: 'OWNER', profileRev: 1 },
    });
    consumer = new FederationProfileService(
      { db: appB.database } as never,
      {} as never,
      { get } as never,
      {} as never,
      {} as never,
    );
  }, 120_000);

  afterAll(async () => {
    await appA?.close();
    await appB?.close();
    await proxy?.close();
  });

  it('validates the actual possession-proof response consumed by public card resolution', async () => {
    const responses = proxy
      .requestLog()
      .filter(
        (entry) =>
          entry.status === 200 &&
          new URL(entry.path, appA.baseUrl).pathname ===
            `/s2s/v1/accounts/${owner}`,
      );
    expect(responses.length).toBeGreaterThan(0);
    for (const response of responses) {
      const envelope = JSON.parse(response.responseBody!);
      expect(envelope.code).toBe(BusinessCode.OK);
      assertFederationWireSchema('urn:somfp:v1:profile', envelope.data);
      expect(envelope.data).toMatchObject({
        account: owner,
        profileRev: 1,
        displayName: 'Wire Alice',
        avatar: null,
      });
    }
    const cached = await appB.database.query.profileTable.findFirst({
      where: and(
        eq(tables.profileTable.publisherNamespaceId, publisherNamespaceId),
        eq(tables.profileTable.profileNamespaceId, 0),
        eq(tables.profileTable.account, owner),
        eq(tables.profileTable.profileRev, 1),
      ),
    });
    expect(cached?.displayName).toBe('Wire Alice');
  });

  it.each(['account', 'group-member'] as const)(
    'validates and materializes an actual exact %s profile response',
    async (kind) => {
      const profile =
        kind === 'account'
          ? await consumer.fetchExactAccountProfile(owner, 1, FED_DOMAIN_A, 0)
          : await consumer.fetchExactGroupMemberProfile(
              group,
              owner,
              1,
              FED_DOMAIN_A,
              0,
            );
      expect(profile).toEqual({
        account: owner,
        namespaceId: 0,
        profileRev: 1,
        displayName: 'Wire Alice',
        avatar: null,
        bio: '',
      });
      await consumer.materializeExactForeignProfile(
        profile!,
        publisherNamespaceId,
      );
      const cached = await appB.database.query.profileTable.findFirst({
        where: and(
          eq(tables.profileTable.publisherNamespaceId, publisherNamespaceId),
          eq(tables.profileTable.profileNamespaceId, 0),
          eq(tables.profileTable.account, owner),
          eq(tables.profileTable.profileRev, 1),
        ),
      });
      expect(cached).toMatchObject({
        account: owner,
        displayName: 'Wire Alice',
        profileRev: 1,
        profileNamespaceId: 0,
      });
      expect(observed.at(-1)).toContain(
        kind === 'account' ? '/account-profiles/' : '/group-member-profiles/',
      );
    },
  );

  it.each([
    ['legacy domain', { domain: FED_DOMAIN_A }],
    ['wrong subject', { account: 'someoneelse' }],
    ['empty name', { displayName: '' }],
    ['non-string bio', { bio: 1 }],
    ['malformed avatar', { avatar: { mimeType: 'image/png' } }],
  ])(
    'rejects a corrupted exact profile (%s) after validating the original producer response',
    async (_name, mutation) => {
      const corrupted = new FederationProfileService(
        { db: appB.database } as never,
        {} as never,
        {
          get: async (path: string, domain: string) => {
            const body = await get(path, domain);
            if (!body || typeof body !== 'object' || Array.isArray(body))
              throw new Error('expected producer object');
            return { ...body, ...mutation };
          },
        } as never,
        {} as never,
        {} as never,
      );
      await expect(
        corrupted.fetchExactAccountProfile(owner, 1, FED_DOMAIN_A, 0),
      ).rejects.toMatchObject({ code: BusinessCode.FEDERATION_MALFORMED });
    },
  );

  it('does not disclose an exact group-member snapshot without a group grant', async () => {
    await expect(
      consumer.fetchExactGroupMemberProfile(
        '!ungranted',
        owner,
        1,
        FED_DOMAIN_A,
        0,
      ),
    ).resolves.toBeNull();
  });
});
