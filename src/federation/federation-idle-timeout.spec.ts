import { createServer, type Server, type RequestListener } from 'node:http';
import type { AddressInfo } from 'node:net';
import { Agent, buildConnector } from 'undici';
import { afterEach, describe, expect, it } from 'vitest';
import { requestFederation } from './federation-transport.js';

const servers: Server[] = [];
const agents: Agent[] = [];
const timers = new Set<ReturnType<typeof setInterval>>();

async function serve(handler: RequestListener) {
  const server = createServer(handler);
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

function agent() {
  const value = new Agent();
  agents.push(value);
  return value;
}

afterEach(async () => {
  for (const timer of timers) clearInterval(timer);
  timers.clear();
  await Promise.all(agents.splice(0).map((value) => value.destroy()));
  await Promise.all(
    servers.splice(0).map(
      (server) =>
        new Promise<void>((resolve) => {
          server.closeAllConnections();
          server.close(() => resolve());
        }),
    ),
  );
});

describe('federation response inactivity deadlines', () => {
  it('bounds waiting for response headers', async () => {
    const url = await serve(() => undefined);
    await expect(
      requestFederation(url, agent(), {}, undefined, 100),
    ).rejects.toMatchObject({ code: 'UND_ERR_HEADERS_TIMEOUT' });
  });

  it('aborts a stalled response body and closes the connection', async () => {
    let closed!: () => void;
    const disconnected = new Promise<void>((resolve) => {
      closed = resolve;
    });
    const url = await serve((_req, res) => {
      res.writeHead(200);
      res.write('first');
      res.on('close', closed);
    });
    const response = await requestFederation(url, agent(), {}, undefined, 100);
    await expect(response.text()).rejects.toMatchObject({
      code: 'UND_ERR_BODY_TIMEOUT',
    });
    await disconnected;
  });

  it('allows a streaming body to exceed the timeout while bytes keep arriving', async () => {
    const url = await serve((_req, res) => {
      res.writeHead(200);
      res.write('x');
      let count = 0;
      const timer = setInterval(() => {
        res.write('x');
        if (++count === 12) {
          clearInterval(timer);
          timers.delete(timer);
          res.end();
        }
      }, 100);
      timers.add(timer);
    });
    const response = await requestFederation(url, agent(), {}, undefined, 400);
    expect(await response.text()).toBe('x'.repeat(13));
  });

  it('does not charge connection establishment to the response deadline', async () => {
    const url = await serve((_req, res) => res.end('ok'));
    const connect = buildConnector({ timeout: 2000 });
    const delayed = new Agent({
      connect(options, callback) {
        setTimeout(() => connect(options, callback), 1200);
      },
    });
    agents.push(delayed);
    const response = await requestFederation(url, delayed, {}, undefined, 100);
    expect(await response.text()).toBe('ok');
  });

  it('preserves pool cancellation after headers arrive', async () => {
    const url = await serve((_req, res) => res.write('first'));
    const cancellation = new AbortController();
    const response = await requestFederation(
      url,
      agent(),
      {},
      cancellation.signal,
    );
    const body = response.text();
    cancellation.abort(new Error('pool retired'));
    await expect(body).rejects.toThrow();
  });

  it('does not follow redirects and handles empty responses', async () => {
    const url = await serve((req, res) => {
      if (req.url === '/empty') res.writeHead(204).end();
      else res.writeHead(302, { location: '/empty' }).end();
    });
    const dispatcher = agent();
    const redirected = await requestFederation(url, dispatcher);
    expect(redirected.status).toBe(302);
    await redirected.body?.cancel();
    const empty = await requestFederation(`${url}/empty`, dispatcher);
    expect(empty.status).toBe(204);
    expect(empty.body).toBeNull();
  });
});
