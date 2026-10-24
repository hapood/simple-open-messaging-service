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
{ "target": "https://example.com:7668" }
```

A bare domain is interpreted as HTTPS. Explicit ports are preserved. Application paths are ignored;
credentials, query parameters, fragments, and non-HTTPS schemes are rejected. Opening the page does
not start a diagnostic.

The backend resolves A/AAAA and reports SRV records independently. SRV records are observations only:
they do not silently redirect probes away from the input origin. Up to eight addresses, interleaving
IPv4 and IPv6, are probed concurrently. Results explicitly enumerate selected addresses. The HTTPS
request uses `/.well-known/somfp`; TLS and HTTP reachability are reported separately from federation
document validation. A 404/410 discovery response means no federation document, not broken HTTPS.

Public unicast destinations only are accepted, including literal IPs. Mixed public/private DNS
answers reject the target. Each socket is pinned to the validated address and address family; no
redirect is followed. DNS has a three-second deadline and each HTTPS probe a seven-second deadline.
Responses are capped at 256 KiB. There is one active diagnostic per process and a three-second
completion cooldown. Diagnostic reports do not establish trust or update peer caches.

Internal targets, external-IP providers, NTP comparisons, SRV endpoint probing, and browser-origin
measurements are not part of this API.

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
