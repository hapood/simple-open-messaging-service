import type {
  IncomingRequestHead,
  PersonalRequestPage,
  GroupRequestPage,
  RequestDecision,
} from '../../../shared/relationship-request.js';

/** HTTP application boundary. The domain implementation is wired in the next phase.
 * No fallback to address-only request actions or client-derived projections is allowed. */
export abstract class RelationshipRequestService {
  abstract queryPersonal(
    userId: number,
    query: {
      bucket: 'RECEIVED' | 'SENT';
      before?: string;
      take?: number;
    },
  ): Promise<PersonalRequestPage>;
  abstract markRead(
    userId: number,
    requestReadId: string,
  ): Promise<IncomingRequestHead>;
  /** Resolve a member-side group round into its owning group thread. Locating
   * only: decision admission is revalidated under the membership locks. */
  abstract resolveMemberGroupRound(
    userId: number,
    requestId: string,
    decision: RequestDecision,
  ): Promise<
    { status: 'RESOLVED'; threadId: number } | { status: 'STALE_REQUEST' }
  >;
  /** The stored kind of one round by its exact id, or null when absent. The
   * personal decision routes use it to route a round to its owning domain. */
  abstract roundKind(
    requestId: string,
  ): Promise<'FRIEND' | 'GROUP_APPLICATION' | 'GROUP_INVITATION' | null>;
  /** Resolve a manager-side group round for a known group thread. Returns the
   * addressed member endpoint when the round's direction matches the group
   * identity; manager-role authorization stays with the calling guards and
   * the membership state machine's locks. */
  abstract resolveManagerGroupRound(
    userId: number,
    groupId: number,
    requestId: string,
    direction: 'APPLICATION' | 'INVITATION',
  ): Promise<
    | {
        status: 'RESOLVED';
        member: { account: string; namespaceId: number };
      }
    | { status: 'STALE_REQUEST' }
  >;
  abstract queryGroup(
    userId: number,
    groupId: number,
    direction: 'APPLICATION' | 'INVITATION',
    query: {
      before?: string;
      take?: number;
    },
  ): Promise<GroupRequestPage>;
}
