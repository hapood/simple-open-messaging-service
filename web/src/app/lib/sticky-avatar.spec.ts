import { pickStickyAvatarPlacement } from './sticky-avatar';

describe('pickStickyAvatarPlacement', () => {
  const row = (
    creator: string,
    top: number,
    hasNaturalAvatar = false,
    side: 'self' | 'other' = 'other',
  ) => ({ creator, top, hasNaturalAvatar, side });

  it('waits until the natural group-head avatar reaches the sticky line', () => {
    expect(pickStickyAvatarPlacement([row('a', 20, true)], 12)).toBeNull();
    expect(pickStickyAvatarPlacement([row('a', 12, true)], 12)?.top).toBe(12);
  });

  it('pins one avatar and lets the group tail push it away', () => {
    expect(
      pickStickyAvatarPlacement(
        [row('a', -50, true), row('a', -10), row('a', 8)],
        12,
      ),
    ).toEqual(jasmine.objectContaining({ creator: 'a', top: 8 }));
  });

  it('switches sender only after the next group crosses the line', () => {
    const rows = [row('a', -30, true), row('a', 0), row('b', 30, true, 'self')];
    expect(pickStickyAvatarPlacement(rows, 12)).toEqual(
      jasmine.objectContaining({ creator: 'a' }),
    );
    expect(
      pickStickyAvatarPlacement(
        [row('a', -60, true), row('a', -30), row('b', 12, true, 'self')],
        12,
      ),
    ).toEqual(jasmine.objectContaining({ creator: 'b', side: 'self' }));
  });

  it('supports a group whose natural head was virtualized away', () => {
    expect(pickStickyAvatarPlacement([row('a', -5), row('a', 40)], 12)).toEqual(
      jasmine.objectContaining({ creator: 'a', top: 12 }),
    );
  });
});
