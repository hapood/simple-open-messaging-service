import {
  pickStickyAvatarPlacement,
  resolveStickyAvatar,
} from './sticky-avatar';

describe('pickStickyAvatarPlacement', () => {
  const row = (
    creator: string,
    top: number,
    hasNaturalAvatar = false,
    side: 'self' | 'other' = 'other',
    height = 40,
    naturalAvatarTop = top,
  ) => ({
    creator,
    top,
    bottom: top + height,
    hasNaturalAvatar,
    naturalAvatarTop: hasNaturalAvatar ? naturalAvatarTop : undefined,
    side,
  });

  it('waits until the natural group-head avatar reaches the sticky line', () => {
    expect(pickStickyAvatarPlacement([row('a', 20, true)], 12)).toBeNull();
    expect(pickStickyAvatarPlacement([row('a', 12, true)], 12)).toBeNull();
    expect(pickStickyAvatarPlacement([row('a', 11, true)], 12)?.top).toBe(11);
  });

  it('keeps a fully visible natural avatar when only its padded row crossed', () => {
    expect(
      pickStickyAvatarPlacement([row('a', 8, true, 'other', 54, 14)], 12),
    ).toBeNull();
  });

  it('pins one avatar and lets the group tail push it away', () => {
    expect(
      pickStickyAvatarPlacement(
        [row('a', -50, true), row('a', -10), row('a', 8, false, 'other', 40)],
        12,
      ),
    ).toEqual(expect.objectContaining({ creator: 'a', top: 8 }));
  });

  it('clamps the avatar inside a partially visible group tail', () => {
    expect(
      pickStickyAvatarPlacement([row('a', -20, true, 'other', 50)], 12)?.top,
    ).toBe(-10);
  });

  it('removes the fixed avatar after its whole group leaves the viewport', () => {
    expect(
      pickStickyAvatarPlacement([row('a', -50, true, 'other', 40)], 12),
    ).toBeNull();
  });

  it('switches sender only after the next group crosses the line', () => {
    const rows = [row('a', -30, true), row('a', 0), row('b', 30, true, 'self')];
    expect(pickStickyAvatarPlacement(rows, 12)).toEqual(
      expect.objectContaining({ creator: 'a' }),
    );
    expect(
      pickStickyAvatarPlacement(
        [row('a', -60, true), row('a', -30), row('b', 11, true, 'self')],
        12,
      ),
    ).toEqual(expect.objectContaining({ creator: 'b', side: 'self' }));
  });

  it('supports a group whose natural head was virtualized away', () => {
    expect(pickStickyAvatarPlacement([row('a', -5), row('a', 40)], 12)).toEqual(
      expect.objectContaining({ creator: 'a', top: 12 }),
    );
  });
});

describe('resolveStickyAvatar', () => {
  function measuredRow(creator: string, top: number, avatar = false) {
    const naturalAvatar = avatar ? document.createElement('div') : undefined;
    const tailAvatar = document.createElement('div');
    return {
      creator,
      side: 'other' as const,
      top,
      bottom: top + 40,
      hasNaturalAvatar: avatar,
      naturalAvatarTop: avatar ? top : undefined,
      naturalAvatar,
      tailAvatar,
      name: creator,
      src: '',
    };
  }

  it('hides only the handed-off natural avatar in an A -> B -> A sequence', () => {
    const upperA = measuredRow('a', -30, true);
    const middleB = measuredRow('b', 30, true);
    const lowerA = measuredRow('a', 70, true);

    const resolution = resolveStickyAvatar(
      [upperA, middleB, lowerA],
      12,
      0,
      true,
    );
    expect(resolution.view).toBeNull();
    expect(resolution.hiddenHead).toBe(upperA.naturalAvatar);
    expect(resolution.hiddenHead).not.toBe(lowerA.naturalAvatar);
    expect(resolution.visibleTail).toBe(upperA.tailAvatar);
  });

  it('preserves a missing identity instead of coercing it to zero', () => {
    const row = measuredRow('Alice', -30, true);
    expect(
      resolveStickyAvatar([row], 12, 0, true).view?.identityId,
    ).toBeUndefined();
  });

  it('keeps the natural avatar at the viewport scroll origin', () => {
    const first = measuredRow('Alice', 8, true);

    expect(resolveStickyAvatar([first], 12, 0, true)).toEqual({
      view: null,
      hiddenHead: first.naturalAvatar,
      visibleTail: first.tailAvatar,
    });
  });

  it('quantizes the final overlay position to the integer-pixel grid', () => {
    const first = measuredRow('Alice', -39.6, true);
    const last = measuredRow('Alice', 12);

    expect(resolveStickyAvatar([first, last], 12, 0.25, true).view?.top).toBe(
      12,
    );
  });

  it('hands off to the pre-mounted natural tail after it crosses the fixed line', () => {
    const first = measuredRow('Alice', -30, true);
    first.bottom = 21;
    const resolution = resolveStickyAvatar([first], 12, 0, true);
    expect(resolution.view).toBeNull();
    expect(resolution.hiddenHead).toBe(first.naturalAvatar);
    expect(resolution.visibleTail).toBe(first.tailAvatar);
  });
});
