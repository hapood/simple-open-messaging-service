import { describe, expect, it } from 'vitest';
import { PgDialect } from 'drizzle-orm/pg-core';
import {
  mirrorMembershipActivationIntentWrite,
  mirrorMembershipActivationSql,
} from './mirror-membership-acceptance-sql.js';

describe('mirror group membership activation profile selection', () => {
  it('writes the side A wire row separately and reads it back from the table', () => {
    const input = {
      threadId: 9,
      pairId: 4n,
      presentation: {
        groupAccount: '!group',
        groupNamespaceId: 3,
      },
      memberAccount: 'alice',
      localMemberId: 5,
      intent: {
        profileNamespaceId: 0,
        profileRev: 6,
        note: '',
        requestedAt: null,
        expiresAt: null,
        messageEndSeq: 0,
        tombstoneEndSeq: 0,
      },
      persistStatus: 'ACCEPTED' as const,
    };
    const write = new PgDialect().sqlToQuery(
      mirrorMembershipActivationIntentWrite(input),
    );
    // The wire write is the only intent write; the domain statement reads the
    // row back instead of embedding it.
    expect(write.sql).toContain('INSERT INTO "RelationshipIntent"');
    const statement = new PgDialect().sqlToQuery(
      mirrorMembershipActivationSql(input),
    );
    expect(statement.sql).not.toContain('INSERT INTO "RelationshipIntent"');
    expect(statement.sql).toContain('"threadProfileRev", "profileSourceId"');
    expect(statement.sql).toContain('v."profileRev", NULL');
    expect(statement.sql).toContain('CROSS JOIN persisted_intent v');
    expect(statement.sql).toContain(
      '"profileSourceId" = EXCLUDED."profileSourceId"',
    );
    expect(statement.sql).toContain('CROSS JOIN pair_change');
    expect(statement.sql).not.toContain('group_profile_source');
  });
});
