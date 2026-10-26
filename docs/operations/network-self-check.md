# Network diagnostics and local information

The admin navigation separates **Network** (`/admin/network`) from **Local Information**
(`/admin/local-information`). The former network-info and self-check routes and APIs have been
removed, not redirected. Update bookmarks and integrations to the new contracts.

## Local information

`POST /api/v1/admin/local-information` requires an administrator session (including viewers).
It returns version, runtime, process start/uptime, server time, configured client origin and TLS mode,
process-visible interfaces, and public federation identity material. Root history and published
signing certificates are public data; private keys and authentication secrets are never returned.

This endpoint reads local state only: no DNS, HTTP, NTP, loopback, or key-rotation work. Configured
origins do not prove reachability; the server timestamp does not prove clock synchronization.
`SOMS_RUNTIME=docker` is an explicit image marker, not host/container autodetection. Interface
addresses describe the process network namespace rather than all host interfaces.

## Explicit target diagnostics

`POST /api/v1/admin/network/diagnose` requires an ADMIN or SUPER_ADMIN session and a body such as:

```json
{ "target": "example.com" }
```

Only a federation identity domain is accepted. Schemes, explicit ports, paths, credentials, query
parameters, fragments, and IP literals are rejected; the former URL-input mode is removed. Opening
the page does not start a diagnostic.

The backend queries `_somfp._tcp.<domain>` and uses the same priority/weight selection helper as
outbound federation discovery. Missing, disabled, invalid, or failed SRV answers stop the diagnostic:
there is no implicit port 443 fallback. The report includes all SRV records and the selected route
(`domain`, connection `host`, `port`, and HTTPS identity `origin`). Only the selected endpoint is
probed; this is not an exhaustive check of every SRV candidate.

Both `DiscoveryService` and diagnostics call the shared primitives in
[`federation-transport.ts`](../../src/federation/federation-transport.ts): SRV resolution,
Undici connector construction, HTTP dispatch, and discovery response validation. There is no
separate `node:https` diagnostic client. OS DNS lookup resolves the selected SRV host, not the
identity domain. The connector uses the same OS address ordering and Undici address-family selection
for both callers; diagnostics no longer fan out into separate per-address probes. Reports show the
resolved addresses and the actual connected address, port, and certificate.

The HTTPS request uses the identity domain for Host, SNI, certificate verification, and discovery
document validation. The path is always `/.well-known/somfp`. TLS reachability is separate from
protocol validation: 404/410 is a failed discovery document, not a failed TLS handshake, just as in
real federation discovery. Both callers enforce JSON Content-Type, the 256 KiB streaming body cap,
and document/signature validity. Responses are cancelled on error; redirects are never followed.

Diagnostics pass an explicit public-unicast destination policy into the shared connector. Mixed
public/private DNS answers reject the selected endpoint before connection. This does not add a
second DNS lookup: the checked addresses are delivered directly to the same connector. The report
and page disclose this policy and the fresh-connection policy. Diagnostics use an isolated,
always-destroyed pool and fresh SRV lookup, whereas ordinary traffic retains its route and
keep-alive caches. They use the same runtime connection and response-inactivity timeout settings;
the SRV lookup is bounded by the connection timeout. The response deadline starts after connection
establishment, with 30 seconds by default to receive headers and between body data segments.
See [Federation transport timeouts](federation-transport-timeouts.md) for configuration requirements. Diagnostics require HTTPS even when insecure HTTP is explicitly
enabled for a development federation host.

There is one active diagnostic per process and a three-second completion cooldown. Business HTTP
queueing remains owned by business callers; diagnostic concurrency is independently limited.
Reports do not establish trust, mutate peer caches, or perform signed Health/Recognize operations.

Internal targets, external-IP providers, NTP comparisons, and browser-origin measurements are not
part of this API. These safety restrictions differ from ordinary federation transport: a failed
public-destination policy check does not imply an internal peer is unreachable.

## Quota navigation

**Quota** has a circuit-breaker overview and default policies. The overview filters existing tripped
user/peer breakers and reuses the daily-addition dialog. It is not a complete near-limit inventory.
Detailed usage remains under Users and Federation. Default forms have moved out of Settings, which
links to Quota defaults. Existing quota API contracts and mutation roles remain unchanged.

## Verification

```sh
npx vitest run src/federation/self-check src/federation/federation-peer-lifecycle.spec.ts
npm test --prefix admin-web
npm run build:be
npm run build --prefix admin-web
```
