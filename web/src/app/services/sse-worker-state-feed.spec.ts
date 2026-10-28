import type { ToMain, ToWorker } from './sse-worker-protocol';

describe('browser SSE to database-worker state-feed handoff', () => {
  const listeners = new Map<string, (event: MessageEvent<ToWorker>) => void>();
  const posted: ToMain[] = [];
  const send = (message: ToWorker) =>
    listeners.get('message')!({ data: message } as MessageEvent<ToWorker>);

  beforeAll(async () => {
    // Angular bundles relative modules before Vitest runs them. Import the worker once,
    // then use its stop protocol to reset state rather than relying on vi.resetModules().
    vi.stubGlobal('self', {
      postMessage: (message: ToMain) => posted.push(message),
      addEventListener: (
        name: string,
        handler: (event: MessageEvent<ToWorker>) => void,
      ) => listeners.set(name, handler),
    });
    await import('./sse.worker');
  });
  afterAll(() => vi.unstubAllGlobals());

  it.each([true, false])(
    'forwards commits for the current port generation (port before HELLO: %s)',
    async (portBeforeHello) => {
      posted.length = 0;
      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(
            new TextEncoder().encode(
              'event: HELLO\ndata: {"userId":1,"stateFeedEndId":3,"threadFeedEndId":0}\n\n',
            ),
          );
        },
      });
      vi.stubGlobal(
        'fetch',
        vi.fn(async () => new Response(stream)),
      );
      try {
        const port = {
          postMessage: vi.fn(),
          start: vi.fn(),
          close: vi.fn(),
          onmessage: null as ((event: MessageEvent) => void) | null,
        };
        const bind = (current: typeof port) =>
          send({
            type: 'thread-feed-port',
            port: current as unknown as MessagePort,
            userId: 1,
          });
        if (portBeforeHello) bind(port);
        send({ type: 'start', url: '/api/v1/events' });
        await vi.waitFor(() =>
          expect(
            posted.some(
              (message) =>
                message.type === 'event' && message.payload.event === 'HELLO',
            ),
          ).toBe(true),
        );
        if (!portBeforeHello) bind(port);
        expect(port.postMessage).toHaveBeenCalledWith({ stateTarget: 3 });
        expect(port.postMessage).toHaveBeenCalledWith({ target: 0 });
      } finally {
        send({ type: 'stop' });
        // The shared reader owns attempt-scoped cancellation and cancels the
        // response body on stop; the mock stream needs no manual close.
        await vi.waitFor(() =>
          expect(
            posted.filter(
              (message) =>
                message.type === 'state' && message.state === 'closed',
            ),
          ).toHaveLength(2),
        );
      }
    },
  );
});
