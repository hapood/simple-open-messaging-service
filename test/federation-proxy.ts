// A lightweight one-way HTTP relay for the federation e2e: appB → appA. It exists for ONE purpose —
// fault injection on the resume test. localhost never drops bytes, so to exercise appB's resumable
// /get_file transport (mid-stream stall → re-request the SAME range, no demote) the test must inject a
// truncation. Rather than stub appB's in-process fetch (impossible across processes) or add a test
// branch to production /get_file, this proxy sits on the path and can drop a response mid-stream.
//
// Default behavior is fully transparent: relay the request to appA preserving the original `Host` header
// (== appB's signed @authority — so RFC9421 signatures still verify at appA) + the body, and pipe the
// response back unchanged. `armGetFileTruncation()` makes the next `/s2s/get_file` `bytes=0-` response
// relay only its first chunk then destroy both sockets (a simulated mid-stream network drop); appB must
// detect the short read, discard the partial unit, and re-request the same range. One-shot (re-arms are
// the test's job), deterministic (not random — random would flake).
import http from 'node:http';
import { createHash } from 'node:crypto';

export interface S2sProxy {
  port: number;
  /** One-shot: the next `/get_file` first-range response is truncated mid-stream. */
  armGetFileTruncation: () => void;
  /** How many `/get_file` `bytes=0-` requests appB has issued through the proxy. The resume test asserts
   *  this is ≥2 (initial + the retry after the truncation) → appB re-requested the SAME range (resume). */
  firstRangeGetFileCount: () => number;
  /** Total requests the proxy has relayed (debug: confirms appB's traffic is routing through it at all). */
  totalRequestCount: () => number;
  requestLog: () => Array<{
    method: string;
    path: string;
    status: number;
    responseBody?: string;
  }>;
  clearRequestLog: () => void;
  /** Hold `/get_file` requests open until released. Used to leave a durable DOWNLOADING row across a
   *  real receiver-process restart without adding test branches to production code. */
  blockGetFile: (blocked: boolean) => void;
  blockedGetFileCount: () => number;
  /** Hold message-feed requests while state-feed continues normally. This lets tests prove that a
   * relationship-closing state snapshot is applied before its inclusive final message boundary. */
  blockMessageFeed: (blocked: boolean) => void;
  blockedMessageFeedCount: () => number;
  /** Serve one digest from proxy memory so the two test processes can model physically separate CAS roots. */
  setGetFileFixture: (digest: string, bytes: Buffer | null) => void;
  close: () => Promise<void>;
}

export function startS2sProxy(appAPort: number): Promise<S2sProxy> {
  return new Promise((resolve, reject) => {
    // One-shot truncation flag — set by the resume test, cleared after it fires once.
    let truncateNextGetFile = false;
    // Running count of `/get_file` first-range requests seen (initial + any retries).
    let firstRangeCount = 0;
    // Total requests relayed (debug).
    let totalCount = 0;
    const requests: Array<{
      method: string;
      path: string;
      status: number;
      responseBody?: string;
    }> = [];
    let getFileBlocked = false;
    const blockedGetFiles = new Set<() => void>();
    let messageFeedBlocked = false;
    const blockedMessageFeeds = new Set<() => void>();
    const getFileFixtures = new Map<string, Buffer>();

    const server = http.createServer((req, res) => {
      totalCount++;
      const range = req.headers['range'];
      const isGetFileFirstRange =
        typeof req.url === 'string' &&
        req.url.includes('/s2s/get_file') &&
        typeof range === 'string' &&
        range.startsWith('bytes=0-');
      if (isGetFileFirstRange) firstRangeCount++;
      const shouldTruncate = isGetFileFirstRange && truncateNextGetFile;
      const isMessageFeed =
        typeof req.url === 'string' && req.url.includes('/s2s/message-feed');
      if (shouldTruncate) truncateNextGetFile = false; // consume the one-shot

      const relay = (): void => {
        if (res.destroyed || req.destroyed) return;
        const fixtureDigest = new URL(
          req.url ?? '/',
          'http://federation.test',
        ).searchParams.get('digest');
        const fixture = fixtureDigest
          ? getFileFixtures.get(fixtureDigest)
          : undefined;
        if (fixture && typeof range === 'string') {
          const match = /^bytes=(\d+)-(\d+)$/.exec(range);
          if (!match) {
            requests.push({
              method: req.method ?? 'GET',
              path: req.url ?? '/',
              status: 416,
            });
            res.writeHead(416).end();
            return;
          }
          const start = Number(match[1]);
          const end = Math.min(Number(match[2]), fixture.length - 1);
          if (start > end || start >= fixture.length) {
            requests.push({
              method: req.method ?? 'GET',
              path: req.url ?? '/',
              status: 416,
            });
            res.writeHead(416).end();
            return;
          }
          const body = fixture.subarray(start, end + 1);
          requests.push({
            method: req.method ?? 'GET',
            path: req.url ?? '/',
            status: 206,
          });
          res.writeHead(206, {
            'content-length': body.length,
            'content-range': `bytes ${start}-${end}/${fixture.length}`,
            'content-digest':
              'sha-256=' + createHash('sha256').update(body).digest('base64'),
          });
          if (shouldTruncate) {
            res.write(body.subarray(0, Math.min(body.length, 8)));
            res.end();
          } else {
            res.end(body);
          }
          return;
        }
        const upstream = http.request(
          {
            hostname: '127.0.0.1',
            port: appAPort,
            path: req.url,
            method: req.method,
            // Preserve the ORIGINAL Host header verbatim — it carries appB's signed @authority. Deriving it
            // from hostname/port would rewrite it to appA's address and break the signature at appA.
            headers: { ...req.headers, host: req.headers['host'] },
          },
          (upRes) => {
            const requestEntry = {
              method: req.method ?? 'GET',
              path: req.url ?? '/',
              status: upRes.statusCode ?? 500,
              responseBody: '',
            };
            requests.push(requestEntry);
            upRes.on('data', (chunk: Buffer) => {
              if (requestEntry.responseBody.length < 4096)
                requestEntry.responseBody = (
                  requestEntry.responseBody + chunk.toString('utf8')
                ).slice(0, 4096);
            });
            if (shouldTruncate) {
              // Send the 206 HEADERS (appA's Content-Range advertises the full unit), relay only a FEW body
              // bytes, then END cleanly (a FIN — NOT a socket destroy). appB's fetch RESOLVES (2xx) so it is
              // NOT a demote-able network failure; its body read then yields a byte-count mismatch
              // (buf.length < unitLen) → fetchMediaChunks discards the partial unit + re-requests the SAME
              // range (resume). A destroy/RST would reject the fetch → markDemoted (wrong). Capped at 8 bytes
              // so the unit (chunkBytes=64) is guaranteed incomplete even if the first chunk is a full unit.
              res.writeHead(upRes.statusCode ?? 206, upRes.headers);
              let relayedFirst = false;
              upRes.on('data', (chunk: Buffer) => {
                if (!relayedFirst) {
                  relayedFirst = true;
                  res.write(chunk.subarray(0, Math.min(chunk.length, 8)));
                  res.end();
                  upRes.destroy();
                }
              });
              upRes.on('end', () => res.end());
            } else {
              res.writeHead(upRes.statusCode ?? 200, upRes.headers);
              upRes.pipe(res);
            }
          },
        );
        upstream.on('error', () => {
          try {
            res.destroy();
          } catch {
            /* already gone */
          }
        });
        // A fault-injected GET may be resumed after IncomingMessage already
        // emitted `end`. Piping an ended readable does not end a newly-created
        // ClientRequest, so finish the bodyless upstream request explicitly.
        if (req.readableEnded) upstream.end();
        else req.pipe(upstream);
      };

      if (isGetFileFirstRange && getFileBlocked) {
        const resume = (): void => {
          blockedGetFiles.delete(resume);
          relay();
        };
        blockedGetFiles.add(resume);
        req.once('close', () => blockedGetFiles.delete(resume));
        return;
      }
      if (isMessageFeed && messageFeedBlocked) {
        const resume = (): void => {
          blockedMessageFeeds.delete(resume);
          relay();
        };
        blockedMessageFeeds.add(resume);
        // IncomingMessage emits `close` after a normally completed GET request
        // body too; removing on that event would silently discard the held
        // request. Only an actual client abort cancels its queued relay.
        req.once('aborted', () => blockedMessageFeeds.delete(resume));
        return;
      }
      relay();
    });

    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address() as { port: number };
      resolve({
        port,
        armGetFileTruncation: () => {
          truncateNextGetFile = true;
        },
        firstRangeGetFileCount: () => firstRangeCount,
        totalRequestCount: () => totalCount,
        requestLog: () => [...requests],
        clearRequestLog: () => {
          requests.length = 0;
        },
        blockGetFile: (blocked: boolean) => {
          getFileBlocked = blocked;
          if (!blocked) {
            for (const resume of [...blockedGetFiles]) resume();
          }
        },
        blockedGetFileCount: () => blockedGetFiles.size,
        blockMessageFeed: (blocked: boolean) => {
          messageFeedBlocked = blocked;
          if (!blocked) {
            for (const resume of [...blockedMessageFeeds]) resume();
          }
        },
        blockedMessageFeedCount: () => blockedMessageFeeds.size,
        setGetFileFixture: (digest: string, bytes: Buffer | null) => {
          if (bytes) getFileFixtures.set(digest, bytes);
          else getFileFixtures.delete(digest);
        },
        close: () => new Promise<void>((r) => server.close(() => r())),
      });
    });
  });
}
