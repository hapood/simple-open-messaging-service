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

export interface S2sProxy {
  port: number;
  /** One-shot: the next `/get_file` first-range response is truncated mid-stream. */
  armGetFileTruncation: () => void;
  /** How many `/get_file` `bytes=0-` requests appB has issued through the proxy. The resume test asserts
   *  this is ≥2 (initial + the retry after the truncation) → appB re-requested the SAME range (resume). */
  firstRangeGetFileCount: () => number;
  /** Total requests the proxy has relayed (debug: confirms appB's traffic is routing through it at all). */
  totalRequestCount: () => number;
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
      if (shouldTruncate) truncateNextGetFile = false; // consume the one-shot

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
        try { res.destroy(); } catch { /* already gone */ }
      });
      req.pipe(upstream);
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
        close: () =>
          new Promise<void>((r) => server.close(() => r())),
      });
    });
  });
}
