import { PgDialect } from 'drizzle-orm/pg-core';
import { describe, expect, it } from 'vitest';
import { groupMembershipRevocationSql } from './group-membership-revocation-sql.js';

describe('group departure system message SQL', () => {
  it.each(['A', 'B'] as const)(
    'types JSON participant parameters for side %s',
    (authorSide) => {
      const { sql } = new PgDialect().sqlToQuery(
        groupMembershipRevocationSql({
          threadId: 41,
          pairId: 60n,
          groupAccount: '!test',
          groupName: 'Group',
          groupAvatar: '',
          groupDescription: '',
          groupProfileRev: 1,
          localDomain: 'local',
          memberAccount: 'alice',
          memberDomain: 'local',
          memberNamespaceId: 0,
          localMemberId: 11,
          projectionDirections: [],
          authorSide,
        }),
      );
      // PostgreSQL cannot infer the type of bare bind parameters passed to
      // polymorphic jsonb_build_object. The type casts are required even when
      // the values are strings and integers in JavaScript.
      expect(sql).toMatch(
        /jsonb_build_object\('type', 'GROUP_LEFT', 'member',\s+jsonb_build_object\('account', \$\d+::text,\s+'domain', \$\d+::text,\s+'namespaceId', \$\d+::integer,/,
      );
    },
  );
});
