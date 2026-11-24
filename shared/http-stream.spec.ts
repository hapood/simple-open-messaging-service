import { createServer } from 'node:http';
import { once } from 'node:events';
import { describe, expect, it } from 'vitest';
import { consumeHttpStream } from './http-stream.js';

/** A real, deliberately unfinished response: cancellation must close its socket. */
async function withStreamingServer(
  test: (url: string, disconnected: Promise<void>) => Promise<void>,
): Promise<void> {
  let disconnected!: () => void;
  const closed = new Promise<void>((resolve) => {
    disconnected = resolve;
  });
  const server = createServer((_request, response) => {
    response.on('close', disconnected);
    response.writeHead(200, { 'Content-Type': 'text/event-stream' });
    response.write('event: HELLO\ndata: {}\n\n');
    // Never end: a reader that leaks would leave this response alive.
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  if (!address || typeof address === 'string')
    throw new Error('Missing test server address');
  try {
    await test(`http://127.0.0.1:${address.port}/`, closed);
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  }
}

async function expectDisconnected(disconnected: Promise<void>): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      disconnected,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(
          () => reject(new Error('HTTP stream retained its connection')),
          2000,
        );
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

describe('browser HTTP stream connection ownership', () => {
  it('closes the underlying response when the consumer cancels after a chunk', async () => {
    await withStreamingServer(async (url, disconnected) => {
      const controller = new AbortController();
      const reason = new Error('consumer unmounted');
      let received = false;
      await expect(
        consumeHttpStream(url, {
          signal: controller.signal,
          onChunk: (bytes) => {
            received = bytes.byteLength > 0;
            controller.abort(reason);
          },
        }),
      ).rejects.toBe(reason);
      expect(received).toBe(true);
      await expectDisconnected(disconnected);
    });
  });

  it('closes the underlying response when the response callback rejects it', async () => {
    await withStreamingServer(async (url, disconnected) => {
      const reason = new Error('response rejected');
      let received = false;
      await expect(
        consumeHttpStream(url, {
          signal: new AbortController().signal,
          onResponse: () => {
            throw reason;
          },
          onChunk: () => {
            received = true;
          },
        }),
      ).rejects.toBe(reason);
      expect(received).toBe(false);
      await expectDisconnected(disconnected);
    });
  });
});
