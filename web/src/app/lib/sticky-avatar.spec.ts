import { pickStickyAvatarPlacement, resolveStickyAvatar } from './sticky-avatar';

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

describe('resolveStickyAvatar', () => {
  function host(
    creator: string,
    top: number,
    avatar = false,
  ): HTMLElement {
    const element = document.createElement('div');
    element.dataset['messageCreator'] = creator;
    element.dataset['messageSide'] = 'other';
    element.dataset['messageAvatarName'] = creator;
    const row = document.createElement('div');
    row.className = avatar ? 'msg-row msg-has-avatar' : 'msg-row';
    row.getBoundingClientRect = () => ({ top }) as DOMRect;
    if (avatar) {
      const image = document.createElement('div');
      image.className = 'msg-avatar';
      row.appendChild(image);
    }
    element.appendChild(row);
    return element;
  }

  it('hides only the handed-off natural avatar in an A -> B -> A sequence', () => {
    const content = document.createElement('div');
    const upperA = host('a', -40, true);
    const middleB = host('b', 30, true);
    const lowerA = host('a', 70, true);
    content.append(upperA, middleB, lowerA);

    expect(resolveStickyAvatar(content, 0, 0, true)?.name).toBe('a');
    expect(
      upperA.querySelector('.msg-avatar')?.classList,
    ).toContain('cb-sticky-avatar-source');
    expect(
      lowerA.querySelector('.msg-avatar')?.classList,
    ).not.toContain('cb-sticky-avatar-source');
  });
});
