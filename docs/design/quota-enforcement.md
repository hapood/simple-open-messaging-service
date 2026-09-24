# Quota enforcement

## Scope and identity

Quota enforcement has two independent scopes:

- Federation traffic is charged to the active immutable `IdentityNamespace`,
  not directly to a peer domain. A domain-facing admin operation resolves the
  current namespace first. Retiring an identity therefore starts fresh limits,
  counters, allowances, and breaker state; it does not inherit the previous
  identity's traffic history.
- Local traffic is charged to the authenticated local account. Foreign and
  group accounts do not use personal quota tables.

The domain is an administrative lookup key. It is not a quota identity and must
not be used as a database counter key.

## Dimensions and persistence

Both scopes use message count, friend/request count, file item count, and total
file bytes. Federation also has a dedicated signal-frame count. File counts
and message/request counts use integer daily counters; byte totals use bigint.
All dates are UTC calendar dates and act as the reset boundary without a cron.

Federation tables are keyed by namespace and date:

- `QuotaDailyUsage(namespaceId, date, category)` stores count dimensions.
- `QuotaFileByteUsage(namespaceId, date)` stores the byte dimension.
- `QuotaDailyAllowance(namespaceId, date)` stores additive admin grants for
  the current day.
- `IdentityNamespace` stores optional per-namespace limit overrides.

Local tables use the corresponding `userId` key:
`UserQuotaPolicy`, `UserQuotaDailyUsage`, `UserQuotaFileByteUsage`, and
`UserQuotaDailyAllowance`. Local defaults are stored in `SystemSetting`; a
policy or allowance changes the effective limit without rewriting usage.

Every counter increment uses a database atomic upsert with `RETURNING`, rather
than an in-process counter. An allowance is additive to the base limit for
that date. The effective limit is the namespace/account override, when set,
otherwise the configured default, plus that day's allowance.

## Admission semantics

Federation count admission is authoritative at the transaction boundary. A
read-only peek may reject an already exhausted namespace before an expensive
operation, but the subsequent atomic tick remains the authority. When a tick
runs inside a source transaction, an over-limit exception rolls back the
counter and the source write together, so a rejected operation does not burn a
count or create a sequence gap.

Federated pull pages use the established landing semantics: a committed page
may cross a count threshold and trip the breaker; later pulls pause until the
UTC reset or an administrator adds allowance. File byte admission is strict
before transfer. Quota exhaustion is a business result and does not mark the
peer's transport health as degraded.

Local message and upload admission uses the account quota service. A local
user's paused dimensions stop that user's new sends/uploads while leaving
existing history, reads, calls, and other accounts usable. File claims are
checked against the persisted byte and item counters at admission; a restart
cannot bypass the authoritative check.

## Breakers and administration

The in-memory breaker is only a fast cache of persisted counters. It is rebuilt
from today's rows at startup and can self-heal on the next authoritative check.
It must never be treated as the source of truth. Breaker dimensions are
independent, so an exhausted file budget does not imply that messages or
requests are exhausted.

Administrators can set base limits for a federation namespace through the
domain-facing peer route. The route resolves the active identity namespace
before writing. The `continue` operation adds quota only for the current UTC
day and can clear a breaker once the effective limits are sufficient; it does
not alter the base policy. Local users have the corresponding additive
continue action. Every administrative change is audited according to the
Admin controller rules.

## Concurrency and recovery

Counter updates rely on PostgreSQL row-level atomicity and are safe under
concurrent requests. The quota write participates in the caller's transaction
where admission must commit or roll back with a message, upload, or federation
page. Standalone checks use their own transaction. The same operation must not
charge both a pre-check and its authoritative tick.

The date key supplies lazy daily reset. Old rows are historical usage and may
be retained or garbage-collected; they are never read as today's usage. A
namespace deletion cascades its federation counters. A local account deletion
cascades its personal counters and allowances.

## Verification requirements

- Concurrent increments never lose updates and rejected transactional work
  leaves no counter burn.
- A retired federation identity cannot read or consume the previous identity's
  counters, limits, allowance, or breaker state.
- UTC date changes select empty/new daily rows without a reset job.
- File count and byte limits are enforced independently and before transfer.
- Restart rebuilds breaker state from persisted rows.
- Local pause affects only the local account's sends/uploads.
- Additive `continue` changes today's effective limit and leaves the base
  override unchanged.
