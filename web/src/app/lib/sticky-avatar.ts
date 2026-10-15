/** Geometry-only sticky-avatar calculation, kept independent of Angular and the virtual-scroll kernel. */
import type { AvatarDomainSource } from '../components/user-avatar/model';
import type { AvatarProfileRef } from '../services/avatar-profile-ref';

const STICKY_AVATAR_TOP_GAP_PX = 12;
const STICKY_AVATAR_SIZE_PX = 40;

interface StickyAvatarRow {
  readonly creator: string;
  readonly side: 'self' | 'other';
  readonly top: number;
  readonly bottom: number;
  readonly hasNaturalAvatar: boolean;
  readonly naturalAvatarTop?: number;
}

interface StickyAvatarPlacement {
  readonly rowIndex: number;
  readonly groupStartIndex: number;
  readonly groupEndIndex: number;
  readonly top: number;
  readonly creator: string;
  readonly side: 'self' | 'other';
}

export interface StickyAvatarView {
  readonly name: string;
  readonly avatarProfile?: AvatarProfileRef;
  readonly snapshotAvatarUrl?: string;
  readonly identityId?: string;
  readonly account?: string;
  readonly domain?: string;
  readonly domainSource?: AvatarDomainSource;
  readonly side: 'self' | 'other';
  readonly top: number;
}

export interface StickyAvatarIdentity {
  readonly name: string;
  readonly avatarProfile?: AvatarProfileRef;
  readonly snapshotAvatarUrl?: string;
  readonly identityId?: string;
  readonly account?: string;
  readonly domain?: string;
  readonly domainSource?: AvatarDomainSource;
}

export interface StickyAvatarMeasuredRow extends StickyAvatarRow {
  readonly name: string;
  readonly avatarProfile?: AvatarProfileRef;
  readonly snapshotAvatarUrl?: string;
  readonly identityId?: string;
  readonly account?: string;
  readonly domain?: string;
  readonly domainSource?: AvatarDomainSource;
  readonly naturalAvatar?: HTMLElement;
  readonly tailAvatar?: HTMLElement;
}

export interface StickyAvatarResolution {
  readonly view: StickyAvatarView | null;
  readonly hiddenHead?: HTMLElement;
  readonly visibleTail?: HTMLElement;
}

/** Keep the DOM hand-off between a natural avatar and its floating copy lossless. */
export function writeStickyAvatarIdentity(
  host: HTMLElement,
  avatar: StickyAvatarIdentity,
): void {
  host.dataset['messageAvatarName'] = avatar.name;
  if (avatar.avatarProfile)
    host.dataset['messageAvatarEvidence'] = JSON.stringify(
      avatar.avatarProfile,
    );
  else delete host.dataset['messageAvatarEvidence'];
  if (avatar.snapshotAvatarUrl)
    host.dataset['messageSnapshotAvatarUrl'] = avatar.snapshotAvatarUrl;
  else delete host.dataset['messageSnapshotAvatarUrl'];
  host.dataset['messageAvatarAccount'] = avatar.account ?? '';
  host.dataset['messageAvatarDomain'] = avatar.domain ?? '';
  if (avatar.domainSource)
    host.dataset['messageAvatarDomainSource'] = JSON.stringify(
      avatar.domainSource,
    );
  else delete host.dataset['messageAvatarDomainSource'];
  if (avatar.identityId == null) {
    delete host.dataset['messageAvatarIdentity'];
  } else {
    host.dataset['messageAvatarIdentity'] = String(avatar.identityId);
  }
}

/**
 * Pick the consecutive sender group crossing the sticky line. The avatar starts only after that group's
 * natural head reaches the line, remains pinned inside the group, then follows the last row above the line
 * so the next group can take over without two sticky avatars ever coexisting.
 */
export function pickStickyAvatarPlacement(
  rows: ReadonlyArray<StickyAvatarRow>,
  stickyTop: number,
): StickyAvatarPlacement | null {
  if (rows.length === 0) return null;

  const visibleTop = stickyTop - STICKY_AVATAR_TOP_GAP_PX;
  let start = 0;
  let candidate: { start: number; end: number } | null = null;
  while (start < rows.length) {
    let end = start;
    while (
      end + 1 < rows.length &&
      rows[end + 1].creator === rows[start].creator
    )
      end += 1;
    const groupTop = rows[start].top;
    const groupBottom = rows[end].bottom;
    if (groupTop <= stickyTop && groupBottom > visibleTop)
      candidate = { start, end };
    start = end + 1;
  }
  if (!candidate) return null;

  const { start: groupStart, end: groupEnd } = candidate;
  const naturalHead = rows
    .slice(groupStart, groupEnd + 1)
    .find((row) => row.hasNaturalAvatar);
  if (
    naturalHead &&
    (naturalHead.naturalAvatarTop ?? naturalHead.top) >= stickyTop
  )
    return null;

  const top = Math.min(
    stickyTop,
    rows[groupEnd].bottom - STICKY_AVATAR_SIZE_PX,
  );
  if (top + STICKY_AVATAR_SIZE_PX <= visibleTop) return null;

  return {
    rowIndex: groupStart,
    groupStartIndex: groupStart,
    groupEndIndex: groupEnd,
    top,
    creator: rows[groupStart].creator,
    side: rows[groupStart].side,
  };
}

/**
 * Resolve the natural-avatar handoff from kernel-owned row geometry. DOM writes belong to the stateful
 * overlay controller so an unchanged phase never clears and reapplies visibility classes.
 */
export function resolveStickyAvatar(
  rows: ReadonlyArray<StickyAvatarMeasuredRow>,
  stickyTop: number,
  overlayOrigin: number,
  showSelfAvatar: boolean,
): StickyAvatarResolution {
  const placement = pickStickyAvatarPlacement(rows, stickyTop);
  if (!placement || (placement.side === 'self' && !showSelfAvatar))
    return { view: null };

  const row = rows[placement.rowIndex];
  if (!row) return { view: null };
  // Hide only the natural avatar that handed off to the viewport overlay. Marking message hosts (or the
  // whole sender group) makes the selector reach unrelated natural avatars when rows are wrapped/reused.
  // In particular, A -> B -> A must keep A's lower, ordinary group-head avatar visible while the upper A
  // avatar remains sticky.
  const naturalHead = rows
    .slice(placement.groupStartIndex, placement.groupEndIndex + 1)
    .map((candidate) => candidate.naturalAvatar)
    .find((avatar): avatar is HTMLElement => avatar != null);
  // Once the real tail reaches the fixed line it takes over at the exact same coordinate. It remains
  // mounted and decoded while hidden, so this works without a create/destroy or async image gap in either
  // scroll direction.
  if (placement.top < stickyTop) {
    return {
      view: null,
      hiddenHead: naturalHead,
      visibleTail: rows[placement.groupEndIndex]?.tailAvatar,
    };
  }
  return {
    hiddenHead: naturalHead,
    view: {
      name: row.name,
      avatarProfile: row.avatarProfile,
      snapshotAvatarUrl: row.snapshotAvatarUrl,
      identityId: row.identityId,
      // The overlay's <app-user-avatar> needs the same account+domain identity key as the natural row
      // avatar: an omitted account hashes the empty string and pins every float avatar to PALETTE[0].
      account: row.account,
      domain: row.domain,
      domainSource: row.domainSource,
      side: placement.side,
      // DOM rectangles may carry sub-pixel viewport coordinates (device scale, compositor transforms). The
      // natural avatar is laid out on the integer-pixel timeline grid; quantize only the final overlay-local
      // coordinate so the hand-off cannot rasterize one edge 1–2px above its in-flow counterpart.
      top: Math.round(placement.top - overlayOrigin),
    },
  };
}
