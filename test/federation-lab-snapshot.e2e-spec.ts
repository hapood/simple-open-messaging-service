import { afterAll, beforeAll, expect, it } from 'vitest';
import { Client } from 'pg';

// Load the same plain-JavaScript readers used by the standalone lab runner.
const readerPath = '../dev/federation-lab/p2p/final-audit.mjs';
const { readFederationAuditSnapshot, profileKey } = await import(readerPath);
const client = new Client({ connectionString: process.env.DATABASE_URL });
const node = { name: 'alpha', domain: '' };

beforeAll(async () => {
  await client.connect();
  const home = await client.query(
    'SELECT domain FROM "IdentityNamespace" WHERE id = 0',
  );
  node.domain = home.rows[0].domain;
  await client.query(`
    INSERT INTO "IdentityNamespace" (id, domain, "rootPublicKey", "identityPinnedAt")
      VALUES (91, 'bravo.test', 'test-key-bravo', now()),
             (92, 'charlie.test', 'test-key-charlie', now());
    INSERT INTO "Account" (id, account) VALUES (101, 'owner');
    INSERT INTO "GroupAccount" (id, account, "defaultProfileRev") VALUES (201, '!native', 1);
    INSERT INTO "MessageThread" (id, type, "updatedAt", "groupAccount", "groupDomain", "groupAccountId", "authorityNamespaceId")
      VALUES (301, 'GROUP', now(), '!native', 'local', 201, 0),
             (302, 'GROUP', now(), '!mirror', 'bravo.test', NULL, 91),
             (303, 'P2P', now(), NULL, NULL, NULL, 0);
    INSERT INTO "Profile" ("publisherNamespaceId", account, "profileNamespaceId", "profileRev", "displayName", bio)
      VALUES (0, '!native', 0, 1, 'Native group', 'Native bio'),
             (91, '!mirror', 91, 2, 'Mirror group', 'Mirror bio'),
             (91, 'remote', 91, 1, 'Direct profile', ''),
             (92, 'remote', 91, 1, 'Relayed profile', '');
    INSERT INTO "GroupMeta" ("threadId", "metaEndId", "profileRev") VALUES (301, 1, 1), (302, 1, 2);
    INSERT INTO "GroupMetaMemberFeed" ("threadId", "feedId", "memberAccount", "profileNamespaceId", operation, body)
      VALUES (301, 1, 'owner', 0, 'MEMBER_UPSERT', '{"role":"OWNER","profileRev":1}'),
             (302, 1, 'remote', 91, 'MEMBER_UPSERT', '{"role":"MEMBER","profileRev":1}');
    INSERT INTO "RelationshipPair" (id, kind, "endpointAType", "endpointAAccount", "endpointANamespaceId",
      "endpointBType", "endpointBAccount", "endpointBNamespaceId", "threadId", active)
      VALUES (401, 'P2P', 'USER', 'owner', 0, 'USER', 'remote', 91, 303, true);
    INSERT INTO "RelationshipIntent" ("authorAccount", "authorNamespaceId", "receiverAccount", "receiverNamespaceId",
      status, "profileNamespaceId", "profileRev", "requestedAt", "messageEndSeq", "tombstoneEndSeq")
      VALUES ('remote', 91, 'owner', 0, 'ACCEPTED', 91, 1, now(), 0, 0);
    INSERT INTO "GroupRequestProjection" ("threadId", "memberAccount", "profileNamespaceId",
      "memberProfileRev", direction, "feedId", status, "requestedAt", "expiresAt")
      VALUES (301, 'remote', 91, 1, 'APPLICATION', 1, 'REQUESTED', now(), now() + interval '1 day');
    INSERT INTO "Message" ("threadId", seq, "contentType", content, "updatedAt", "creatorAccount", "profileNamespaceId", "profileRev", "payloadDigest")
      VALUES (302, 1, 'PURE_TEXT', '{"text":"group"}', now(), 'remote', 91, 1, repeat('a', 64)),
             (303, 1, 'PURE_TEXT', '{"text":"p2p"}', now(), 'owner', 0, 1, repeat('b', 64));
  `);
});
afterAll(async () => client.end());

it('reads local groups, mirrors, addressed members and separate P2P evidence on the migrated schema', async () => {
  const snapshot = await readFederationAuditSnapshot(
    new Map([['alpha', { node, client }]]),
    {
      users: [`owner@${node.domain}`, 'remote@bravo.test'],
      groups: [
        { address: `!native@${node.domain}` },
        { address: '!mirror@bravo.test' },
      ],
      operations: [],
    },
    { readMediaBytes: false },
  );
  const groups = snapshot.groups.alpha.groups;
  expect(groups.get(`!native@${node.domain}`)).toMatchObject({
    groupId: 301,
    threadId: 301,
    name: 'Native group',
    description: 'Native bio',
    defaultProfileRev: 1,
    requests: [
      {
        memberAddress: 'remote@bravo.test',
        feedId: 1,
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
    messages: [{ profileNamespaceId: 91 }],
  });
  expect(groups.get('!mirror@bravo.test').roster).toHaveLength(1);
  expect(snapshot.groups.alpha.users.get('remote@bravo.test')).toMatchObject({
    id: null,
    account: 'remote',
  });
  expect([...snapshot.messages.alpha.keys()]).toEqual([
    `!native@${node.domain}`,
    '!mirror@bravo.test',
  ]);
  expect(
    snapshot.messages.alpha.get('!mirror@bravo.test').messages,
  ).toHaveLength(1);
  expect([...snapshot.p2pMessages.alpha.keys()]).toEqual([
    `owner@${node.domain}|remote@bravo.test`,
  ]);
  // Direct and relayed storage collapse into one subject entry per
  // (address, profileRev, subject namespace); the later publisher copy wins.
  expect(
    snapshot.profiles.alpha.versions.get(
      profileKey('remote@bravo.test', 1, 91),
    ),
  ).toMatchObject({ displayName: 'Relayed profile' });
  expect(snapshot.profiles.alpha.versions.size).toBe(2);
  expect(snapshot.profiles.alpha.intentRefs[0]).toMatchObject({
    address: 'remote@bravo.test',
    namespaceId: 91,
  });
});
