import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { installFixedFederationTransport } from './fixed-transport.mjs';

const server = createServer((req, res) => {
  if (req.url === '/redirect') {
    res.writeHead(302, { location: '/target' });
    res.end();
    return;
  }
  res.setHeader('content-type', 'application/json');
  res.end(JSON.stringify({ host: req.headers.host, path: req.url }));
});
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const port = server.address().port;
after(() => new Promise((resolve) => server.close(resolve)));

function transport(t) {
  const discovery = { onApplicationShutdown: async () => {} };
  installFixedFederationTransport(discovery, {
    'aaa.test': `http://127.0.0.1:${port}`,
    'bbb.test': `http://127.0.0.1:${port}`,
  });
  t.after(() => discovery.onApplicationShutdown());
  return discovery;
}

test('shared targets preserve each logical authority without reverse lookup', async (t) => {
  const discovery = transport(t);
  for (const domain of ['aaa.test', 'bbb.test']) {
    const base = await discovery.resolveBase(domain);
    assert.equal(base, `http://${domain}:${port}`);
    const response = await discovery.request(`${base}/signed?value=1`);
    assert.deepEqual(await response.json(), {
      host: `${domain}:${port}`,
      path: '/signed?value=1',
    });
  }
});

test('invalidation rebuilds usable pools and shutdown rejects further requests', async (t) => {
  const discovery = transport(t);
  const base = await discovery.resolveBase('aaa.test');
  await (await discovery.request(base)).text();
  discovery.invalidateBase('aaa.test');
  await discovery.refreshRoute('aaa.test');
  assert.equal((await discovery.request(base)).status, 200);
  await discovery.onApplicationShutdown();
  await assert.rejects(discovery.request(base), /shutting down/);
});

test('unknown peers and wrong ports fail closed; redirects remain manual', async (t) => {
  const discovery = transport(t);
  await assert.rejects(discovery.resolveBase('unknown.test'), /No fixed/);
  await assert.rejects(discovery.request('http://aaa.test:1/'), /authority/);
  const base = await discovery.resolveBase('aaa.test');
  const response = await discovery.request(`${base}/redirect`);
  assert.equal(response.status, 302);
  await response.text();
});
