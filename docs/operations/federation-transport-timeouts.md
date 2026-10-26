# Federation transport timeouts

All outbound federation HTTP traffic, including ordinary JSON requests, discovery,
Health, Recognize, namespace verification and media Range downloads, uses the shared
[transport](../../src/federation/federation-transport.ts).

## Deadlines

- SRV discovery and TCP/TLS connection establishment retain their independent
  `connectTimeoutSec` deadline (12 seconds by default).
- After a connection is ready and the request is dispatched, response headers must
  arrive within `requestIdleTimeoutSec` (30 seconds by default).
- After response headers arrive, each incoming response-body data segment resets
  the inactivity deadline. A stalled body fails and its connection is closed.
- Waiting for an application concurrency slot or a transport connection is not
  charged to the response deadline.
- There is no whole-response, whole-file or whole-operation duration limit. Slow
  continuous progress is allowed, including progress that exceeds 30 seconds.
- Local consumer backpressure pauses the transport's body timer: a consumer not
  ready to read is not evidence of a stalled peer. Undici enforces the deadlines
  using its network parser timers, not a business-layer polling loop.

A reused connection follows the same response rules without a new handshake.
These settings govern outbound requests, not inbound server request limits or
reverse-proxy configuration.

## Configuration

## Configuration

Outbound transport settings are stored as individual scalar records in
`SystemSetting`, using the `federation:transport:` key prefix:

- `federation:transport:keyCacheTtlSec`
- `federation:transport:connectTimeoutSec`
- `federation:transport:requestIdleTimeoutSec`
- `federation:transport:mediaChunkBytes`
- `federation:transport:mediaMaxChunkRetries`

On startup, each setting is read independently from `SystemSetting`. If any
individual key is missing, corrupted, or out of range, the service falls back to
the safe in-memory default for that specific parameter.
Legacy JSON-bundle settings under `federation:transport` are not recognized, converted,
or preserved. When saving through the administration API
(`POST /admin/settings/federation-transport`), all five values are validated
together and directly written to these five scalar keys in a single database transaction.

## Media retries

Each media chunk is fetched with an HTTP Range request, buffered and verified
before it advances the file offset. The default chunk size remains 8 MiB.
Connection/header failures, retryable peer responses, body inactivity, truncated
bodies and integrity failures share the finite per-chunk retry budget
(`mediaMaxChunkRetries`, default 5 retries after the initial attempt).

Permanent peer rejections and malformed Range responses are not retried.
Completed chunks are retained; a failed chunk is fetched again from the same
starting offset. There is no whole-file timeout, and this retry policy does not
add automatic retries to ordinary JSON requests.
