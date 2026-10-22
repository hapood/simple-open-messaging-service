export enum UserAvatarType {
  SELF,
  OTHER,
  GROUP,
}

/** Local namespace identities, publisher-scoped profiles and fixed display snapshots
 * have distinct domain sources. Profile coordinates are never inferred from local IDs. */
export type AvatarDomainSource =
  | { type: 'namespace'; namespaceId: number }
  | { type: 'profile-namespace'; publisherNamespaceId: number; profileNamespaceId: number }
  | { type: 'snapshot'; domain: string };
