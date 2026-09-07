import { readFile } from 'node:fs/promises';
import { Client } from 'pg';
import { expect, it } from 'vitest';

it('repairs both directional snapshots from the namespace-scoped peer intent and advances the feed', async () => {
  const client = new Client({ connectionString: process.env.DATABASE_URL });
  await client.connect();
  try {
    await client.query(`
      CREATE TEMP TABLE "User" (id integer, account text, domain text, "namespaceId" integer);
      CREATE TEMP TABLE "Account" (id integer, "stateFeedAllocatedThrough" integer, "updatedAt" timestamptz);
      CREATE TEMP TABLE "ClientStateFeed" (id integer, "userId" integer, body jsonb, "namespaceId" integer, "eventType" text, "feedId" integer, "updatedAt" timestamptz);
      CREATE TEMP TABLE "RelationshipPair" (id integer, kind text, "endpointAAccount" text, "endpointADomain" text, "endpointANamespaceId" integer, "endpointBAccount" text, "endpointBDomain" text, "endpointBNamespaceId" integer);
      CREATE TEMP TABLE "RelationshipIntent" ("pairId" integer, "authorSide" text, "profileRev" integer);
      CREATE TEMP TABLE "ProfileVersion" ("userId" integer, "profileRev" integer, "displayName" text, avatar text, bio text);
      INSERT INTO "User" VALUES (1, 'alice', 'local', 0), (2, 'bob', 'remote.test', 4), (3, 'bob', 'remote.test', 9);
      INSERT INTO "Account" VALUES (1, 20, CURRENT_TIMESTAMP);
      INSERT INTO "RelationshipPair" VALUES (1, 'P2P', 'alice', 'local.test', 0, 'bob', 'remote.test', 4), (2, 'P2P', 'alice', 'local.test', 0, 'bob', 'remote.test', 9);
      INSERT INTO "RelationshipIntent" VALUES (1, 'A', 9), (1, 'B', 3), (2, 'B', 99);
      INSERT INTO "ProfileVersion" VALUES (2, 3, 'Intent profile', 'selected-avatar', 'selected bio'), (2, 9, 'Default profile', 'wrong', ''), (3, 99, 'Wrong namespace', 'wrong', '');
      INSERT INTO "ClientStateFeed" VALUES
        (1, 1, '{"direction":"OUTGOING","peer":{"account":"bob","domain":"remote.test","profileRev":9,"name":"Default"}}', 4, 'RELATIONSHIP_INTENT', 10, CURRENT_TIMESTAMP),
        (2, 1, '{"direction":"INCOMING","peer":{"account":"bob","domain":"remote.test","profileRev":0,"name":"bob"}}', 4, 'RELATIONSHIP_INTENT', 11, CURRENT_TIMESTAMP);
    `);
    const migration = await readFile(
      'database/migrations/0002_peer_intent_profile_projection.sql',
      'utf8',
    );
    await client.query(migration);
    const rows = (
      await client.query(
        'SELECT body, "feedId" FROM "ClientStateFeed" ORDER BY id',
      )
    ).rows;
    expect(rows.map((row) => row.feedId)).toEqual([21, 22]);
    for (const row of rows)
      expect(row.body.peer).toMatchObject({
        profileRev: 3,
        name: 'Intent profile',
        avatar: 'selected-avatar',
        bio: 'selected bio',
      });
    await client.query(migration);
    expect(
      (await client.query('SELECT "stateFeedAllocatedThrough" FROM "Account"'))
        .rows[0].stateFeedAllocatedThrough,
    ).toBe(22);
  } finally {
    await client.end();
  }
});
