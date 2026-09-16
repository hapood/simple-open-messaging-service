// A lightweight one-way HTTP relay for the federation e2e: appB → appA. It exists for ONE purpose —
// fault injection on the resume test. localhost never drops bytes, so to exercise appB's resumable
// media transport (mid-stream stall → re-request the SAME range, no degradation) the test must inject a
// truncation. Rather than stub appB's in-process fetch (impossible across processes) or add a test
// branch to production media handling, this proxy sits on the path and can drop a response mid-stream.
//
// Default behavior is fully transparent: relay the request to appA preserving the original `Host` header
// (== appB's signed @authority — so RFC9421 signatures still verify at appA) + the body, and pipe the
// response back unchanged. `armGetFileTruncation()` makes the next media `bytes=0-` response
// relay only its first chunk then destroy both sockets (a simulated mid-stream network drop); appB must
// detect the short read, discard the partial unit, and re-request the same range. One-shot (re-arms are
// the test's job), deterministic (not random — random would flake).
import http from 'node:http';
import { createHash } from 'node:crypto';

export interface S2sProxy {
  port: number;
  /** One-shot: the next media first-range response is truncated mid-stream. */
  armGetFileTruncation: () => void;
  /** One-shot: return HTTP 503 for the next request whose pathname exactly matches. */
  armServiceUnavailable: (pathname: string) => void;
  /** Hold the armed 503 response while another request completes, then release it. */
  blockServiceUnavailable: (blocked: boolean) => void;
  blockedServiceUnavailableCount: () => number;
  /** While blocked, every relayed request is destroyed at the socket — a transport-level
   *  "peer unreachable" with no process stop. Destroyed requests are not resumed on unblock;
   *  the client's retry policy re-issues them. */
  blockRelays: (blocked: boolean) => void;
  /** How many media `bytes=0-` requests appB has issued through the proxy. The resume test asserts
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
  /** Hold media requests open until released. Used to leave a durable DOWNLOADING row across a
   *  real receiver-process restart without adding test branches to production code. */
  blockGetFile: (blocked: boolean) => void;
  blockedGetFileCount: () => number;
  /** Hold all message-query requests while state-feed continues normally. This lets tests prove that a
   * relationship-closing state snapshot is applied before its inclusive final message boundary. */
  blockMessageFeed: (blocked: boolean) => void;
  blockedMessageFeedCount: () => number;
  /** Buffer completed message-query responses until released. */
  blockMessageFeedResponse: (blocked: boolean) => void;
  blockedMessageFeedResponseCount: () => number;
  /** Hold tombstone queries open while other federation traffic continues normally. */
  blockTombstoneFeed: (blocked: boolean) => void;
  blockedTombstoneFeedCount: () => number;
  /** Hold only reverse message queries (`before` cursor) while forward synchronization continues. */
  blockReverseMessages: (blocked: boolean) => void;
  blockedReverseMessageCount: () => number;
  /** Hold state-feed GETs while feed-heads wake-ups continue. Used to prove
   * a mirror does not activate a join before the origin confirms GROUP_META. */
  blockStateFeed: (blocked: boolean) => void;
  blockedStateFeedCount: () => number;
  /** Hold Recognize requests while Health and ordinary traffic continue. */
  blockRecognize: (blocked: boolean) => void;
  blockedRecognizeCount: () => number;
  /** Serve one digest from proxy memory so the two test processes can model physically separate CAS roots. */
  setGetFileFixture: (digest: string, bytes: Buffer | null) => void;
  close: () => Promise<void>;
}

export function startS2sProxy(appAPort: number): Promise<S2sProxy> {
  return new Promise((resolve, reject) => {
    // One-shot truncation flag — set by the resume test, cleared after it fires once.
    let truncateNextGetFile = false;
    let serviceUnavailablePath: string | null = null;
    let serviceUnavailableBlocked = false;
    const blockedServiceUnavailable = new Set<() => void>();
    // Sticky partition flag — while set, every relayed request is destroyed instead
    // of forwarded (the "peer unreachable" arm; no process lifecycle involved).
    let relaysBlocked = false;
    // Running count of media first-range requests seen (initial + any retries).
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
    let messageFeedResponseBlocked = false;
    const blockedMessageFeedResponses = new Set<() => void>();
    let tombstoneFeedBlocked = false;
    const blockedTombstoneFeeds = new Set<() => void>();
    let reverseMessagesBlocked = false;
    const blockedReverseMessages = new Set<() => void>();
    let stateFeedBlocked = false;
    const blockedStateFeeds = new Set<() => void>();
    let recognizeBlocked = false;
    const blockedRecognizes = new Set<() => void>();
    const getFileFixtures = new Map<string, Buffer>();

    const server = http.createServer((req, res) => {
      totalCount++;
      if (relaysBlocked) {
        requests.push({
          method: req.method ?? 'GET',
          path: req.url ?? '/',
          status: 0,
        });
        res.destroy();
        return;
      }
      const range = req.headers['range'];
      const isGetFileFirstRange =
        typeof req.url === 'string' &&
        req.url.includes('/s2s/v1/media/') &&
        typeof range === 'string' &&
        range.startsWith('bytes=0-');
      if (isGetFileFirstRange) firstRangeCount++;
      const shouldTruncate = isGetFileFirstRange && truncateNextGetFile;
      const requestUrl = new URL(
        req.url ?? '/',
        'http://federation-proxy.invalid',
      );
      const isMessageFeed = requestUrl.pathname === '/s2s/v1/messages';
      const isTombstoneFeed =
        requestUrl.pathname === '/s2s/v1/message-tombstones';
      const isReverseMessageQuery =
        isMessageFeed && requestUrl.searchParams.has('before');
      // The first compact-feed request intentionally has no `after` query
      // parameter. Match the route by pathname so bootstrap and resumed pulls
      // are both eligible for state-feed fault injection.
      const isStateFeed = requestUrl.pathname === '/s2s/v1/state-feed';
      const isRecognize = requestUrl.pathname === '/s2s/v1/recognize';
      if (shouldTruncate) truncateNextGetFile = false; // consume the one-shot
      if (requestUrl.pathname === serviceUnavailablePath) {
        serviceUnavailablePath = null;
        const respond = (): void => {
          blockedServiceUnavailable.delete(respond);
          if (req.aborted) return;
          requests.push({
            method: req.method ?? 'GET',
            path: req.url ?? '/',
            status: 503,
          });
          res.writeHead(503, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ code: 10000, message: 'fault injected' }));
        };
        if (serviceUnavailableBlocked) {
          blockedServiceUnavailable.add(respond);
          req.once('aborted', () => blockedServiceUnavailable.delete(respond));
        } else {
          respond();
        }
        return;
      }

      const relay = (): void => {
        // A bodyless GET can have a normally completed/destroyed IncomingMessage while its response is
        // intentionally held by this proxy. `destroyed` therefore does not mean that the client cancelled
        // the exchange; `aborted` is the signal that makes a queued relay unsafe to resume.
        if (req.aborted) return;
        const fixtureDigest = /^\/s2s\/v1\/media\/([a-f0-9]{64})(?:\?|$)/.exec(
          req.url ?? '/',
        )?.[1];
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
              'sha-256=:' +
              createHash('sha256').update(body).digest('base64') +
              ':',
            ...(shouldTruncate ? { connection: 'close' } : {}),
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
            if (isMessageFeed && messageFeedResponseBlocked) {
              const chunks: Buffer[] = [];
              upRes.on('data', (chunk: Buffer) => {
                chunks.push(chunk);
                if (requestEntry.responseBody.length < 4096)
                  requestEntry.responseBody = (
                    requestEntry.responseBody + chunk.toString('utf8')
                  ).slice(0, 4096);
              });
              upRes.on('end', () => {
                const resume = (): void => {
                  blockedMessageFeedResponses.delete(resume);
                  if (res.destroyed) return;
                  res.writeHead(upRes.statusCode ?? 200, upRes.headers);
                  res.end(Buffer.concat(chunks));
                };
                blockedMessageFeedResponses.add(resume);
                res.once('close', () =>
                  blockedMessageFeedResponses.delete(resume),
                );
                if (!messageFeedResponseBlocked) resume();
              });
              return;
            }
            upRes.on('data', (chunk: Buffer) => {
              if (requestEntry.responseBody.length < 4096)
                requestEntry.responseBody = (
                  requestEntry.responseBody + chunk.toString('utf8')
                ).slice(0, 4096);
            });
            if (shouldTruncate) {
              // Send the 206 HEADERS (appA's Content-Range advertises the full unit), relay only a FEW body
              // bytes, then END cleanly (a FIN — NOT a socket destroy). appB's fetch RESOLVES (2xx) so it is
              // NOT a peer-degrading network failure; its body read then yields a byte-count mismatch
              // (buf.length < unitLen) → fetchMediaChunks discards the partial unit + re-requests the SAME
              // range (resume). A destroy/RST would reject the fetch → markTransportDegraded (wrong). Capped at 8 bytes
              // so the unit (chunkBytes=64) is guaranteed incomplete even if the first chunk is a full unit.
              res.writeHead(upRes.statusCode ?? 206, {
                ...upRes.headers,
                connection: 'close',
              });
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
      if (isTombstoneFeed && tombstoneFeedBlocked) {
        const resume = (): void => {
          blockedTombstoneFeeds.delete(resume);
          relay();
        };
        blockedTombstoneFeeds.add(resume);
        req.once('aborted', () => blockedTombstoneFeeds.delete(resume));
        return;
      }
      if (isReverseMessageQuery && reverseMessagesBlocked) {
        const resume = (): void => {
          blockedReverseMessages.delete(resume);
          relay();
        };
        blockedReverseMessages.add(resume);
        req.once('aborted', () => blockedReverseMessages.delete(resume));
        return;
      }
      if (isStateFeed && stateFeedBlocked) {
        const resume = (): void => {
          blockedStateFeeds.delete(resume);
          relay();
        };
        blockedStateFeeds.add(resume);
        req.once('aborted', () => blockedStateFeeds.delete(resume));
        return;
      }
      if (isRecognize && recognizeBlocked) {
        const resume = (): void => {
          blockedRecognizes.delete(resume);
          relay();
        };
        blockedRecognizes.add(resume);
        req.once('aborted', () => blockedRecognizes.delete(resume));
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
        armServiceUnavailable: (pathname: string) => {
          serviceUnavailablePath = pathname;
        },
        blockServiceUnavailable: (blocked: boolean) => {
          serviceUnavailableBlocked = blocked;
          if (!blocked) {
            for (const respond of [...blockedServiceUnavailable]) respond();
          }
        },
        blockedServiceUnavailableCount: () => blockedServiceUnavailable.size,
        blockRelays: (blocked: boolean) => {
          relaysBlocked = blocked;
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
        blockMessageFeedResponse: (blocked: boolean) => {
          messageFeedResponseBlocked = blocked;
          if (!blocked) {
            for (const resume of [...blockedMessageFeedResponses]) resume();
          }
        },
        blockedMessageFeedResponseCount: () => blockedMessageFeedResponses.size,
        blockTombstoneFeed: (blocked: boolean) => {
          tombstoneFeedBlocked = blocked;
          if (!blocked) {
            for (const resume of [...blockedTombstoneFeeds]) resume();
          }
        },
        blockedTombstoneFeedCount: () => blockedTombstoneFeeds.size,
        blockReverseMessages: (blocked: boolean) => {
          reverseMessagesBlocked = blocked;
          if (!blocked) {
            for (const resume of [...blockedReverseMessages]) resume();
          }
        },
        blockedReverseMessageCount: () => blockedReverseMessages.size,
        blockStateFeed: (blocked: boolean) => {
          stateFeedBlocked = blocked;
          if (!blocked) {
            for (const resume of [...blockedStateFeeds]) resume();
          }
        },
        blockedStateFeedCount: () => blockedStateFeeds.size,
        blockRecognize: (blocked: boolean) => {
          recognizeBlocked = blocked;
          if (!blocked) {
            for (const resume of [...blockedRecognizes]) resume();
          }
        },
        blockedRecognizeCount: () => blockedRecognizes.size,
        setGetFileFixture: (digest: string, bytes: Buffer | null) => {
          if (bytes) getFileFixtures.set(digest, bytes);
          else getFileFixtures.delete(digest);
        },
        close: () => new Promise<void>((r) => server.close(() => r())),
      });
    });
  });
}
