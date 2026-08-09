# SOMS Federation S2S API

> Implementation reference for the current `/api/v1/s2s` surface. The URL prefix is the wire
> protocol version; request and state bodies do not repeat a `version` field.

All endpoints except `ignite` and the public identity proof are RFC 9421 signed and gated by the
pinned peer identity. Wire identities are `{ account, domain }`; database ids never cross S2S.

## Endpoints

| Method | Path | Purpose |
| --- | --- | --- |
| `POST` | `/ignite` | First-contact trust establishment and cursor initialization. |
| `GET` | `/identity` | Nonce-bound signed server identity proof. |
| `GET` | `/ping` | Signed recovery/liveness proof. A demoted peer may use only this data-plane endpoint; success restores the existing pinned trust. |
| `POST` | `/feed-rev` | Ephemeral wake-up carrying decimal-string `stateFeedRev` and `messageFeedRev`. |
| `GET` | `/feed-rev` | Read both current per-peer source revisions. |
| `GET` | `/state-feed-rev` | Read only the current state-feed revision. |
| `GET` | `/state-feed` | Pull compacted relationship/profile/group state after a revision. |
| `GET` | `/message-feed` | Pull durable message discovery after a change revision. |
| `POST` | `/call` | Ephemeral federated call signalling. |
| `GET` | `/users/:account` | Resolve a local user's public profile for first-contact lookup. |
| `GET` | `/get_file` | Authorized range download of a content-addressed message asset. |
| `GET` | `/forward-bundles/:bundleId` | Authorized immutable forward-bundle closure. |

Removed v1 commands are intentionally not compatible: `/init`, `/invite`, `/invite-accept`,
`/invite-revoke`, `/miss-feed`, `/thread-access`, thread-level `/messages`, `/new-msg-map`, profile
revision probes and group meta probes.

## Wake-up and drain order

```text
POST /feed-rev
  → drain /state-feed completely
  → commit state page and state cursor atomically
  → drain /message-feed
  → commit message page and message cursor atomically
```

The POST is only a hint. Lost, duplicated and out-of-order hints are safe because startup and periodic
reconciliation read source revisions again. Advertised revisions are max-coalesced and neither pull
cursor may move backwards.

After a process restart the recovery sequence is:

```text
GET /identity → GET /ping → state feed → message feed
```

`ping` does not establish a new identity. It succeeds only with the previously pinned signing key. An
identity/fingerprint conflict enters `identity_lost` and requires an administrator reset.

## State feed

Query parameters:

- `after`: unsigned decimal revision already committed by the receiver.
- `take`: page item limit, capped by the server.

The response contains decimal strings `stateFeedRev`, `scannedThrough`, item `rev`, and business
`revision`. Feed revisions/cursors are bigint because they are unbounded transport allocators. Business
revisions are int because they belong to one bounded row and are validated as safe integers.

Event keys and bodies:

- `PROFILE(account)`: public profile snapshot, including avatar bytes; applies only when its business
  revision is strictly newer than `remoteProfileRev`.
- `P2P_META(requester, target)`: one directed friend fact with `REQUESTED`, `FRIEND`, or `NOT_FRIEND`.
- `GROUP_INVITE_INTENT(group, member)`: origin's directed invitation fact.
- `GROUP_JOIN_INTENT(group, member)`: member's directed join/leave fact.
- `GROUP_META(group)`: origin-authoritative roster and group snapshot. Meta JSON does not contain member
  avatars; member profiles arrive as independently revisioned `PROFILE` items.

The feed is compacted by `(peer, eventType, account, subjectAccount)`. A same or older business revision
is a complete no-op: it does not rewrite the fact, refresh `updatedAt`, mutate a projection, allocate a
new feed revision, or trigger downstream state. A page is applied in one transaction; any invalid item
rolls back the entire page and cursor.

Friendship becomes active only when both directed facts are effective at the transaction boundary:
`FRIEND`, or `REQUESTED` with `expiresAt > CURRENT_TIMESTAMP`. The source sends the absolute expiry
(default seven days) and the receiver never renews it. Closing one direction preserves the opposite
direction, so a later one-sided request may reactivate the pair while that retained direction remains
effective.

Group membership uses two directions but the origin remains the roster authority. A mirror created by an
invitation is initially inactive; only a newer origin `GROUP_META` activates its participant and audience.
There is no member-profile delete event merely because a member leaves a group.

## Message feed

Query parameters are `after` and `take`. The response contains `messageFeedRev`, `scannedThrough`, and
ordered changes. A discovery change is allocated transactionally with the message and its audience.

Messages carry stable author identity and source `originSeq`; receiver-local `seq` remains local. SYSTEM
messages contain only structured event data and stable identities, never pre-rendered natural language.
Clients render them using local translations and the message timestamp.

For a leaving group member, the sender writes `GROUP_LEFT` first, allocates its discovery change, fixes a
creator-scoped audience's `deliverThroughChangeId` to that exact change, and only then closes membership.
The receiver processes `NOT_MEMBER` state first and admits only the matching structured `GROUP_LEFT`
boundary from that now-closed author.

## Lightweight feed revision body

```ts
type FeedRevisionHint = {
  origin: string;
  stateFeedRev: string;
  messageFeedRev: string;
};
```

Both revisions are unsigned decimal strings. `origin` must equal the verified signer domain.

## Media and forward assets

`get_file` supports HTTP Range and verifies message/thread authorization plus digest membership before
serving bytes. Incoming media messages may commit as durable pending work while their files download;
download failure never rolls back an already admitted text/message-feed page. Quota-paused tasks stay
pending and are automatically re-driven after an administrator adds allowance.

Forward bundles are immutable manifest closures with bounded depth. The receiver verifies manifest
digests and separately downloads authorized binary assets through `get_file`.
