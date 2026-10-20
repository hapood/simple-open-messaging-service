import { PgDialect } from 'drizzle-orm/pg-core';
import { describe, expect, it } from 'vitest';
import { groupMembershipRevocationSql } from './group-membership-revocation-sql.js';

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
    // PostgreSQL cannot infer the type of bare bind parameters passed to
    // polymorphic jsonb_build_object. The type casts are required even when
    // the values are strings and integers in JavaScript.
    expect(sql).toMatch(
      /jsonb_build_object\('type', 'GROUP_LEFT', 'member',\s+jsonb_build_object\(\s*'account', \$\d+::text,\s*'publisherNamespaceId', (?:0|\$\d+::integer),\s*'profileNamespaceId',/,
    );
  });
});
