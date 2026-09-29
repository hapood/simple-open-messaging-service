import { describe, expect, it } from 'vitest';
import { CALL_OUTCOMES, parseCallEndedContent } from './call-ended-content.js';
import { deriveMessagePreview } from './message-preview.js';
const base = {
  type: 'CALL_ENDED',
  callId: '550e8400-e29b-41d4-a716-446655440000',
  caller: {
    account: 'alice',
    domain: 'a.test',
    profileNamespaceId: 1,
    profileRev: 0,
  },
  callee: {
    account: 'bob',
    domain: 'b.test',
    profileNamespaceId: 2,
    profileRev: 0,
  },
  mediaType: 'AUDIO',
  initiatedAt: 100,
  endedAt: 500,
};
describe('terminal call system content', () => {
  it.each(CALL_OUTCOMES)('validates the %s outcome', (outcome) => {
    const content = {
      ...base,
      outcome,
      ...(outcome === 'completed' ? { connectedAt: 200 } : {}),
    };
    expect(parseCallEndedContent(JSON.stringify(content))).toEqual(content);
  });
  it.each([
    { outcome: 'completed' },
    { outcome: 'missed', connectedAt: 200 },
    { outcome: 'failed', connectedAt: 600 },
    { outcome: 'failed', initiatedAt: 500.5 },
    { outcome: 'failed', initiatedAt: undefined },
    { outcome: 'failed', startedAt: 200 },
    { outcome: 'failed', peerOccurredAt: 200 },
    { outcome: 'failed', type: 'CALL' },
    { outcome: 'failed', caller: { account: 'alice', domain: 'a.test' } },
    { outcome: 'failed', callee: { ...base.callee, profileRev: 1 } },
  ])('rejects invalid or retired fields: %j', (patch) => {
    expect(
      parseCallEndedContent(JSON.stringify({ ...base, ...patch })),
    ).toBeNull();
  });
  it('derives the call preview from SYSTEM content', () => {
    expect(
      deriveMessagePreview(
        'SYSTEM',
        JSON.stringify({ ...base, outcome: 'missed' }),
      ),
    ).toBe('[Missed call]');
    expect(deriveMessagePreview('SYSTEM', '{"type":"FRIEND_ADDED"}')).toBe(
      '[System message]',
    );
  });
});
