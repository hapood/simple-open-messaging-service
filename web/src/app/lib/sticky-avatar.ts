/** Geometry-only sticky-avatar calculation, kept independent of Angular and the virtual-scroll kernel. */

export const STICKY_AVATAR_TOP_GAP_PX = 12;

export interface StickyAvatarRow {
  readonly creator: string;
  readonly side: 'self' | 'other';
  readonly top: number;
  readonly hasNaturalAvatar: boolean;
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

  let crossing = -1;
  for (let i = 0; i < rows.length; i += 1) {
    if (rows[i].top <= stickyTop) crossing = i;
  }
  if (crossing < 0) return null;

  const creator = rows[crossing].creator;
  let start = crossing;
  while (start > 0 && rows[start - 1].creator === creator) start -= 1;
  let end = crossing;
  while (end + 1 < rows.length && rows[end + 1].creator === creator) end += 1;

  // A mounted natural head below the line has not handed off yet. When the real head was virtualized away,
  // the first mounted body row intentionally behaves as an already-crossed group.
  const naturalHead = rows
    .slice(start, crossing + 1)
    .find((row) => row.hasNaturalAvatar);
  if (naturalHead && naturalHead.top > stickyTop) return null;

  return {
    rowIndex: crossing,
    groupStartIndex: start,
    groupEndIndex: end,
    top: Math.min(stickyTop, rows[end].top),
    creator,
    side: rows[crossing].side,
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
  const measured = hosts.map((host) => ({
    creator: host.dataset['messageCreator'] ?? '',
    side: (host.dataset['messageSide'] === 'self' ? 'self' : 'other') as
      | 'self'
      | 'other',
    top:
      host.querySelector<HTMLElement>('.msg-row')?.getBoundingClientRect()
        .top ?? host.getBoundingClientRect().top,
    hasNaturalAvatar: !!host.querySelector('.msg-has-avatar .msg-avatar'),
  }));
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
  const identity = Number(host.dataset['messageAvatarIdentity']);
  return {
    name: host.dataset['messageAvatarName'] ?? '',
    src: host.dataset['messageAvatarSrc'] ?? '',
    identityId: Number.isFinite(identity) ? identity : undefined,
    side: placement.side,
    top: placement.top - containerTop,
  };
}
