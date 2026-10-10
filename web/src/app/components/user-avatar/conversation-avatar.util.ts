import type { ConversationItem } from '../../services/model';
import {
  unevidencedProfileDemand,
  type ProfileDemand,
  type UnevidencedProfileDemand,
} from '../../../../../shared/profile-demand';
import { UserAvatarType } from './model';
import { homeProfileDemand } from '../../services/profile-demand';

/**
 * Derive `<app-user-avatar>` inputs from a {@link ConversationItem}. The single source of truth shared by
 * every surface that renders a conversation avatar (the conversation list, the empty-thread hero, …) so the
 * selected profile evidence stays identical across surfaces, so each surface reads
 * the same digest-addressed avatar bytes.
 *
 * Pure functions (no `this`): safe to assign as component fields for template use, and trivially unit-testable.
 */
export function conversationAvatarType(t: ConversationItem): UserAvatarType {
  return t.type === 'P2P' ? UserAvatarType.OTHER : UserAvatarType.GROUP;
}

export function conversationAvatarAccount(t: ConversationItem): string {
  return t.type === 'P2P' ? t.peerUser.account : t.group.account;
}

export function conversationAvatarNamespaceId(t: ConversationItem): number {
  return t.type === 'P2P' ? t.peerUser.namespaceId : t.group.namespaceId;
}

export function conversationAvatarSrc(
  t: ConversationItem,
): string | null | undefined {
  return t.type === 'P2P' ? t.peerUser.avatar : t.group.avatar;
}

/** Memoized request objects: profile-evidence inputs treat a new reference as
 *  a new demand and re-resolve, so re-evaluations of an unchanged conversation
 *  (every row re-render) must reuse the same object until the request truly
 *  changes — form included. Bounded LRU: a stale subject/revision entry is
 *  inert data. */
const evidenceCache = new Map<
  string,
  ProfileDemand | UnevidencedProfileDemand
>();
const EVIDENCE_CACHE_LIMIT = 256;

/** Thread-projection profile request. A conversation subject's `profileRev`
 *  comes from the thread feed. While the relationship is live
 *  (`conversationState` ACTIVE — friendship established or group membership
 *  active), the row sends an authorized demand: the server re-checks the
 *  relationship and may fetch a missing revision from the federated source.
 *  A severed relationship keeps rendering history through the unevidenced
 *  form: caches only, with the account/address identity as the fallback. */
export function conversationAvatarEvidence(
  t: ConversationItem,
): ProfileDemand | UnevidencedProfileDemand | undefined {
  if (t.profileRev < 1) return undefined;
  const subject = t.type === 'P2P' ? t.peerUser : t.group;
  const authorized = t.conversationState === 'ACTIVE';
  const cacheKey = `${authorized ? 'A' : 'U'}:${subject.account}:${subject.namespaceId}:${t.profileRev}`;
  const cached = evidenceCache.get(cacheKey);
  if (cached) {
    evidenceCache.delete(cacheKey);
    evidenceCache.set(cacheKey, cached);
    return cached;
  }
  const demand = homeProfileDemand(
    subject.account,
    subject.namespaceId,
    t.profileRev,
  );
  const request = authorized
    ? demand
    : unevidencedProfileDemand(demand);
  evidenceCache.set(cacheKey, request);
  if (evidenceCache.size > EVIDENCE_CACHE_LIMIT)
    evidenceCache.delete(evidenceCache.keys().next().value!);
  return request;
}
