import { afterAll, beforeAll, expect, it } from 'vitest';
import { Client } from 'pg';

// Load the same plain-JavaScript readers used by the standalone lab runner.
const readerPath = '../dev/federation-lab/p2p/final-audit.mjs';
const { readFederationAuditSnapshot, profileKey } = await import(readerPath);
const client = new Client({ connectionString: process.env.DATABASE_URL });
const node = { name: 'alpha', domain: 'alpha.test' };

beforeAll(async () => {
  await client.connect();
  await client.query(`
    INSERT INTO "IdentityNamespace" (id, domain, "rootKeyFingerprint", "rootPublicKey", "identityPinnedAt")
      VALUES (91, 'bravo.test', 'test-bravo', 'test-key', now()),
             (92, 'charlie.test', 'test-charlie', 'test-key', now());
    INSERT INTO "Account" (id, account) VALUES (101, 'owner');
    INSERT INTO "GroupAccount" (id, account, "defaultProfileRev") VALUES (201, '!native', 1);
    INSERT INTO "MessageThread" (id, type, "updatedAt", "groupAccount", "groupDomain", "groupAccountId", "authorityNamespaceId")
      VALUES (301, 'GROUP', now(), '!native', 'local', 201, 0),
             (302, 'GROUP', now(), '!mirror', 'bravo.test', NULL, 91),
             (303, 'P2P', now(), NULL, NULL, NULL, 0);
    INSERT INTO "Profile" (account, domain, "namespaceId", "profileRev", "displayName", bio)
      VALUES ('!native', 'local', 0, 1, 'Native group', 'Native bio'),
             ('!mirror', 'bravo.test', 91, 2, 'Mirror group', 'Mirror bio'),
             ('remote', 'bravo.test', 91, 1, 'Direct profile', ''),
             ('remote', 'bravo.test', 92, 1, 'Relayed profile', '');
    INSERT INTO "GroupMetaProfileFeed" ("threadId", "feedId", "profileRev") VALUES (302, 1, 2);
    INSERT INTO "GroupMetaMemberFeed" ("threadId", "feedId", "memberAccount", "memberDomain", "memberNamespaceId", operation, body)
      VALUES (301, 1, 'owner', 'local', 0, 'UPSERT', '{"role":"OWNER","profileRev":1}'),
             (302, 1, 'remote', 'bravo.test', 91, 'UPSERT', '{"role":"MEMBER","profileRev":1}'),
             (302, 2, 'departed', 'bravo.test', 91, 'UPSERT', '{"role":"MEMBER","profileRev":1}'),
             (302, 3, 'departed', 'bravo.test', 91, 'DEPART', '{}');
    INSERT INTO "RelationshipPair" (id, kind, "endpointAType", "endpointAAccount", "endpointADomain", "endpointANamespaceId",
      "endpointBType", "endpointBAccount", "endpointBDomain", "endpointBNamespaceId", "threadId", active)
      VALUES (401, 'P2P', 'USER', 'owner', 'local', 0, 'USER', 'remote', 'bravo.test', 91, 303, true);
    INSERT INTO "RelationshipIntent" ("pairId", "authorSide", status, "profileRev", "requestedAt")
      VALUES (401, 'B', 'ACCEPTED', 1, now());
    INSERT INTO "GroupRequestProjection" ("managerUserId", "threadId", "memberAccount", "memberDomain", "memberNamespaceId",
      "memberProfileRev", direction, "feedId", "requestId", status, "requestedAt", "expiresAt")
      VALUES (101, 301, 'remote', 'bravo.test', 91, 1, 'APPLICATION', 1, 501, 'REQUESTED', now(), now() + interval '1 day');
    INSERT INTO "Message" ("threadId", seq, "contentType", content, "updatedAt", "creatorAccount", "creatorDomain", "creatorNamespaceId", "profileRev")
      VALUES (302, 1, 'PURE_TEXT', '{"text":"group"}', now(), 'remote', 'bravo.test', 91, 1),
             (303, 1, 'PURE_TEXT', '{"text":"p2p"}', now(), 'owner', 'local', 0, 1);
  `);
});
afterAll(async () => client.end());

it('reads local groups, mirrors, addressed members and separate P2P evidence on the migrated schema', async () => {
  const snapshot = await readFederationAuditSnapshot(
    new Map([['alpha', { node, client }]]),
    {
      users: ['owner@alpha.test', 'remote@bravo.test'],
      groups: [
        { address: '!native@alpha.test' },
        { address: '!mirror@bravo.test' },
      ],
      operations: [],
    },
    { readMediaBytes: false },
  );
  const groups = snapshot.groups.alpha.groups;
  expect(groups.get('!native@alpha.test')).toMatchObject({
    groupId: 301,
    threadId: 301,
    name: 'Native group',
    description: 'Native bio',
    defaultProfileRev: 1,
    requests: [
      {
        managerAddress: 'owner@alpha.test',
        memberAddress: 'remote@bravo.test',
        requestId: '501',
      },
    ],
  });
  expect(groups.get('!mirror@bravo.test')).toMatchObject({
    groupId: 302,
    threadId: 302,
    namespaceId: 91,
    name: 'Mirror group',
    defaultProfileRev: 2,
    roster: [{ address: 'remote@bravo.test', namespaceId: 91, role: 'MEMBER' }],
    messages: [{ creatorNamespaceId: 91 }],
  });
  expect(groups.get('!mirror@bravo.test').roster).toHaveLength(1);
  expect(snapshot.groups.alpha.users.get('remote@bravo.test')).toMatchObject({
    id: null,
    account: 'remote',
  });
  expect([...snapshot.messages.alpha.keys()]).toEqual([
    '!native@alpha.test',
    '!mirror@bravo.test',
  ]);
  expect(
    snapshot.messages.alpha.get('!mirror@bravo.test').messages,
  ).toHaveLength(1);
  expect([...snapshot.p2pMessages.alpha.keys()]).toEqual([
    'owner@alpha.test|remote@bravo.test',
  ]);
  expect(
    snapshot.profiles.alpha.versions.get(profileKey('remote@bravo.test', 1, 91))
      .displayName,
  ).toBe('Direct profile');
  expect(
    snapshot.profiles.alpha.versions.get(profileKey('remote@bravo.test', 1, 92))
      .displayName,
  ).toBe('Relayed profile');
  expect(snapshot.profiles.alpha.intentRefs[0]).toMatchObject({
    address: 'remote@bravo.test',
    namespaceId: 91,
  });
});
