/** Geometry-only sticky-avatar calculation, kept independent of Angular and the virtual-scroll kernel. */

export const STICKY_AVATAR_TOP_GAP_PX = 12;
export const STICKY_AVATAR_SIZE_PX = 40;

export interface StickyAvatarRow {
  readonly creator: string;
  readonly side: 'self' | 'other';
  readonly top: number;
  readonly bottom: number;
  readonly hasNaturalAvatar: boolean;
  readonly naturalAvatarTop?: number;
}

export interface StickyAvatarPlacement {
  readonly rowIndex: number;
  readonly groupStartIndex: number;
  readonly groupEndIndex: number;
  readonly top: number;
  readonly creator: string;
  readonly side: 'self' | 'other';
}

export interface StickyAvatarView {
  readonly name: string;
  readonly src: string;
  readonly identityId?: number;
  readonly side: 'self' | 'other';
  readonly top: number;
}

export interface StickyAvatarIdentity {
  readonly name: string;
  readonly src?: string;
  readonly identityId?: number;
}

/** Keep the DOM hand-off between a natural avatar and its floating copy lossless. */
export function writeStickyAvatarIdentity(
  host: HTMLElement,
  avatar: StickyAvatarIdentity,
): void {
  host.dataset['messageAvatarName'] = avatar.name;
  host.dataset['messageAvatarSrc'] = avatar.src ?? '';
  if (avatar.identityId == null) {
    delete host.dataset['messageAvatarIdentity'];
  } else {
    host.dataset['messageAvatarIdentity'] = String(avatar.identityId);
  }
}

function readStickyAvatarIdentity(host: HTMLElement): StickyAvatarIdentity {
  const rawIdentity = host.dataset['messageAvatarIdentity'];
  const identity = rawIdentity === undefined ? undefined : Number(rawIdentity);
  return {
    name: host.dataset['messageAvatarName'] ?? '',
    src: host.dataset['messageAvatarSrc'] ?? '',
    identityId:
      identity !== undefined && Number.isFinite(identity) ? identity : undefined,
  };
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

/** Shared DOM adapter used by production and the chatbox playground. */
export function resolveStickyAvatar(
  content: HTMLElement,
  visibleTop: number,
  containerTop: number,
  showSelfAvatar: boolean,
): StickyAvatarView | null {
  const hosts = Array.from(
    content.querySelectorAll<HTMLElement>('[data-message-creator]'),
  );
  const measured = hosts.map((host) => {
    const naturalAvatar = host.querySelector<HTMLElement>(
      '.msg-has-avatar .msg-avatar',
    );
    const row = host.querySelector<HTMLElement>('.msg-row') ?? host;
    const rect = row.getBoundingClientRect();
    return {
      creator: host.dataset['messageCreator'] ?? '',
      side: (host.dataset['messageSide'] === 'self' ? 'self' : 'other') as
        | 'self'
      | 'other',
      top: rect.top,
      // `rect.height` / `rect.bottom - rect.top` includes cb-enter/cb-leave scale transforms (0.98),
      // producing a fractional 1–2px tail error. offsetHeight is the integer, transform-invariant row height.
      bottom: rect.top + row.offsetHeight,
      hasNaturalAvatar: naturalAvatar !== null,
      naturalAvatarTop: naturalAvatar?.getBoundingClientRect().top,
    };
  });
  const placement = pickStickyAvatarPlacement(
    measured,
    visibleTop + STICKY_AVATAR_TOP_GAP_PX,
  );
  content
    .querySelectorAll<HTMLElement>('.cb-sticky-avatar-source')
    .forEach((avatar) => avatar.classList.remove('cb-sticky-avatar-source'));
  if (!placement || (placement.side === 'self' && !showSelfAvatar)) return null;

  const host = hosts[placement.rowIndex];
  if (!host) return null;
  // Hide only the natural avatar that handed off to the viewport overlay. Marking message hosts (or the
  // whole sender group) makes the selector reach unrelated natural avatars when rows are wrapped/reused.
  // In particular, A -> B -> A must keep A's lower, ordinary group-head avatar visible while the upper A
  // avatar remains sticky.
  hosts
    .slice(placement.groupStartIndex, placement.groupEndIndex + 1)
    .map((candidate) =>
      candidate.querySelector<HTMLElement>('.msg-has-avatar .msg-avatar'),
    )
    .find((avatar): avatar is HTMLElement => avatar !== null)
    ?.classList.add('cb-sticky-avatar-source');
  const avatar = readStickyAvatarIdentity(host);
  return {
    name: avatar.name,
    src: avatar.src ?? '',
    identityId: avatar.identityId,
    side: placement.side,
    // DOM rectangles may carry sub-pixel viewport coordinates (device scale, compositor transforms). The
    // natural avatar is laid out on the integer-pixel timeline grid; quantize only the final overlay-local
    // coordinate so the hand-off cannot rasterize one edge 1–2px above its in-flow counterpart.
    top: Math.round(placement.top - containerTop),
  };
}
