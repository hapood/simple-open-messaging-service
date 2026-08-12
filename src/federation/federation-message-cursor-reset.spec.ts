import { describe, expect, it, vi } from 'vitest';
import { BusinessCode } from '../common/business-code.js';
import { FederationService, S2sResponseError } from './federation.service.js';
import { RemoteMessageFeedCursorResetError } from './federation-message-feed-pull.service.js';

describe('FederationService message-feed cursor reset translation', () => {
  it('turns a valid remote cursor-invalid response into a recoverable floor reset', async () => {
    const service = Object.create(
      FederationService.prototype,
    ) as FederationService & Record<string, unknown>;
    Object.assign(service, {
      capturePeerResponseToken: vi.fn().mockResolvedValue({ generation: 1 }),
      withTrustedPeer: vi.fn(
        (_domain: string, operation: () => Promise<unknown>) => operation(),
      ),
      getSigned: vi.fn().mockRejectedValue(
        new S2sResponseError(
          'cursor truncated',
          200,
          BusinessCode.FEDERATION_MISSED_CURSOR_INVALID,
          {
            startChangeId: '5000',
            availableCursor: '5000',
            allocatedThrough: '12000',
          },
        ),
      ),
    });

    await expect(service.pullMissedPage('peer.test', 42n)).rejects.toEqual(
      expect.objectContaining<Partial<RemoteMessageFeedCursorResetError>>({
        name: 'RemoteMessageFeedCursorResetError',
        startChangeId: 5000n,
        availableCursor: 5000n,
        allocatedThrough: 12000n,
      }),
    );
  });
});
