import { describe, expect, it } from 'vitest';
import {
  deriveRelationshipIntentTransition,
  isEffectiveRelationshipIntent,
  type RelationshipIntentSnapshot,
} from './relationship-intent-state.js';

const now = new Date('2026-08-24T12:00:00.000Z');
const future = new Date('2026-08-25T12:00:00.000Z');
const past = new Date('2026-08-23T12:00:00.000Z');

const states = {
  absent: undefined,
  revoked: { status: 'REVOKED', expiresAt: null },
  expired: { status: 'REQUESTED', expiresAt: past },
  requested: { status: 'REQUESTED', expiresAt: future },
  accepted: { status: 'ACCEPTED', expiresAt: null },
} satisfies Record<string, RelationshipIntentSnapshot | undefined>;

describe('relationship intent state machine', () => {
  it.each([
    ['absent', false],
    ['revoked', false],
    ['expired', false],
    ['requested', true],
    ['accepted', true],
  ] as const)('classifies %s as effective=%s', (name, effective) => {
    expect(isEffectiveRelationshipIntent(states[name], now)).toBe(effective);
  });

  for (const [localName, local] of Object.entries(states)) {
    for (const [reverseName, reverse] of Object.entries(states)) {
      const bothEffective =
        ['requested', 'accepted'].includes(localName) &&
        ['requested', 'accepted'].includes(reverseName);
      const shouldPromote = bothEffective && localName === 'requested';
      it(`${localName} + ${reverseName} derives the complete transition`, () => {
        expect(deriveRelationshipIntentTransition(local, reverse, now)).toEqual(
          {
            state: bothEffective ? 'CONFIRMED' : 'UNCONFIRMED',
            promoteLocalRequest: shouldPromote,
          },
        );
      });
    }
  }

  it('treats an ISO timestamp at the exact expiry boundary as ineffective', () => {
    expect(
      isEffectiveRelationshipIntent(
        { status: 'REQUESTED', expiresAt: now.toISOString() },
        now,
      ),
    ).toBe(false);
  });
});
