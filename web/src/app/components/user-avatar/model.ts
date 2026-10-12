export enum UserAvatarType {
  SELF,
  OTHER,
  GROUP,
}

/** Namespace identities and fixed address snapshots have distinct domain sources.
 *  `subject-home` resolves the member-home diagonal binding — the namespace
 *  publishing its own profiles — instead of the local-publisher view. */
export type AvatarDomainSource =
  | { type: 'namespace'; namespaceId: number }
  | { type: 'subject-home'; namespaceId: number }
  | { type: 'snapshot'; domain: string };
