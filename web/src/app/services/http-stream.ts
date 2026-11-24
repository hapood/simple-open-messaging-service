import {
  consumeHttpStream,
  type HttpStreamTransport,
} from '../../../../shared/http-stream';
import { isTauri, tauriInvoke } from './runtime';

type StreamEvent =
  | { type: 'started' }
  | {
      type: 'headers';
      delivery_id: string;
      status: number;
      headers: Record<string, string>;
    }
  | { type: 'chunk'; delivery_id: string; bytes: number[] }
  | { type: 'end' }
  | { type: 'error'; error: { kind: string; message?: string } };

/** Browser and native SSE consumers share one interface; Rust owns native deadlines. */
export const appHttpStream: HttpStreamTransport = (url, options) => {
  if (!isTauri()) return consumeHttpStream(url, options);
  return new Promise<void>((resolve, reject) => {
    const Channel = window.__TAURI__?.core?.Channel;
    if (!Channel) {
      reject(new Error('Native streaming channel unavailable'));
      return;
    }
    if (options.signal.aborted) {
      reject(options.signal.reason);
      return;
    }
    const reqId = crypto.randomUUID();
    let settled = false;
    let started = false;
    let headersReceived = false;
    const cancel = () => {
      if (started)
        void tauriInvoke('cancel_http_request', { reqId }).catch(
          () => undefined,
        );
    };
    const finish = (error?: unknown) => {
      if (settled) return;
      settled = true;
      options.signal.removeEventListener('abort', abort);
      if (error !== undefined) reject(error);
      else resolve();
    };
    const abort = () => {
      cancel();
      finish(options.signal.reason ?? new Error('Stream cancelled'));
    };
    options.signal.addEventListener('abort', abort, { once: true });
    const acknowledge = (deliveryId: string) => {
      if (settled) return;
      void tauriInvoke('http_stream_ack', { deliveryId }).catch((error) => {
        cancel();
        finish(error);
      });
    };
    const channel = new Channel<StreamEvent>((event) => {
      if (settled) {
        if (event.type === 'started') {
          started = true;
          cancel();
        }
        return;
      }
      try {
        if (event.type === 'started') {
          if (started) throw new Error('Duplicate stream start');
          started = true;
          return;
        }
        if (!started) throw new Error('Stream event before start');
        switch (event.type) {
          case 'headers':
            if (headersReceived) throw new Error('Duplicate stream headers');
            headersReceived = true;
            options.onResponse?.(
              new Response(null, {
                status: event.status,
                headers: event.headers,
              }),
            );
            acknowledge(event.delivery_id);
            break;
          case 'chunk':
            if (!headersReceived) throw new Error('Stream data before headers');
            options.onChunk(new Uint8Array(event.bytes));
            acknowledge(event.delivery_id);
            break;
          case 'end':
            if (!headersReceived)
              throw new Error('Stream ended before headers');
            finish();
            break;
          case 'error':
            finish(
              Object.assign(
                new Error(event.error.message ?? event.error.kind),
                { kind: event.error.kind },
              ),
            );
            break;
        }
      } catch (error) {
        cancel();
        finish(error);
      }
    });
    const headers = Object.fromEntries(
      Object.entries(options.headers ?? {}).map(([key, value]) => [
        key.toLowerCase(),
        value,
      ]),
    );
    void tauriInvoke('http_stream_request', {
      reqId,
      method: options.method ?? 'GET',
      path: url,
      headers,
      body: options.body ? Array.from(options.body) : null,
      channel,
    }).catch((error) => finish(error));
  });
};
