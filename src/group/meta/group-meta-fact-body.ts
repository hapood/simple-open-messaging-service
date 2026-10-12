import { GroupRole } from '../../database/enums.js';

/**
 * Group Meta fact body. The wire item and the stored row share this exact
 * shape. `namespaceId` is the subject's namespace in the Group Meta
 * publisher's coordinate space; it is never a local IdentityNamespace id on
 * mirror nodes, and the display domain resolves through publisher-scoped
 * namespace bindings, never through this field.
 */
export type GroupMetaFactBody =
  | {
      operation: 'MEMBER_UPSERT';
      account: string;
      namespaceId: number;
      role: GroupRole;
      profileRev: number;
    }
  | {
      operation: 'MEMBER_DEPART';
      account: string;
      namespaceId: number;
      role: GroupRole;
      profileRev: number;
    }
  | {
      operation: 'GROUP_PROFILE';
      namespaceId: number;
      profileRev: number;
    }
  | {
      operation: 'GROUP_ANNOUNCEMENT';
      text: string | null;
    };

/** The stable subject key of an identity-bearing fact body. */
export function groupMetaFactSubjectKey(
  body: Extract<GroupMetaFactBody, { account: string }>,
): { account: string; namespaceId: number } {
  return { account: body.account, namespaceId: body.namespaceId };
}
