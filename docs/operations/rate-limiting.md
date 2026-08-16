# Authentication rate limiting

## Monitoring and tuning

The administration console exposes a **Rate Limits** page backed by
`POST /admin/rate-limits`. It shows and edits the database-backed configuration alongside aggregate
request outcomes, the latest five-minute intervals, and deterministic warnings. It never returns IP
addresses, accounts, users, QR tokens, or hashed bucket keys.

The in-process page history is bounded to 288 intervals (24 hours) and resets on service restart.
Five-minute `rate_limit_summary` events remain in the rotating structured logs for longer-lived audit
and incident analysis. Treat suggestions as review prompts rather than automatic settings: burst
warnings usually call for checking client retries/shared NAT before increasing `BURST`, while sustained
legitimate traffic may justify reviewing `RATE_PER_SECOND`.

The six authentication policies use token buckets and default to `enforce`. They return HTTP 429 when
an enforced bucket is exhausted and emit a structured `rate_limit_summary` every five minutes.
Password and OTP account buckets are deliberately observation-only to avoid letting an attacker lock
out a named account.

Other abuse-sensitive routes use named fixed-window policies. These are intentionally a separate
mechanism: exact request ceilings suit high-frequency polling and data APIs better than refill-based
authentication buckets. Their limits and window lengths are also database-backed and editable on the
same page. Counters remain process-local, bounded to the configured window, and reset on restart.

## Configuration

Administrators can set each policy to `disabled`, `shadow`, or `enforce` and edit its token refill
rate and burst capacity directly on the Rate Limits page. Saving writes the complete policy set to
`SystemSetting` and applies it immediately without restarting the service. Values must be finite and
greater than zero, and burst must be at least the per-second rate. Until the first save, these reviewed
defaults apply:

| Policy prefix         | Bucket        | Rate/second | Burst | Rejects in enforce mode |
| --------------------- | ------------- | ----------: | ----: | ----------------------- |
| `AUTH_PASSWORD_LOGIN` | `IP`          |           1 |    10 | yes                     |
| `AUTH_PASSWORD_LOGIN` | `IPV6_PREFIX` |           5 |    30 | yes                     |
| `AUTH_PASSWORD_LOGIN` | `ACCOUNT`     |         0.2 |     5 | no, observation only    |
| `AUTH_OTP_LOGIN`      | `IP`          |         0.2 |     3 | yes                     |
| `AUTH_OTP_LOGIN`      | `IPV6_PREFIX` |           1 |    10 | yes                     |
| `AUTH_OTP_LOGIN`      | `ACCOUNT`     |         0.1 |     3 | no, observation only    |
| `AUTH_QR_CREATE`      | `IP`          |         0.2 |     5 | yes                     |
| `AUTH_QR_CREATE`      | `IPV6_PREFIX` |           1 |    15 | yes                     |
| `AUTH_QR_POLL`        | `IP`          |           5 |    15 | yes                     |
| `AUTH_QR_POLL`        | `QR_TOKEN`    |           1 |     3 | yes                     |
| `AUTH_QR_SCAN`        | `USER`        |         0.5 |     5 | yes                     |
| `AUTH_QR_SCAN`        | `QR_TOKEN`    |           1 |     2 | yes                     |
| `AUTH_QR_CONFIRM`     | `USER`        |         0.5 |     5 | yes                     |
| `AUTH_QR_CONFIRM`     | `QR_TOKEN`    |           1 |     2 | yes                     |

The fixed-window table lists every supported stable policy ID with its request limit and window in
seconds. Saving replaces the complete supported set, rejects unknown or missing IDs, and starts a new
counter namespace so a changed window takes effect immediately. Fixed-window policies do not expose
token-bucket modes or refill rates.

At startup, `rate_limit_auth_config` logs the effective mode and thresholds for all policies. That
event contains no client identifiers or secrets.

## Threshold review and shadow evaluation

Use `shadow` when introducing a new threshold, investigating suspected false positives, or evaluating
a material traffic/proxy change. It continues evaluating and reporting would-block decisions without
rejecting requests. Before returning a changed policy to enforcement, record the following:

1. At least seven consecutive days of representative shadow traffic, including a normal peak period.
2. At least 1,000 evaluated requests for the policy. If normal traffic cannot reach that volume, keep
   observing and perform a documented synthetic burst test instead of lowering the gate silently.
3. The `wouldBlock / evaluated` ratio, the absolute would-block count, and `maxRetryAfterMs` from the
   five-minute summaries. Investigate sharp changes and retry times that exceed the client workflow.
4. A review of sampled application/authentication logs around would-block intervals. Confirm that
   shared NATs, IPv6 `/64` aggregation, retries, and QR polling are not producing legitimate lockouts.
   Rate-limit summaries themselves are intentionally aggregate and contain no identifying subjects.
5. A rollback owner and the exact rollback value (`shadow`).

After approval, return only the reviewed policy to `enforce`, then monitor its 429 rate and
authentication success for at least one peak period. Threshold changes restart the observation window
because they invalidate previous shadow evidence.

## Staging acceptance and rollback

Before changing a production threshold, repeat it in staging. Send a burst that exceeds each enforcing
bucket and verify HTTP 429, a positive `Retry-After` header, and business code `10005` with
`data.retryAfter`.

Confirm the next `rate_limit_summary` contains the expected policy, mode, blocked count, and retry
duration. Also exercise a normal authentication flow from IPv4, IPv6, and any supported reverse-proxy
path. Record the command, effective configuration, result, reviewer, monitoring window, and rollback
owner in the deployment change.

Rollback does not require a deployment or restart: set only the affected policy to `shadow` in Admin
and save it. Confirm authentication succeeds and summaries report would-block rather than blocked
decisions. After correction and review, restore `enforce`.
