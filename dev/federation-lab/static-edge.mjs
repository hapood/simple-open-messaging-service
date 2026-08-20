import { createReadStream, existsSync, statSync } from 'node:fs';
import { createServer, request as httpRequest } from 'node:http';
import { extname, join, normalize, resolve } from 'node:path';

const listenPort = Number(process.argv[2]);
const backendPort = Number(process.argv[3]);
if (!Number.isInteger(listenPort) || !Number.isInteger(backendPort)) {
  throw new Error('usage: static-edge.mjs <listen-port> <backend-port>');
}

const root = process.cwd();
const webRoot = join(root, 'web', 'dist', 'web', 'browser');
const adminRoot = join(root, 'admin-web', 'dist');
const proxyPrefixes = ['/api/', '/uploads/', '/s2s/', '/.well-known/'];
const mime = {
  '.css': 'text/css; charset=utf-8',
  '.html': 'text/html; charset=utf-8',
  '.ico': 'image/x-icon',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.webp': 'image/webp',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
};
const hashedAssetName = /-[a-z0-9_-]{8}\.[^/]+$/i;

function fileEtag(file) {
  const stat = statSync(file, { bigint: true });
  return `"${stat.mtimeNs.toString(36)}-${stat.size.toString(36)}"`;
}

function matchesEtag(header, etag) {
  return header
    ?.split(',')
    .map((value) => value.trim().replace(/^W\//, ''))
    .some((value) => value === '*' || value === etag);
}

function proxy(req, res) {
  const upstream = httpRequest(
    {
      hostname: '127.0.0.1',
      port: backendPort,
      method: req.method,
      path: req.url,
      headers: { ...req.headers, host: `127.0.0.1:${backendPort}` },
    },
    (upstreamRes) => {
      res.writeHead(upstreamRes.statusCode ?? 502, upstreamRes.headers);
      upstreamRes.pipe(res);
    },
  );
  upstream.on('error', (error) => {
    if (!res.headersSent)
      res.writeHead(502, { 'content-type': 'text/plain; charset=utf-8' });
    res.end(`backend unavailable: ${error.message}`);
  });
  req.pipe(upstream);
}

function safeFile(base, relative, fallback) {
  const candidate = resolve(base, normalize(relative).replace(/^[/\\]+/, ''));
  if (
    candidate.startsWith(`${resolve(base)}/`) &&
    existsSync(candidate) &&
    statSync(candidate).isFile()
  ) {
    return candidate;
  }
  return join(base, fallback);
}

createServer((req, res) => {
  const pathname = new URL(req.url ?? '/', 'http://localhost').pathname;
  if (proxyPrefixes.some((prefix) => pathname.startsWith(prefix)))
    return proxy(req, res);

  const admin = pathname === '/admin' || pathname.startsWith('/admin/');
  const base = admin ? adminRoot : webRoot;
  const relative = admin
    ? pathname.replace(/^\/admin\/?/, '')
    : pathname.slice(1);
  const file = safeFile(base, relative || 'index.html', 'index.html');
  const extension = extname(file);
  const type = mime[extension] ?? 'application/octet-stream';
  const immutable = hashedAssetName.test(file);
  if (!immutable) {
    const etag = fileEtag(file);
    if (matchesEtag(req.headers['if-none-match'], etag)) {
      res.writeHead(304, { etag, 'cache-control': 'no-cache' });
      return res.end();
    }
    res.writeHead(200, {
      'content-type': type,
      'cache-control': 'no-cache',
      etag,
    });
    if (req.method === 'HEAD') return res.end();
    return createReadStream(file).pipe(res);
  }

  res.writeHead(200, {
    'content-type': type,
    'cache-control': 'public, max-age=31536000, immutable',
  });
  if (req.method === 'HEAD') return res.end();
  createReadStream(file).pipe(res);
}).listen(listenPort, '0.0.0.0', () => {
  console.log(
    `[lab-edge] http://0.0.0.0:${listenPort} -> backend :${backendPort}`,
  );
});
