# Network addresses on the federation self-check page

The administration console groups the report into local/public IP addresses,
federation overview, configuration, DNS, connectivity/TLS, discovery, keys and
clock. Desktop navigation stays alongside the report; narrow screens use a
horizontal navigation bar. Network inspection is independent of running the
federation check.

## Local addresses

`POST /api/v1/admin/federation/network-info` requires an administrator session.
It reads the current process's interface addresses using Node's OS API and returns
the available public-IP sources. No external service is contacted. Loopback and
link-local addresses are collapsed initially when other addresses are available.

The final runtime stage of [Dockerfile](../../Dockerfile) declares
`SOMS_RUNTIME=docker`. This is an image marker, not container detection: the API
does not inspect cgroups, Docker sockets, host routing or Docker network modes.
An unset marker is reported as unknown rather than assumed to be a host process.
Existing containers must be recreated from an updated image to inherit the marker.

## Public egress IP

`POST /api/v1/admin/federation/network-ip` requires an administrator session and
accepts a fixed source ID and address family (`4` or `6`). Sources are IP.SB,
ipify and ident.me. The UI selects IP.SB initially; requests are only sent
after the operator clicks **Detect public IP**. Multiple sources can be selected.
Each source/family completes independently, without IPv6-to-IPv4 fallback.

The report shows the provider-observed egress IP, the socket's local source address
when available, a timestamp, duration and any error code. Provider requests are
sent directly rather than through environment-configured HTTP proxies. Selected
providers necessarily observe the server's egress IP; credentials and local
interface inventories are not sent to them.

The [inspection service](../../src/federation/self-check/network-inspection.service.ts)
uses fixed HTTPS endpoints, a five-second overall deadline and a 256-byte response
limit. Redirects, non-public resolved destinations, wrong address families and
non-IP response bodies are rejected. Concurrent requests for the same source and
family share a single probe; results are reused for ten seconds. This is not a
background polling task or a Docker liveness check.

## Interpretation

- Local interface addresses belong to the backend process's network environment,
  not the administrator's browser. In bridge containers they are container addresses.
- Egress addresses need not equal the DNS entry or reverse proxy's ingress address.
- Successful IPv6 ingress through a published Docker port does not prove IPv6 egress.
- An individual provider's failure is not proof of general connectivity failure.
- `EADDRNOTAVAIL` indicates local source-address unavailability; it is not a
  certificate-validation error.

## Verification

```sh
npx vitest run src/federation/self-check/network-inspection.service.spec.ts src/admin/federation-self-check.service.spec.ts
npm test --prefix admin-web
npm run build:be
npm run build --prefix admin-web
```
