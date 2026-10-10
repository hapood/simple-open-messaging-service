import type { ProfileDemand } from '../../../../shared/profile-demand';

/** A home account's own profile is namespace 0 inside its publisher's store.
 * The home namespace is also used for identity/domain bindings, but is not
 * interchangeable with the target namespace in an immutable profile demand. */
export function homeProfileDemand(
  account: string,
  homeNamespaceId: number,
  rev: number,
): ProfileDemand {
  return {
    publisherNamespaceId: homeNamespaceId,
    lookup: 'ACCOUNT_PROFILE',
    target: { profileNamespaceId: 0, account, rev },
  };
}

export function messageAuthorProfileDemand(message: {
  publisherNamespaceId: number;
  creator: { account: string; namespaceId: number };
  profileRev: number;
}): ProfileDemand | undefined {
  if (message.profileRev < 1) return undefined;
  const home = message.creator.namespaceId;
  return {
    publisherNamespaceId: message.publisherNamespaceId,
    lookup: 'ACCOUNT_PROFILE',
    target: {
      profileNamespaceId: home === message.publisherNamespaceId ? 0 : home,
      account: message.creator.account,
      rev: message.profileRev,
    },
  };
}
