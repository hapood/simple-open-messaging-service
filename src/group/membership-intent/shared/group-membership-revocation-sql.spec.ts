import { PgDialect } from 'drizzle-orm/pg-core';
import { describe, expect, it } from 'vitest';
import {
  groupMembershipRevocationIntentWrite,
  groupMembershipRevocationSql,
} from './group-membership-revocation-sql.js';
import { authoredIntentWriteSql } from '../../../common/sql/authored-relationship-intent-sql.js';

describe('group departure system message SQL', () => {
  it.each([
    {
      label: 'group decision',
      author: { account: '!test', namespaceId: 0 },
      receiver: { account: 'alice', namespaceId: 0 },
    },
    {
      label: 'member decision',
      author: { account: 'alice', namespaceId: 0 },
      receiver: { account: '!test', namespaceId: 0 },
    },
  ])('types JSON participant parameters for $label', ({ author, receiver }) => {
    const { sql } = new PgDialect().sqlToQuery(
      groupMembershipRevocationSql({
        threadId: 41,
        pairId: 60n,
        groupAccount: '!test',
        groupProfileRev: 1,
        memberAccount: 'alice',
        profileNamespaceId: 0,
        localMemberId: 11,
        author,
        receiver,
      }),
    );
    expect(sql).not.toContain('"GroupRequestProjection"');
    expect(sql).not.toContain('"ClientStateFeed"');
    // The domain statement owns group effects only: the intent direction is
    // written beforehand by the shared authored-intent writer.
    expect(sql).not.toContain('INSERT INTO "RelationshipIntent"');
    // PostgreSQL cannot infer the type of bare bind parameters passed to
    // polymorphic jsonb_build_object. The type casts are required even when
    // the values are strings and integers in JavaScript.
    expect(sql).toMatch(
      /jsonb_build_object\('type', 'GROUP_LEFT', 'member',\s+jsonb_build_object\(\s*'account', \$\d+::text,\s*'publisherNamespaceId', (?:0|\$\d+::integer),\s*'profileNamespaceId',/,
    );
  });

  it.each([
    {
      label: 'group decision',
      author: { account: '!test', namespaceId: 0 },
      receiver: { account: 'alice', namespaceId: 0 },
    },
    {
      label: 'member decision',
      author: { account: 'alice', namespaceId: 0 },
      receiver: { account: '!test', namespaceId: 0 },
    },
  ])(
    'routes the authored revocation write through the shared writer for $label',
    ({ author, receiver }) => {
      const { sql } = new PgDialect().sqlToQuery(
        groupMembershipRevocationIntentWrite({
          threadId: 41,
          pairId: 60n,
          groupAccount: '!test',
          groupProfileRev: 1,
          memberAccount: 'alice',
          profileNamespaceId: 0,
          localMemberId: 11,
          author,
          receiver,
        }),
      );
      expect(sql).toContain('INSERT INTO "RelationshipIntent"');
      // The locally derived write is exactly the shared authored writer.
      const shared = new PgDialect().sqlToQuery(
        authoredIntentWriteSql({
          author,
          receiver,
          threadId: 41,
          status: 'REVOKED',
          note: '',
          statusChangedAt: new Date(1000),
          expiresAt: null,
        }),
      );
      expect(sql).toBe(shared.sql);
      expect(sql).not.toContain('"GroupRequestProjection"');
      expect(sql).not.toContain('"ClientStateFeed"');
    },
  );
});
