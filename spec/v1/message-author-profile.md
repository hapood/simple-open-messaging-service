# Simple Open Messaging Federation Protocol v1 Message Author Profile

Status: `RELEASE CANDIDATE` (`v1.0.0-rc.0`)

This document is entirely normative. It defines the on-demand operation
`GET /s2s/v1/message-author-profile`. A peer uses it only when it needs the
display name or avatar version referenced by a message it can query. State Feed
and Group Meta do not carry this display data.

## 1. Request

The operation uses a closed query containing a Thread Address and the exact
publisher-local `messageSeq`:

```ts
type MessageAuthorProfileQuery =
  | {
      account: UserAccount;
      peerAccount: UserAccount;
      messageSeq: PositiveDecimalString;
    }
  | {
      account: GroupAccount;
      messageSeq: PositiveDecimalString;
    };
```

The P2P and GROUP thread selectors have exactly the same source/signer binding
as `GET /s2s/v1/messages`. `messageSeq` MUST equal the requested message's
publisher-local `seq` and be no greater than `SafeInteger - 1`. The fixed
query-key order is `account`, optional `peerAccount`, then `messageSeq`.
Unknown, duplicate, missing, non-canonical, or incorrectly ordered parameters
return `400 FEDERATION_MALFORMED`.

The message wire carries its author's `profileRev`. The requester submits the
message coordinate so the publisher can verify exact-message authorization;
the response revision MUST match the immutable revision carried by that
message copy. `messageSeq` is never a State Feed or Group Meta `feedId`.

## 2. Successful response

The success `data` is this closed object:

```ts
interface MessageAuthorProfile {
  account: UserAccount;
  domain: Domain;
  profileRev: SafeInteger;
  displayName: string;
  avatar: InlineProfileAvatar | null;
}
```

`account/domain` MUST equal the author reconstructed from the exact message.
`profileRev` MUST equal the immutable profile revision selected for the
requested message copy. `displayName` contains 1–30 Unicode code points without
unpaired surrogates. `avatar` is either `null` or the shared Base64-bearing
`InlineProfileAvatar`; no URL or independently fetchable avatar reference is
returned. The response MUST NOT contain biography, relationship, presence,
membership, or role data.

A consumer MUST key the cached result by `(publisher domain, author account,
author domain, profileRev)`. It MUST NOT replace another revision or treat this
source-bound snapshot as the author's current public profile.

## 3. Exact-message authorization

For every request the publisher MUST:

1. Resolve the normalized Thread Address exactly as for `/messages`.
2. Find the immutable message at the requested publisher-local `messageSeq`.
3. Recompute current thread-query authorization and verify that this exact
   message was durably allocated to the authenticated peer during a valid
   historical audience.
4. Reconstruct the message author from `authorRef` for P2P or `author` for
   GROUP.
5. Resolve the immutable `profileRev` carried by that message copy.
6. Return the retained display snapshot for that author and revision.

A `THREAD_CONTENT_HEAD`, Group Meta membership, possession of the author
Address, knowledge of a profile revision, or an earlier successful response is
not authorization proof. The publisher MUST NOT fall back to the author's
current profile when the message-bound version is absent. A request for a missing,
deleted, unauthorized, or no-longer-serviceable message returns
`FORBIDDEN`; the publisher MAY privacy-collapse that result to `NOT_FOUND`.
Neither result reveals whether the author or profile version exists.

The operation is read-only and idempotent. It grants no relationship,
membership, message, media, or subsequent profile permission.

## 4. Retention

Before making a message queryable to a peer, the publisher MUST carry a stable
author-profile revision on that message coordinate. The publisher SHOULD
retain that exact display snapshot while the message remains serviceable to
any peer, including during storage degradation.
This obligation applies to P2P messages, group submissions, authoritative group
messages, and processing receipts, including messages authored on another
domain.

When a publisher accepts a message from a direct peer and intends to make its
local copy queryable, it SHOULD obtain and durably retain the referenced snapshot
from that direct peer using the incoming message's thread and `seq` before
publishing the local copy. In particular, a group origin
MUST complete this step for a member submission before distributing the
accepted authoritative group message to mirrors. A receiver MUST NOT rely on
the original author's home server being directly reachable or authorized to
serve a later mirror.

For every peer, each message that remains serviceable to that peer SHOULD keep
its referenced profile version serviceable through this operation. One retained
snapshot MAY satisfy any number of messages and peers with the same publisher,
author Address, and `profileRev`. If degradation nevertheless removes a
snapshot still referenced by a serviceable message, the publisher MUST preserve
the message and its stable author Address, MUST NOT substitute another profile
revision, and MUST return `NOT_FOUND` for this profile read. Profile changes
MUST create a new revision and MUST NOT mutate a retained older snapshot.

Group departure, relationship transition, forward-cursor advancement, State
Feed compaction, and Group Meta compaction do not independently release this
retention obligation. Message-content retention and historical allocation proof
determine when it ends.

## 5. Consumer behavior

Receiving and committing a message does not require eagerly fetching its
display profile. A consumer MAY request the profile lazily when rendering the
message and MAY reuse a validated cached snapshot with the exact cache key.
For a P2P thread display, the peer-authored message with the greatest committed
`seq` selects its `profileRev`; a locally authored message does not replace the
peer's selection. Revision numbers themselves are not compared for recency.
Failure to fetch display data MUST NOT change the message author Address, role,
membership, content, cursor, or tombstone state. The consumer MAY render the
stable `account@domain` address until the requested version becomes available.
