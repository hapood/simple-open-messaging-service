export enum UserAvatarType {
  SELF,
  OTHER,
  GROUP,
}

/** Namespace identities and fixed address snapshots have distinct domain sources. */
export type AvatarDomainSource =
  | { type: 'namespace'; namespaceId: number }
  | { type: 'snapshot'; domain: string };
