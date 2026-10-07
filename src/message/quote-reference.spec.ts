import { describe, expect, it, vi } from 'vitest';
import { resolveStoredQuotes } from './quote-reference.js';

describe('stored quote resolution', () => {
  const parent = {
    id: 10n,
    threadId: 7,
    namespaceId: 3,
    seq: 20,
    publisherNamespaceId: 3,
    contentType: 'PURE_TEXT',
    content: JSON.stringify({ text: 'reply', quote: { seq: 0, sourceSeq: 4 } }),
  };
  function db(
    options: { target?: unknown; gap?: unknown; processed?: number } = {},
  ) {
    return {
      query: {
        message: {
          findMany: vi
            .fn()
            .mockResolvedValue(options.target ? [options.target] : []),
        },
        federationThreadHistoryGap: {
          findMany: vi.fn().mockResolvedValue(options.gap ? [options.gap] : []),
        },
        federationThreadSyncState: {
          findMany: vi.fn().mockResolvedValue([
            {
              threadId: 7,
              namespaceId: 3,
              messageProcessedThroughSeq: options.processed ?? 10,
            },
          ]),
        },
      },
    };
  }
  it.each([true, false])(
    'distinguishes recoverable=%s history from unavailable history',
    async (recoverable) => {
      const [result] = await resolveStoredQuotes(
        db({
          gap: {
            threadId: 7,
            namespaceId: 3,
            startSeq: 1,
            endSeq: 6,
            recoverable,
            messageSeqOffset: 0,
          },
        }) as never,
        [parent] as never,
      );
      expect(JSON.parse(result.content).quote).toEqual({
        seq: 0,
        sourceSeq: 4,
        status: recoverable ? 'PENDING' : 'NOT_FOUND',
      });
    },
  );
  it('reports not found only after the coordinate was scanned with no remaining gap', async () => {
    const [result] = await resolveStoredQuotes(
      db() as never,
      [parent] as never,
    );
    expect(JSON.parse(result.content).quote.status).toBe('NOT_FOUND');
  });
  it('keeps an unscanned forward coordinate pending', async () => {
    const [result] = await resolveStoredQuotes(
      db({ processed: 2 }) as never,
      [parent] as never,
    );
    expect(JSON.parse(result.content).quote.status).toBe('PENDING');
  });
  it('uses the receiver-local sequence when the target arrives', async () => {
    const [result] = await resolveStoredQuotes(
      db({
        target: {
          id: 8n,
          threadId: 7,
          namespaceId: 3,
          seq: 104,
          originSeq: 4,
          publisherNamespaceId: 3,
          localState: 'READY',
          isDeleted: false,
        },
      }) as never,
      [parent] as never,
    );
    expect(JSON.parse(result.content).quote).toEqual({ seq: 104 });
  });

  it('uses the reference namespace even after the containing message origin changes', async () => {
    const message = {
      ...parent,
      publisherNamespaceId: 99,
      content: JSON.stringify({
        text: 'reply',
        quote: { seq: 4, namespaceId: 3 },
      }),
    };
    const original = message.content;
    const [result] = await resolveStoredQuotes(
      db({
        target: {
          id: 8n,
          threadId: 7,
          seq: 104,
          originSeq: 4,
          publisherNamespaceId: 3,
          isDeleted: false,
        },
      }) as never,
      [message] as never,
    );
    expect(JSON.parse(result.content).quote).toEqual({ seq: 104 });
    expect(message.content).toBe(original);
  });

  it('does not bind a same-number target in a different namespace', async () => {
    const [result] = await resolveStoredQuotes(
      db({
        target: {
          id: 8n,
          threadId: 7,
          seq: 4,
          originSeq: 4,
          publisherNamespaceId: 99,
          isDeleted: false,
        },
      }) as never,
      [
        {
          ...parent,
          content: JSON.stringify({
            text: 'reply',
            quote: { seq: 4, namespaceId: 3 },
          }),
        },
      ] as never,
    );
    expect(JSON.parse(result.content).quote).toEqual({
      seq: 0,
      sourceSeq: 4,
      status: 'NOT_FOUND',
    });
  });
});
