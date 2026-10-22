import type { AvatarSource } from '../user-avatar/avatar-source';
import type {
  ForwardManifestMessage,
  ForwardWireBundle,
} from './forward-bundle.model';

/** Bundle snapshots authorize only their carrier-scoped resource, never a profile lookup. */
export function forwardAvatarSource(
  profile: ForwardManifestMessage['profile'],
  bundle: Pick<ForwardWireBundle, 'assets' | 'accessContext'> | null,
): Extract<AvatarSource, { kind: 'forward' }> {
  const digest = profile.avatarDigest;
  const context = bundle?.accessContext;
  const imageUrl =
    digest &&
    /^[a-f0-9]{64}$/.test(digest) &&
    context &&
    bundle.assets.some((asset) => asset.digest === digest)
      ? `/uploads/msg-assets/${digest.slice(0, 2)}/${digest.slice(2, 4)}/${digest}?threadId=${context.threadId}&seq=${context.seq}`
      : null;
  return { kind: 'forward', name: profile.displayName, imageUrl };
}
