import { describe, expect, it, vi } from 'vitest';
import { BusinessCode } from '../common/business-code.js';
import { FederationService, S2sResponseError } from './federation.service.js';
import { RemoteFeedCursorUnavailableError } from './federation-feed-cursor-error.js';

describe('FederationService message-feed cursor reset translation', () => {
  function serviceWith(data: unknown): FederationService {
    const service = Object.create(
      FederationService.prototype,
    ) as FederationService & Record<string, unknown>;
    Object.assign(service, {
      capturePeerResponseToken: vi.fn().mockResolvedValue({ generation: 1 }),
      withTrustedPeer: vi.fn(
        (_domain: string, operation: () => Promise<unknown>) => operation(),
      ),
      getSigned: vi
        .fn()
        .mockRejectedValue(
          new S2sResponseError(
            'requested cursor is below retained floor',
            200,
            BusinessCode.FEDERATION_FEED_CURSOR_UNAVAILABLE,
            data,
          ),
        ),
    });
    return service;
  }

  it('turns a valid 50019 response into a recoverable floor reset', async () => {
    const service = serviceWith({ resumeAfter: '5200' });

    await expect(service.pullMissedPage('peer.test', 42n)).rejects.toEqual(
      expect.objectContaining<Partial<RemoteFeedCursorUnavailableError>>({
        name: 'RemoteFeedCursorUnavailableError',
        resumeAfter: 5200n,
      }),
    );
  });

  it('does not adopt malformed or extended cursor-reset data', async () => {
    const service = serviceWith({
      resumeAfter: '5200',
      requestedCursor: '42',
    });

    await expect(
      service.pullMissedPage('peer.test', 42n),
    ).rejects.toBeInstanceOf(S2sResponseError);
  });
});
