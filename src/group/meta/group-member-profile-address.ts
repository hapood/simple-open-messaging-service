import { sql, type SQL } from 'drizzle-orm';

export interface GroupMemberProfileAddress {
  account: string;
  publisherNamespaceId: number;
  profileNamespaceId: number;
  profileRev: number;
}

/** Build the profile coordinate used by both group join and group leave events.
 * The publisher coordinate identifies the group publisher from the receiving
 * server's perspective; the member coordinate remains in that publisher's
 * namespace and is never re-keyed locally. */
export function groupMemberProfileAddress(input: {
  account: string;
  publisherNamespaceId: number;
  profileNamespaceId: number;
  profileRev: number;
}): GroupMemberProfileAddress {
  return { ...input };
}

/** SQL equivalent used by the composed join/leave writers. */
export function groupMemberProfileAddressSql(input: {
  account: SQL;
  publisherNamespaceId: SQL;
  profileNamespaceId: SQL;
  profileRev: SQL;
}): SQL {
  return sql`jsonb_build_object(
    'account', ${input.account},
    'publisherNamespaceId', ${input.publisherNamespaceId},
    'profileNamespaceId', ${input.profileNamespaceId},
    'profileRev', ${input.profileRev}
  )`;
}
