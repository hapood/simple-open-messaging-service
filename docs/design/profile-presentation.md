# Client Profile Presentation Evidence

Status: frontend design; follows the backend profile-resolution contract.

## Purpose

The backend owns profile federation, authorization, exact-revision lookup, and
snapshot persistence. The client owns presentation evidence: the UI component
that displays a profile tells the profile repository which persisted message,
Meta fact, or exact identity is being displayed.

Client ingestion does not request profiles. Message landing, state-feed
application, Meta landing, IndexedDB writes, and native database writes only
persist profile references and any snapshots already available. A profile
request starts when a visible profile-bearing component supplies evidence.

## Shared request type

The frontend uses the same request shape as backend profile resolution. There
is no separate selector/evidence object:

```ts
export interface ProfileTarget {
  profileNamespaceId: number;
  account: string;
  rev: number;
}

export type ProfileResolutionDemand =
  | {
      publisherNamespaceId: number;
      lookup: 'ACCOUNT_PROFILE';
      target: ProfileTarget;
    }
  | {
      publisherNamespaceId: number;
      lookup: 'GROUP_MEMBER_PROFILE';
      target: ProfileTarget;
      groupAccount: string;
    };
```

The frontend demand is isomorphic with the backend prefetch demand. It carries
the local publisher namespace, the publisher-scoped exact profile subject, and
the concrete `lookup`. `publisherNamespaceId` selects the locally recognized
peer that can answer the request; `target.profileNamespaceId` is serialized as
the S2S profile path's `:namespaceId`. The S2S profile paths contain no subject-domain variable. Namespace bindings provide routing/display metadata; the demand does not carry a domain or substitute a `local` wire domain. The
publisher namespace itself is never sent as a profile field. The demand does not carry `threadId`, `messageSeq`,
Meta feed coordinates, `projection`, or a parallel `evidence` object. The
display component passes this complete demand to the profile repository.

The immutable profile/cache identity is:

```text
(publisherNamespaceId, profileNamespaceId, account, rev)
```

The profile reference is immutable in storage. The transport selects the peer using `publisherNamespaceId` and emits the publisher-scoped `profileNamespaceId` in the profile path. Neither coordinate is inferred from a domain comparison.

A demand never authorizes a different revision and never permits profile
rebase. If the requested exact snapshot is unavailable, the component keeps
loading or renders its address/name fallback.

## Demand construction by component

Components construct the complete demand from the persisted record they are
rendering. They do not construct a separate evidence selector.

### P2P message author

A P2P message author uses `ACCOUNT_PROFILE`. This also covers the exact revision selected by an effective relationship intent; authorization checks that grant without using a separate lookup.

### Group profile

A group profile uses `ACCOUNT_PROFILE` with the exact group revision.

### Group Meta member

A member rendered from Group Meta always uses `GROUP_MEMBER_PROFILE`, whether
the member revision came from initial intent/member establishment or from a
later `MEMBER_UPSERT` selection:

```ts
{
  publisherNamespaceId: group.publisherNamespaceId,
  lookup: 'GROUP_MEMBER_PROFILE',
  groupAccount: group.account,
  target: {
    profileNamespaceId: member.profileNamespaceId,
    account: member.account,
    domain: member.domain,
    rev: member.profileRev,
  },
}
```

The client never changes this member lookup to `ACCOUNT_PROFILE` merely
because a member revision is already persisted. The member address and exact
revision come from the member record being rendered.

### Relationship intent

A profile selected directly from an intent uses `ACCOUNT_PROFILE` for the exact intent-selected revision. The server authorizes the request only when the directed intent grants that exact revision to the viewer.

## Component API

Profile-bearing presentation components accept evidence explicitly:

```html
<app-user-avatar
  [account]="author.account"
  [federatedDomain]="author.domain"
  [profileEvidence]="authorProfileEvidence"
/>
```

The avatar or profile presentation component may call the profile repository
with that evidence. The repository shares duplicate in-flight resolutions and
reads exact snapshots from client storage. It does not inspect unrelated
records to invent evidence.

A component should pass `undefined` when:

- the selected revision is zero;
- the identity is `$system` without a profile participant;
- the event is a departure/removal and is cache-only;
- the value is a local preview rather than a persisted profile reference; or
- the component intentionally displays only an address fallback.

`undefined` means no profile request. It does not mean “request the latest
profile”.

## Wake and cache behavior

`PROFILE_AVAILABLE` and `PROFILE_UNAVAILABLE` are wake events keyed by the
exact four-tuple:

```text
(publisherNamespaceId, profileNamespaceId, account, rev)
```

They do not carry presentation evidence. The repository associates a wake
with an existing component-owned resolution, rereads the committed local
snapshot, and completes the component request. A wake cannot create a new
selector, change the displayed revision, or rebase a message/Meta reference.

The client profile cache and storage use the four-tuple everywhere. A cache
entry for revision 8 cannot satisfy evidence requesting revision 7, even when
revision 8 is newer, and a snapshot resolved through one publisher namespace
cannot satisfy a demand for another publisher namespace.

## Responsibility boundary

```text
UI component
  → constructs a projection-free exact demand from the displayed record
  → passes the demand to the profile-bearing child/repository

Profile repository
  → deduplicates exact profile requests
  → asks the runtime to resolve the demand
  → reads the exact committed snapshot
  → exposes loading/success/fallback to the component

Web Worker / Tauri runtime
  → sends the demand to the backend profile-resolution HTTP endpoint
  → stores returned exact snapshot
  → waits for exact-key wake events

Backend
  → authorizes the demand
  → performs federation lookup
  → persists exact snapshot
  → emits exact-key wake
```

No layer may replace the selected revision with another revision. Evidence
identifies what the user is looking at; the four-tuple identifies the immutable
profile bytes and the publisher route that disclosed them.
