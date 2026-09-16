import { and, eq } from 'drizzle-orm';
import { QueryBuilder } from 'drizzle-orm/pg-core';
import { describe, expect, it } from 'vitest';
import { profileTable } from '../../../database/schema.js';
import { groupState, groupStateFields } from './group-state.js';

describe('group presentation joins', () => {
  it('qualifies projected identity and revision when joining an exact profile', () => {
    const query = new QueryBuilder()
      .select({
        group: groupStateFields,
        displayName: profileTable.displayName,
      })
      .from(groupState)
      .innerJoin(
        profileTable,
        and(
          eq(profileTable.account, groupStateFields.account),
          eq(profileTable.domain, groupStateFields.domain),
          eq(profileTable.namespaceId, groupStateFields.namespaceId),
          eq(profileTable.profileRev, groupStateFields.profileRev),
        ),
      )
      .toSQL();
    for (const field of ['account', 'domain', 'namespaceId', 'profileRev']) {
      expect(query.sql).toContain(
        `"Profile"."${field}" = "group_state"."${field}"`,
      );
    }
  });
});
