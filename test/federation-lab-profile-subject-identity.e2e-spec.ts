import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DatabaseService } from '../src/database/database.service.js';
import { profileSubjectIdentityJoins } from '../dev/federation-lab/p2p/profile-subject-identity.mjs';

describe('publisher-scoped audit profile identities', () => {
  let database: DatabaseService;
  beforeAll(() => {
    database = new DatabaseService();
  });
  afterAll(async () => {
    await database.pool.end();
  });

  async function resolve(references: Array<[number, number]>) {
    const client = await database.pool.connect();
    try {
      await client.query('BEGIN READ ONLY');
      const result = await client.query(
        `
        WITH "IdentityNamespace" (id, domain) AS (
          VALUES (0, 'charlie.test'), (1, 'bravo.test'),
            (2, 'alpha.test'), (3, 'other.test')
        ), "ProfileNamespace" ("publisherNamespaceId", "profileNamespaceId", domain) AS (
          VALUES (1, 1, 'alpha.test'), (2, 1, 'bravo.test')
        )
        SELECT input."publisherNamespaceId", input."profileNamespaceId",
          identity.id AS "namespaceId", identity.domain
        FROM jsonb_to_recordset($1::jsonb) AS input(
          "publisherNamespaceId" integer, "profileNamespaceId" integer
        )
        ${profileSubjectIdentityJoins('input."publisherNamespaceId"', 'input."profileNamespaceId"', 'identity')}
        ORDER BY input."publisherNamespaceId", input."profileNamespaceId"
      `,
        [
          JSON.stringify(
            references.map(([publisherNamespaceId, profileNamespaceId]) => ({
              publisherNamespaceId,
              profileNamespaceId,
            })),
          ),
        ],
      );
      return result.rows;
    } finally {
      await client.query('ROLLBACK');
      client.release();
    }
  }

  it('resolves a foreign subject to its local identity without changing captured coordinates', async () => {
    expect(await resolve([[1, 1]])).toEqual([
      {
        publisherNamespaceId: 1,
        profileNamespaceId: 1,
        namespaceId: 2,
        domain: 'alpha.test',
      },
    ]);
  });

  it('keeps native subjects and equal subject ids from different publishers distinct', async () => {
    expect(
      await resolve([
        [0, 0],
        [0, 2],
        [1, 0],
        [1, 1],
        [2, 1],
      ]),
    ).toEqual([
      {
        publisherNamespaceId: 0,
        profileNamespaceId: 0,
        namespaceId: 0,
        domain: 'charlie.test',
      },
      {
        publisherNamespaceId: 0,
        profileNamespaceId: 2,
        namespaceId: 2,
        domain: 'alpha.test',
      },
      {
        publisherNamespaceId: 1,
        profileNamespaceId: 0,
        namespaceId: 1,
        domain: 'bravo.test',
      },
      {
        publisherNamespaceId: 1,
        profileNamespaceId: 1,
        namespaceId: 2,
        domain: 'alpha.test',
      },
      {
        publisherNamespaceId: 2,
        profileNamespaceId: 1,
        namespaceId: 1,
        domain: 'bravo.test',
      },
    ]);
  });

  it('does not guess an unresolved foreign subject from an equal local namespace id', async () => {
    expect(await resolve([[1, 3]])).toEqual([
      {
        publisherNamespaceId: 1,
        profileNamespaceId: 3,
        namespaceId: null,
        domain: null,
      },
    ]);
  });
});
