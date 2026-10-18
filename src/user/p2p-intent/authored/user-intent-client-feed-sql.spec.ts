import { describe, expect, it } from 'vitest';
import { PgDialect } from 'drizzle-orm/pg-core';
import { userIntentClientBodiesSql } from './user-intent-client-feed-sql.js';

describe('P2P client intent presentation', () => {
  it('pins outgoing peer references while retaining incoming author evidence and body deduplication', () => {
    const { sql } = new PgDialect().sqlToQuery(
      userIntentClientBodiesSql({
        pairId: 1n,
        threadId: 7,
        namespaceId: 2,
        actorKey: 'bob-to-alice',
        targetKey: 'alice-to-bob',
        actorAccount: 'bob',
        actorNamespaceId: 2,
        targetAccount: 'alice',
        targetNamespaceId: 0,
        ownState: 'revocation',
        requestRevocation: true,
      }),
    );
    expect(sql).toMatch(
      /'profileRev', CASE WHEN cp.direction = 'OUTGOING'\s+THEN 0 ELSE cp\."clientPeerProfileRev" END/,
    );
    expect(sql).toContain("jsonb_build_object('snapshot', cp.snapshot)");
    expect(sql).toContain('f.body = b.body');
    expect(sql).toContain("b.body->>'status' = 'REVOKED'");
  });
});
