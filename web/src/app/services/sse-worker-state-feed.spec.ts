import type { ToMain, ToWorker } from './sse-worker-protocol';

describe('browser SSE to database-worker state-feed handoff', () => {
  it.each([true, false])(
    'forwards commits for the current port generation (port before HELLO: %s)',
    async (portBeforeHello) => {
      vi.resetModules();
      const listeners = new Map<
        string,
        (event: MessageEvent<ToWorker>) => void
      >();
      const posted: ToMain[] = [];
      vi.stubGlobal('self', {
        postMessage: (message: ToMain) => posted.push(message),
        addEventListener: (
          name: string,
          handler: (event: MessageEvent<ToWorker>) => void,
        ) => listeners.set(name, handler),
      });
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
        await import('./sse.worker');
        const send = (message: ToWorker) =>
          listeners.get('message')!({
            data: message,
          } as MessageEvent<ToWorker>);
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
        send({ type: 'stop' });
      } finally {
        vi.unstubAllGlobals();
      }
    },
  );
});
