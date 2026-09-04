# Simple Open Messaging Federation Protocol v1 Authorized Profile

Status: `RELEASE CANDIDATE` (`v1.0.0-rc.0`)

This document is entirely normative. It defines the authenticated,
policy-controlled profile operation used for an established user or group
thread. It is separate from `GET /s2s/v1/accounts/:account`, whose exact-account
lookup returns the current public profile of an exact local user or live group.

## 1. Request

```http
GET /s2s/v1/profiles/:account?rev=:rev
```

`account` MAY be a `UserAccount` or `GroupAccount` owned by the responding
domain. `rev` is required and is a canonical positive decimal `SafeInteger`.
The value `0` is the no-profile sentinel and MUST NOT be requested. Omitting
`rev`, sending `0`, or including any other query parameter returns
`400 FEDERATION_MALFORMED`.

The publisher returns that exact immutable revision and MUST NOT substitute a
default, newer, older, or otherwise retained revision. Federation v1 defines no
active-profile concept and no operation that discovers an account's local
default or numerically greatest profile revision.

## 2. Profile revisions

A profile revision is one atomic snapshot of:

```ts
interface AuthorizedProfile {
  account: Account;
  domain: Domain;
  displayName: string;
  bio: string;
  avatar: InlineProfileAvatar | null;
  profileRev: PositiveSafeInteger;
}
```

Name, biography, and avatar are updated together in one profile operation and
produce one new revision. Within one `(account, domain)`, a `profileRev` is
permanently bound to one immutable snapshot and MUST NOT be reused, even after
that snapshot is no longer referenced or retained. A publisher may keep a local
`defaultProfileRev` for authoring new references, but that pointer is not a
federated fact, does not make other revisions inactive, and is not remotely
queryable. A future publisher may select different revisions for different
peers. The response `profileRev` MUST equal the requested `rev`.

Revision allocation begins at `1`. The response object and every field shown
above are required; `profileRev` is never absent or `null`. The value `0` is not
a profile revision and can never appear in a successful response.

Relationship Intent, messages, and Group Meta `GROUP_PROFILE` items carry exact
profile references without carrying name, biography, or avatar bytes. A
consumer uses the referenced revision with this operation when its applicable
authorization permits account/revision lookup.

## 3. Authorization and errors

The profile owner MAY independently control which recognized peers may read a
default-selected or historical revision except where an effective Relationship
Intent grants the access defined below. Recognition, knowledge of `account`,
knowledge of `rev`, or possession of earlier profile data does not grant access.

An effective `REQUESTED` or `ACCEPTED` Relationship Intent with a positive
`profileRev` MUST authorize the server hosting the intent's other endpoint to
read exactly the author's referenced `(account, profileRev)`. The other endpoint
MAY be a user or a group. The publisher MUST verify that the requested account
is the intent author, the requested revision equals the intent's `profileRev`,
and the authenticated signer hosts the opposite endpoint in the same identity
namespace. An expired `REQUESTED` direction and a `REVOKED` direction grant no
access. No intent authorizes a different account or revision.

The publisher MUST evaluate its current disclosure policy for every request.
Outside the mandatory Relationship Intent grant above, knowledge of `account`
and `rev`, recognition of the peer, friendship, group audience, or access to a
different revision does not by itself require the publisher to disclose this
revision. Any additional policy and its local authorization index are
implementation-defined.

Message-bound profile access uses [Message Author Profile](./message-author-profile.md)
so the publisher can validate the exact thread and message allocation. This
account/revision operation MUST NOT treat knowledge of a message-carried
`profileRev` as message authorization proof.

An unauthorized profile read returns
`FEDERATION_PROFILE_NOT_DISCLOSED`. It MUST NOT return generic `FORBIDDEN`,
author a relationship transition, end a friendship, revoke group membership,
or degrade the peer. The publisher MAY return `NOT_FOUND` instead when privacy
requires concealing whether the account or revision exists.

## 4. Retention and degradation

The publisher SHOULD retain historical profile revisions referenced by
serviceable messages or current Group Meta projections so those objects remain
visually complete during storage degradation. If a referenced revision is
nevertheless unavailable, the publisher MUST NOT substitute another revision.
The profile read returns `NOT_FOUND`; the message, thread, stable author
Address, role, and other retained content remain valid.
