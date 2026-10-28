# Quota enforcement

## Scope and storage

Quota policy is durable; daily accounting is intentionally process-local. A restart
resets usage and temporary grants. Multiple backend processes do not share a daily
budget; this design is for a single accounting process per server.

- `SystemSetting` stores five daily defaults and `maxFileBytes` per scope, with prefixes
  `quota:federation:` and `quota:localUser:`. Missing values use code defaults.
- `FederationQuotaPolicy(nsid)` references `IdentityNamespace.id`.
- `UserQuotaPolicy(account)` references the unique local `Account.account`.
- Both policy tables contain `dailyRequestLimit`, `dailySignalLimit`,
  `dailyMsgLimit`, `dailyFileLimit`, `dailyFileBytesLimit`, and `maxFileBytes`.
- An absent policy or a NULL field inherits the scope default. Zero disallows
  new consumption of that dimension. A positive value overrides the default.

Identity namespaces do not own quota configuration columns. Retired namespaces
never transfer their policy or usage to a new identity. There are no durable
usage, byte-counter, or daily-allowance tables.

## Dimensions

| Dimension                            | Local default per account/day | Federation default per namespace/day |
| ------------------------------------ | ----------------------------: | -----------------------------------: |
| Relationship operations (`requests`) |                            50 |                                1,000 |
| Call budget (`signals`)              |                        10,000 |                               50,000 |
| Messages (`messages`)                |                         1,000 |                                5,000 |
| File items (`files`)                 |                           100 |                                  500 |
| File bytes (`fileBytes`)             |                       500 MiB |                                5 GiB |

Local relationship operations are charged after domain validation when an authored
P2P or membership operation is admitted. Automatic convergence is not a new local
user action. Incoming federation `RELATIONSHIP_INTENT` entries cost one each when
the item cursor commits, including requested, accepted, and revoked states. Actual
entries count, not gaps between feed IDs. Replaying an already committed cursor
does not charge again.

Calls charge the initiating local account 400 units, independent of whether the
callee is local or federated. An inbound federation invitation charges the
publisher namespace 400 units before ringing. Each admitted new offer, answer,
or ICE signaling frame costs one unit in the sender's applicable scope. Terminal
operations (cancel, decline, end) do not consume quota and remain available after
exhaustion. Duplicate invitations do not charge again. Invitation weights are
policy units, not an estimate or guarantee of a fixed number of completed calls.

## Memory accounting and admission

The ledger stores UTC day, consumed quantities, and temporary grants. Effective
limit is `(override ?? scope default) + today's temporary grant`. Remaining usage
is derived and clamped at zero for display. Policy edits preserve consumed usage.
UTC rollover lazily clears both consumed quantities and temporary grants.

Strict admission checks and debits run synchronously after asynchronous policy
resolution. Calls cannot over-admit between a peek and a debit. File count and
bytes are checked and debited together. Refused charges consume nothing.

Memory is not part of a SQL transaction. Admission and message-processing charges
are conservative costs: a later business/database failure does not refund already
admitted work. They must not be described as transactionally rolled-back SQL
counters. State-feed relationship charges run after the durable item commit.

Message pages use soft limits: admitted/in-flight work completes normally, even
if concurrent work exhausts the budget. There is no cancellation or quota-driven
rollback. The stopping threshold is `used >= effective limit`, and overshoot may
include multiple concurrent in-flight pages.

## Federation pauses

Before each state-feed page, either exhausted requests or exhausted messages
pauses consumption for that namespace. The current page finishes, including its
individual item transactions. The next page is not fetched. The durable cursor
and observed target remain intact; no unprocessed item is skipped.

Lightweight feed-head notifications cannot bypass the next-page gate. A paused
drain retains its target and schedules a local recheck. Pauses are not peer
transport failures. Whole-feed suspension also delays revocations, membership
changes, content heads, and any dependent synchronization until consumption
resumes. This is an explicit tradeoff, not immediate revocation delivery.

Message and reverse-history scheduler quanta check the message budget at entry.
Already-running pages finish. Request exhaustion alone does not cancel message
work that was already authorized. Tombstone and group-meta work are not directly
charged to message quota, although a suspended state feed delays their new heads.

Paused work is rechecked locally, so policy increases, temporary grants, and UTC
rollover do not require a new remote push. Restart recovers durable targets and
pending download tasks with a fresh memory ledger. Downloads retain durable
resource state, but daily charge deduplication is process-local and UTC-day scoped.

## Administration and client behavior

User and federation details expose the same five limits and their current
process-local usage, remaining amount, and default/custom source. The global
settings page edits both scopes' defaults, including the single-file limit. Temporary additions support only the five daily
dimensions; omitted fields leave that dimension unchanged. Both usage and grants
are lost on restart, and the UI states this explicitly.

A local user's exhausted dimension restricts the corresponding active operation,
not client state synchronization, receiving messages, or reading existing history.
Local quota is charged to the actor, not to an incoming call's recipient.

## Attachment limits

Both scopes default to a maximum of 1 GiB (1,073,741,824 bytes), inclusive, per
message attachment. `maxFileBytes` in `FederationQuotaPolicy(nsid)` and
`UserQuotaPolicy(account)` overrides the respective `SystemSetting` default
(`quota:federation:maxFileBytes` or `quota:localUser:maxFileBytes`). NULL inherits;
zero disables new attachment admission. This is an object policy, not a daily
ledger dimension: grants and UTC rollover do not change it. Local user policy
applies to uploads, not received messages. Peer policy applies to the publishing
namespace, including retries, forward assets, localization, and cached assets.

Size admission precedes charging. Rejected descriptors consume no file budget.
An admitted transfer charges one file and its full declared byte count before
transferring; failure or cancellation does not refund the charge. Normal inbound
and manual-localization jobs share the existing scheduler and deduplicate daily
charges by publishing namespace, digest, and declared size per process/day. A changed
size declaration is a new admission rather than a free retry. Received bytes exceeding the declaration
are additionally charged before failure. Already cached assets require no transfer
charge but still undergo object admission and descriptor validation.

Active transfers retain their admitted bound; new initialization/retry operations
resolve current policy. Lowering a bound neither deletes historical media nor
blocks reads. Local initialization returns `FILE_TOO_LARGE` with `maxFileBytes`
and `declaredBytes`; inbound jobs fail their media batch without pausing or
degrading the peer or blocking subsequent message pages. Admin increases permit
manual retries; midnight alone does not resolve an object-size rejection.

Range totals must agree with descriptors, individual response bodies are bounded
while reading, and final CAS size must equal the descriptor, including recovered
and cached files. Content parsers validate safe integer sizes rather than a mutable
admission policy. Message attachments use only sequential upload sessions;
legacy message multipart routes are removed. Resumable chunks remain bounded
at 4 MiB, and ordinary JSON requests at 1 MiB. These transport resource
limits are independent of configurable object admission. Avatar format, pixel,
and size restrictions remain separate. The local daily byte default remains
500 MiB, so it can reject a file below the single-file default.
