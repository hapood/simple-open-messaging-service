import { describe, expect, it } from 'vitest';
import { PgDialect } from 'drizzle-orm/pg-core';
import { mirrorMembershipActivationSql } from './mirror-membership-acceptance-sql.js';

describe('mirror group membership activation profile selection', () => {
  it('initializes the local member from the group-authored intent until Meta selects a different revision', () => {
    const statement = new PgDialect().sqlToQuery(
      mirrorMembershipActivationSql({
        threadId: 9,
        pairId: 4n,
        presentation: {
          groupAccount: '!group',
          groupDomain: 'origin.example',
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
        persistStatus: 'ACCEPTED',
        promote: false,
      }),
    );
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
