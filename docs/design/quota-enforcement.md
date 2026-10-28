# Quota enforcement

## Scope and storage

Quota policy is durable; daily accounting is intentionally process-local. A restart
resets usage and temporary grants. Multiple backend processes do not share a daily
budget; this design is for a single accounting process per server.

- `SystemSetting` stores five defaults per scope, with prefixes
  `quota:federation:` and `quota:localUser:`. Missing values use code defaults.
- `FederationQuotaPolicy(nsid)` references `IdentityNamespace.id`.
- `UserQuotaPolicy(account)` references the unique local `Account.account`.
- Both policy tables contain `dailyRequestLimit`, `dailySignalLimit`,
  `dailyMsgLimit`, `dailyFileLimit`, and `dailyFileBytesLimit`.
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
settings page edits all ten defaults. Temporary additions support all five
dimensions; omitted fields leave that dimension unchanged. Both usage and grants
are lost on restart, and the UI states this explicitly.

A local user's exhausted dimension restricts the corresponding active operation,
not client state synchronization, receiving messages, or reading existing history.
Local quota is charged to the actor, not to an incoming call's recipient.

## Attachment limits

Every message attachment must be strictly smaller than 1 GiB. The object cap is
independent of daily file count/bytes admission. Resumable chunks remain bounded
at 4 MiB; ordinary JSON requests retain the global 1 MiB body limit. Avatar
format and size restrictions remain separate.
