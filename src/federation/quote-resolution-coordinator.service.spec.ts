import { afterEach, describe, expect, it, vi } from 'vitest';
import { QuoteResolutionCoordinatorService } from './quote-resolution-coordinator.service.js';
import { isThreadMutuallyAuthorized } from '../relationship/relationship-authorization.js';

vi.mock('../relationship/relationship-authorization.js', () => ({
  isThreadMutuallyAuthorized: vi.fn(),
}));
afterEach(() => vi.restoreAllMocks());

describe('quote resolution coordinator', () => {
  function setup() {
    vi.mocked(isThreadMutuallyAuthorized).mockResolvedValue(true);
    const queryClientMessagePage = vi.fn().mockResolvedValue({
      messages: [
        {
          seq: 9,
          content: JSON.stringify({
            text: 'reply',
            quote: { seq: 0, status: 'PENDING' },
          }),
        },
      ],
    });
    let observer: ((threadId: number) => void) | undefined;
    const cancel = vi.fn();
    const requestSourceRefresh = vi.fn().mockResolvedValue(undefined);
    const scheduler = {
      observeCompletions: vi.fn((f: (threadId: number) => void) => {
        observer = f;
        return cancel;
      }),
      requestSourceRefresh,
    };
    const chain = {
      from: vi.fn(),
      innerJoin: vi.fn(),
      where: vi.fn(),
      limit: vi
        .fn()
        .mockResolvedValue([{ domain: 'peer.test', namespaceId: 3 }]),
    };
    chain.from.mockReturnValue(chain);
    chain.innerJoin.mockReturnValue(chain);
    chain.where.mockReturnValue(chain);
    const sse = { onQuoteResolution: vi.fn() };
    const service = new QuoteResolutionCoordinatorService(
      { db: { select: () => chain } } as never,
      { queryClientMessagePage } as never,
      scheduler as never,
      sse as never,
    );
    return {
      service,
      queryClientMessagePage,
      scheduler,
      sse,
      cancel,
      complete: () => observer?.(7),
    };
  }
  it('coalesces a pending request and emits a terminal after a committed round', async () => {
    const s = setup();
    try {
      const first = await s.service.start(1, { threadId: 7, messageSeq: 9 });
      const second = await s.service.start(1, { threadId: 7, messageSeq: 9 });
      expect(second).toEqual(first);
      s.queryClientMessagePage.mockResolvedValue({
        messages: [
          {
            seq: 9,
            content: JSON.stringify({
              text: 'reply',
              quote: { seq: 0, status: 'NOT_FOUND' },
            }),
          },
        ],
      });
      s.complete();
      await vi.waitFor(() =>
        expect(s.sse.onQuoteResolution).toHaveBeenCalledWith(
          1,
          'QUOTE_RESOLVED',
          expect.objectContaining({
            requestId: first.requestId,
            result: { seq: 0, status: 'NOT_FOUND' },
          }),
        ),
      );
      expect(s.cancel).toHaveBeenCalled();
    } finally {
      s.service.onModuleDestroy();
    }
  });
  it('checks authorization before cached or pending results', async () => {
    const s = setup();
    vi.mocked(isThreadMutuallyAuthorized).mockResolvedValue(false);
    await expect(
      s.service.start(1, { threadId: 7, messageSeq: 9 }),
    ).rejects.toThrow('thread is unavailable');
    expect(s.queryClientMessagePage).not.toHaveBeenCalled();
  });

  it('does not parse or schedule a quote for a tomb parent', async () => {
    const s = setup();
    s.queryClientMessagePage.mockResolvedValue({
      messages: [{ seq: 9, contentType: 'TOMB', isDeleted: true }],
    } as never);
    await expect(
      s.service.start(1, { threadId: 7, messageSeq: 9 }),
    ).rejects.toThrow('quoted message is unavailable');
    expect(s.scheduler.requestSourceRefresh).not.toHaveBeenCalled();
  });
});
