import { describe, expect, it } from 'vitest';
import { parseRequestSnapshot } from './request-snapshot.js';

describe('request snapshot', () => {
  it('preserves an explicitly absent avatar', () => {
    expect(parseRequestSnapshot({ displayName: 'Team', avatar: null })).toEqual(
      {
        displayName: 'Team',
        avatar: null,
      },
    );
  });

  it('preserves a retained avatar reference and Unicode display name', () => {
    const snapshot = {
      displayName: '😀'.repeat(31),
      avatar: '/uploads/request-avatar.webp',
    };
    expect(parseRequestSnapshot(snapshot)).toEqual(snapshot);
  });
});
