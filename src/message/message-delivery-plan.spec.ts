import { describe, expect, it } from 'vitest';
import {
  planFeedRecipientIds,
  planLiveDelivery,
} from './message-delivery-plan.js';

describe('local message delivery plan', () => {
  it('keeps feed delivery local and authorized, including the creator for sender-side sync', () => {
    expect(
      planFeedRecipientIds(
        [
          { userId: 1, isLocal: true, isDeleted: false, authorized: true },
          { userId: 2, isLocal: true, isDeleted: false, authorized: true },
          { userId: 3, isLocal: false, isDeleted: false, authorized: true },
          { userId: 4, isLocal: true, isDeleted: false, authorized: false },
        ],
      ),
    ).toEqual([1, 2]);
  });

  it('sends SSE to the creator devices but suppresses their notification Push', () => {
    expect(
      planLiveDelivery(
        [
          { userId: 1, muted: false, blocked: false },
          { userId: 2, muted: false, blocked: false },
          { userId: 3, muted: true, blocked: false },
          { userId: 4, muted: false, blocked: true },
        ],
        1,
      ),
    ).toEqual({ sseUserIds: [1, 2, 3], pushUserIds: [2] });
  });

  it('does not exclude any recipient when a SYSTEM message has no creator', () => {
    expect(
      planLiveDelivery([{ userId: 1, muted: false, blocked: false }], null),
    ).toEqual({ sseUserIds: [1], pushUserIds: [1] });
  });
});
