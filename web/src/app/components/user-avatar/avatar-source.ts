import type { AvatarProfileRef } from '../../services/avatar-profile-ref';
import type { AvatarDomainSource } from './model';
import { UserAvatarType } from './model';

export interface AvatarAppearance {
  type?: UserAvatarType;
  account?: string | null;
  domainSource?: AvatarDomainSource;
  loading?: boolean;
}

/** Sources are mutually exclusive: a missing snapshot image never falls through to a profile. */
export type AvatarSource =
  | (AvatarAppearance & {
      kind: 'demand';
      profile: AvatarProfileRef;
      fallbackName: string;
    })
  | (AvatarAppearance & {
      kind: 'snapshot';
      name: string;
      imageUrl: string | null;
    })
  | {
      kind: 'forward';
      name: string;
      /** Already authorized and adapted by the forward domain. No identity or badge inputs. */
      imageUrl: string | null;
    };

/**
 * Color identity is opaque to the paint layer and never derived from a display name.
 * The namespace and profile-namespace domain forms describe the same coordinate space:
 * `namespace N` implies home publisher 0, so it canonicalizes to `[0, N]` and matches a
 * `profile-namespace` `[0, N]` reference. Without this the same person would paint
 * different fallback colors depending on which surface referenced them.
 */
export function avatarColorKey(source: AvatarAppearance): string | undefined {
  if (!source.account) return undefined;
  const domain = source.domainSource;
  const coordinate =
    domain?.type === 'snapshot'
      ? domain.domain
      : domain?.type === 'namespace'
        ? [0, domain.namespaceId]
        : domain?.type === 'profile-namespace'
          ? [domain.publisherNamespaceId, domain.profileNamespaceId]
          : null;
  return JSON.stringify([
    source.type === UserAvatarType.GROUP ? 'g' : 'u',
    coordinate,
    source.account,
  ]);
}
