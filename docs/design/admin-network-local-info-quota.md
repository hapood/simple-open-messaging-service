# Admin network, local information, and quota consolidation

## Scope and decisions

The console separates remote diagnostics, local facts, federation lifecycle, and quota operations.
Existing quota components and domain services remain authoritative; this is not a second quota system.

- **Network**: an operator supplies a target before an explicit probe. No automatic self-check.
  Results describe observations from the backend, not the administrator's browser.
- **Local information**: read configuration, public identity material, database metadata, and process
  interfaces without outbound DNS, HTTP, NTP, or loopback requests. Never serialize private keys or
  secret configuration. Configured addresses are not claims of reachability.
- **Federation**: remote namespaces only. Namespace zero is local storage, not an unrecognized peer.
  Pagination and counts must exclude it at the query boundary.
- **Quota**: one operational entry with an overview and default policies. User and peer details retain
  their existing quota panels. Move default policy forms out of settings rather than duplicating them.
  Reuse the existing daily-allowance dialog. Local user IDs and remote identity namespace IDs remain
  separate accounting scopes; domain names are not quota identities.

## Existing UI inventory

- User list quota summaries and `routes/users/user-quota-panel.tsx`.
- Federation list quota summaries and `routes/federation/peer-quota-panel.tsx`.
- Two default quota forms in `routes/settings/settings-page.tsx`.
- `components/admin/breaker-banner.tsx` and `continue-quota-dialog.tsx`.
- Network information hub currently combines local interfaces, public IP probes, and self-checks.

## Target navigation

- Network: explicit target diagnostics, replacing the network information hub.
- Local information: runtime, configured transport, identity and public keys, local interfaces.
- Quota: overview and defaults; overview links to object details and reuses daily additions.
- Federation and Users: retain contextual quota access.

Old network information and self-check URLs and APIs are removed, with no compatibility redirects.
The settings quota section links into Quota defaults. Network, Local Information, Quota, and Settings
navigation entries are enabled. No database migration or global shared quota pool is introduced.

## Security and presentation

Network diagnostics accept only bounded HTTPS targets without credentials. Pin socket destinations to
validated public DNS answers, reject private/reserved addresses including literal IPs, do not follow
redirects, and bound concurrency, total duration, and response bytes. Internal targets require a future
explicit allowlist rather than bypassing SSRF protection. Diagnostics must not establish trust or write
peer caches. A normal HTTPS site without federation discovery is not a failed network connection.

Local information uses explicit public-field DTOs. Do not return private signing keys, JWT secrets,
password hashes, or encryption material. Label process/container interfaces accurately. Do not report
clock synchronization or external reachability from local facts alone.

Quota reporting distinguishes unavailable data from a healthy quota. Remote quota association uses
namespace ID, not domain. Existing daily additions expire at UTC midnight and do not change base
limits or erase usage. Modification permissions remain enforced on the backend. Source comments and
configuration explain behavior directly and do not reference this document.

## Implementation checklist

- [x] Inventory existing surfaces and record agreed responsibilities.
- [x] Exclude local identity from federation list/count/detail; reject local block/unblock and admin recognition.
- [x] Add read-only local information API and page using only local state.
- [x] Add bounded, explicit-target network diagnostics API and page.
- [x] Enable relevant navigation, remove old network routes/APIs, and update bilingual labels.
- [x] Consolidate breaker overview/defaults using existing components and mutation hooks.
- [x] Correct namespace-based quota matching and unavailable/error states.
- [x] Add focused backend/frontend regression tests and run builds.

## Acceptance checks

1. Local namespace zero cannot appear in filtered/paginated remote peer results.
2. Opening Network sends no target probe; empty input cannot start one.
3. Probes cannot reach loopback, private, link-local, reserved, or redirect destinations.
4. Opening Local information performs no external probes and exposes public material only.
5. Default quota forms have one implementation and one primary route.
6. Existing user/peer quota editing and daily-addition interactions still work.
7. Local information never displays a fabricated local quota or peer recognition status.
8. All touched UI uses integer-pixel measured heights and line heights.

## Verification log

- Backend build and migration compiler: passed (`npm run build:be`).
- Admin production build: passed (`npm run build --prefix admin-web`); existing large-chunk warning remains.
- Admin suite: 24 files, 91 tests passed (`npm test --prefix admin-web`).
- Focused backend suite: 4 files, 37 tests passed (local information, public address restrictions,
  explicit-target diagnostics, and peer lifecycle).
- PostgreSQL regression: 2 tests passed (`npm run test:e2e -- test/federation-peer-list.e2e-spec.ts`).
  Checks namespace-zero exclusion, detail rejection, filtered totals, and pagination.
- Full backend unit suite: 238 files, 2179 tests passed.
- Full PostgreSQL e2e suite: 103 files, 736 tests passed, including federation and TLS rotation.
- Development transport and Docker configuration checks: 20 tests passed.
- Full production build: passed (`npm run build:production`).
- Manual browser visual verification remains outstanding.

### Federation regression cleanup

Disposable e2e and lab hosts inject fixed connection targets into their request implementation;
production configuration no longer contains a fixed-route map or origin-to-domain reverse lookup.
HTTP authority and TLS server identity stay domain-based. TLS fixtures include DNS SANs, and the
combined domain/signing rotation test asserts the existing contract: pending review preserves old
binding acceptance but does not establish a new binding before approval.

## Explicit limitations and follow-up

- Quota overview is a tripped-breaker work queue, not a complete near-limit inventory. Existing quota
  APIs are reused unchanged. A full all-dimension read model (including signals, byte budgets, and
  effective daily additions) needs a separately reviewed contract; existing peer count summaries must
  not be interpreted as a full server-capacity indicator.
- Diagnostics enumerate SRV records but do not probe those advertised endpoints. HTTPS probes target
  the operator's explicit origin, with at most eight interleaved IPv4/IPv6 addresses.
- Internal/private targets, external-IP providers, and NTP probes are not exposed by the new API.
- Frontend new API types are maintained in the admin client. The browser client's obsolete self-check
  generated declarations were removed; full OpenAPI regeneration is not part of this change.
