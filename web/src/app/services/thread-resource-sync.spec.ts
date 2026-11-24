import { describe, expect, it } from 'vitest';
import { advanceThreadResourceTargets as advance } from './thread-resource-sync';

describe('durable thread resource targets', () => {
  it('accepts state heads before the conversation and preserves them when message head arrives', () => {
    const tomb = advance(undefined, 42, { tombstoneEndSeq: 8 });
    const meta = advance(tomb, 42, { groupMetaFeedEndId: '9007199254740993' });
    expect(advance(meta, 42, { messageEndSeq: 20 })).toEqual({
      threadId: 42, messageEndSeq: 20, tombstoneEndSeq: 8,
      groupMetaFeedEndId: '9007199254740993',
    });
  });
  it('never regresses independent targets on replay', () => {
    const current = advance(undefined, 42, {
      messageEndSeq: 20, tombstoneEndSeq: 8, groupMetaFeedEndId: '100',
    });
    expect(advance(current, 42, {
      messageEndSeq: 19, tombstoneEndSeq: 7, groupMetaFeedEndId: '99',
    })).toEqual(current);
    expect(advance(current, 42, {})).toEqual(current);
  });
  it('rejects malformed coordinates and mismatched identities', () => {
    expect(() => advance(undefined, 0, {})).toThrow();
    expect(() => advance(undefined, 42, { messageEndSeq: -1 })).toThrow();
    expect(() => advance(undefined, 42, { groupMetaFeedEndId: '01' })).toThrow();
    expect(() => advance(advance(undefined, 42, {}), 43, {})).toThrow();
  });
});
