import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Test } from '@nestjs/testing';
import type { TestingModule } from '@nestjs/testing';
import { DatabaseModule } from '../src/database/database.module.js';
import { DatabaseService } from '../src/database/database.service.js';

const DOMAIN_PREFIX = 'trust-level-check-';

describe('IdentityNamespace peer-state schema', () => {
  let database: DatabaseService;
  let mod: TestingModule;

  beforeAll(async () => {
    mod = await Test.createTestingModule({
      imports: [DatabaseModule],
    }).compile();
    database = mod.get(DatabaseService);
  });

  afterAll(async () => {
    await database.pool.query(
      'DELETE FROM "IdentityNamespace" WHERE domain LIKE $1',
      [`${DOMAIN_PREFIX}%`],
    );
    await mod.close();
  });

  it('installs the supported trust-level set', async () => {
    const result = await database.pool.query<{ definition: string }>(
      `SELECT pg_get_constraintdef(oid) AS definition
       FROM pg_constraint
       WHERE conname = 'IdentityNamespace_trustLevel_check'`,
    );

    expect(result.rows).toHaveLength(1);
    for (const trustLevel of [
      'unrecognized',
      'establishing',
      'pending',
      'available',
      'degraded',
      'halted',
    ]) {
      expect(result.rows[0].definition).toContain(trustLevel);
    }
  });

  it('rejects an unsupported trust level', async () => {
    await expect(
      database.pool.query(
        'INSERT INTO "IdentityNamespace" (domain, "rootPublicKey", "identityPinnedAt", "trustLevel") VALUES ($1, $2, NOW(), $3)',
        [
          `${DOMAIN_PREFIX}invalid.test`,
          Buffer.alloc(32, 1).toString('base64'),
          'unknown',
        ],
      ),
    ).rejects.toMatchObject({
      code: '23514',
      constraint: 'IdentityNamespace_trustLevel_check',
    });
  });

  it('removes obsolete federation identity tables and columns', async () => {
    const [nonceTable, peerTable, column] = await Promise.all([
      database.pool.query<{ relation: string | null }>(
        `SELECT to_regclass('public."S2SIdentityNonce"')::text AS relation`,
      ),
      database.pool.query<{ relation: string | null }>(
        `SELECT to_regclass('public."FederatedPeer"')::text AS relation`,
      ),
      database.pool.query<{ column_name: string }>(
        `SELECT column_name
         FROM information_schema.columns
         WHERE table_schema = 'public'
           AND table_name = 'IdentityNamespace'
           AND column_name = 'pairwiseServerId'`,
      ),
    ]);

    expect(nonceTable.rows[0]?.relation).toBeNull();
    expect(peerTable.rows[0]?.relation).toBeNull();
    expect(column.rows).toEqual([]);
  });
});
