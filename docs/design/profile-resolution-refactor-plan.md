# Profile Resolution Refactor Plan

Status: active implementation plan. Execute one item at a time and stop for
review after each item. This plan covers the backend contract first, then the
client request migration.

## Final contract

The client and backend HTTP boundary use the same exact profile demand shape:

```ts
interface ProfileTarget {
  account: string;
  domain: string;
  rev: number;
}

type ProfileResolutionDemand =
  | {
      namespaceId: number;
      lookup: 'ACCOUNT_PROFILE';
      target: ProfileTarget;
    }
  | {
      namespaceId: number;
      lookup: 'RELATIONSHIP_INTENT_PROFILE';
      target: ProfileTarget;
      peerAccount: string;
    }
  | {
      namespaceId: number;
      lookup: 'GROUP_MEMBER_PROFILE';
      target: ProfileTarget;
      groupAccount: string;
    };

type ProfileEvidenceProjection =
  | {
      profile: ProfileKey;
      lookup: 'ACCOUNT_PROFILE';
      projection: { threadId: number; messageSeq: number };
    }
  | {
      profile: ProfileKey;
      lookup: 'GROUP_MEMBER_PROFILE';
      groupAccount: string;
      projection: { threadId: number; messageSeq: number };
    };
```

Resolution demand only fetches and stores exact snapshots. Evidence projection
is server-only, uses an independent queue/LRU, never fetches profiles, and is
not accepted by the client HTTP DTO.

There is no client `ProfileSelector`, `EXACT`, `MESSAGE_AUTHOR`, or
`GROUP_META` request model. There is no `evidence` field in a profile request.
Thread/message and Meta coordinates are persisted facts used by the UI to
construct the demand, not fields sent as a separate evidence object.

Profile SSE listeners are session-scoped. The resolver stores only
`sessionId`; it does not store `userId` or the raw token. A listener is
registered once per `(profile key, sessionId)`. A disconnected or revoked
session is simply skipped when the wake is emitted.

## Execution order

### 1. Freeze and validate the HTTP demand boundary

Files:

- `src/dto/profile-resolution.dto.ts`
- `src/profile-resolution/profile-resolution.controller.ts`
- `src/profile-resolution/profile-resolution-demand.ts`
- `src/profile-resolution/profile-resolution-controller.spec.ts`

Tasks:

- Validate `namespaceId`, `lookup`, and exact `target`.
- Require `peerAccount` only for `RELATIONSHIP_INTENT_PROFILE`.
- Require `groupAccount` only for `GROUP_MEMBER_PROFILE`.
- Reject unrelated fields through the global `ValidationPipe`.
- Ensure the DTO cannot accept `projection`.
- Make the controller call `start(userId, sessionId, demand)`.
- Remove all HTTP selector terminology and old selector imports.

Verification:

```bash
npm test -- --run src/profile-resolution/profile-resolution-controller.spec.ts
npm run build
```

### 2. Make coordinator entry points strict

File:

- `src/profile-resolution/profile-resolution-coordinator.service.ts`

Tasks:

- Change the public client entry point to:

  ```ts
  start(userId: number, sessionId: number, demand: ProfileResolutionDemand)
  ```

- Keep internal work on `resolveDemand(demand)` only.
- Remove optional `sessionId` compatibility.
- Remove selector normalization and selector-to-demand conversion.
- Keep `PendingItem.listeners` as `Set<number>` of session IDs.
- Merge listeners at item level and deduplicate by session ID.
- Do not store user IDs, raw tokens, selectors, or evidence.
- Remove all stale evidence merge logic and comments.

Verification:

```bash
rg -n "ProfileSelector|selector|evidence|listenerUserIds|userId.*listener" src/profile-resolution
npm run build
```

### 3. Implement demand-specific authorization

File:

- `src/profile-resolution/profile-resolution-coordinator.service.ts`

Tasks:

Implement `authorizeDemand(userId, demand)` without changing the demand's
namespace. Authorization must be specific to the lookup:

- `ACCOUNT_PROFILE`:
  - validate the namespace/domain pair;
  - authorize the exact account/revision through local self, visible P2P
    thread, selected group profile, or another already-supported exact route;
  - never substitute another revision.
- `RELATIONSHIP_INTENT_PROFILE`:
  - validate ordered author/peer endpoints;
  - validate the exact intent revision and effective status;
  - validate the namespace and peer account.
- `GROUP_MEMBER_PROFILE`:
  - validate the group origin and namespace;
  - validate current viewer membership/access;
  - validate the current exact `MEMBER_UPSERT` reference and revision;
  - preserve the rule that member profiles always use this lookup.

Do not infer or rewrite `namespaceId` from `target.domain`. Local namespace zero
is not converted into a remote namespace by the coordinator.

Verification:

- authorized exact demand succeeds;
- wrong namespace is rejected;
- wrong revision is rejected;
- wrong group/member/peer coordinates are rejected;
- local demand does not enter federation work;
- no revision substitution occurs.

### 4. Make SSE delivery session-indexed

Files:

- `src/gateway/sse.service.ts`
- `src/gateway/sse.service.spec.ts`

Tasks:

- Maintain a `Map<sessionId, SseClient>` alongside the user connection list,
  or otherwise provide O(1) session lookup.
- Register and remove entries by identity so a replacement connection cannot
  remove its successor.
- Change profile wake methods to accept only `sessionId` and the exact key.
- Do not include evidence in `PROFILE_AVAILABLE`.
- Skip a missing, revoked, replaced, or closed SSE connection.
- Preserve existing user-scoped delivery semantics for unrelated events.
- **Do not implement profile delivery by scanning `Object.values(this.clients)`
  or all user connection arrays.** The current fallback scan is O(total live
  SSE connections) per profile wake and can become expensive with many users
  or devices. Profile wakes must use the session index directly.
- Keep the user-indexed registry for existing broadcast events, but maintain a
  second session-indexed map for targeted profile wakes.

Verification:

- two sessions of one user receive only their own profile wake;
- duplicate session listener is delivered once;
- replaced connection is not notified;
- disconnected connection is skipped;
- profile payload contains no evidence or token;
- targeted profile delivery does not iterate the global user registry.

### 5. Migrate all backend callers to final demands

Files include:

- `src/federation/federation-state-pull.service.ts`
- `src/federation/federation.service.ts`
- message post-commit callers;
- system-event post-commit callers;
- Group Meta post-commit callers.

Tasks:

- Replace every `.start(userId, oldSelector)` call.
- Use `resolveDemand(demand)` for internal prefetch/projection.
- Construct the correct namespace from the committed source record.
- Use `ACCOUNT_PROFILE` for P2P message-author and selected group profile.
- Use `GROUP_MEMBER_PROFILE` for every Group Meta member profile.
- Use `RELATIONSHIP_INTENT_PROFILE` for intent-selected thread profiles.
- Do not use `namespaceId: 0` for remote work.
- Do not perform network resolution inside message or Meta transactions.

Verification:

```bash
rg -n "\.start\(|type: 'EXACT'|type: 'MESSAGE_AUTHOR'|type: 'GROUP_META'" src
npm run build
```

### 6. Complete post-fetch projection dispatch

Files:

- `src/profile-resolution/profile-resolution-coordinator.service.ts`
- P2P thread projection writer
- Group Meta projection writer
- related unit tests

Tasks:

- After exact snapshot materialization commits, dispatch projection separately.
- `ACCOUNT_PROFILE + projection` updates P2P thread profile source/revision.
- `GROUP_MEMBER_PROFILE + projection` updates Group Meta `MEMBER_UPSERT`.
- Revalidate the committed `{ threadId, messageSeq }` coordinate.
- Keep projection transactions local and separate from federation fetch.
- A prefetch demand never writes projection evidence.
- A failed projection does not roll back the committed snapshot.
- On cache/durable hits, still run pending projection work when present.
- Only after projection commit should the corresponding feed notify clients.

Verification:

- snapshot commit precedes projection;
- projection commit precedes feed/SSE wake;
- stale coordinate produces no write;
- local member/local author paths bypass federation;
- mirror Meta prefetch produces no projection.

### 7. Migrate coordinator tests

File:

- `src/profile-resolution/profile-resolution-coordinator.service.spec.ts`

Tasks:

- Remove all `kind`, selector, evidence, and user-list fixtures.
- Construct final demands directly.
- Use session IDs for listeners.
- Test duplicate same-session registration.
- Test two sessions for one exact key.
- Test listener added while fetch is in flight.
- Test snapshot materialization before pending-key deletion and SSE.
- Test namespace transport resolution from `IdentityNamespace.domain`.
- Test every lookup dispatch.
- Test listener-free internal prefetch.
- Test projection and prefetch behavior separately.

Verification:

```bash
npm test -- --run src/profile-resolution/profile-resolution-coordinator.service.spec.ts
```

### 8. Verify feed evidence delivered to the client

Backend feed sources:

- `src/message/thread-feed.service.ts`
- `src/group/meta/group-meta-page.ts`
- `src/federation/group-meta-feed.service.ts`

Tasks:

- Confirm Thread Feed returns the selected profile address, namespace,
  revision, `profileSourceId`, and `threadProfileRev`.
- Confirm Group Meta returns `GROUP_PROFILE` and `MEMBER_UPSERT` profile
  revisions, member address, namespace, and feed coordinate.
- Confirm post-fetch projection updates those durable facts before the next
  client feed page is served.
- Add backend tests for intent-selected versus source-selected thread
  profiles and Group Meta member references.

### 9. Migrate the Web/Tauri client request type

Only after backend steps 1–8 pass.

Files include:

- `shared/profile-selector.ts` (remove/replace)
- `web/src/app/services/profile-store.service.ts`
- `web/src/app/services/webdb-storage.ts`
- `web/src/app/components/user-avatar/user-avatar.component.ts`
- message, thread, group-info, request, and contact presentation components
- Tauri/native request and wake handling

Tasks:

- Use the same demand field names and lookup values as the backend.
- Include `namespaceId`.
- Do not send evidence, thread coordinates, or projection.
- Group Meta members always use `GROUP_MEMBER_PROFILE`.
- Thread intent-selected profiles use `RELATIONSHIP_INTENT_PROFILE`.
- Message-selected P2P and Group profiles use the appropriate
  `ACCOUNT_PROFILE`/`GROUP_MEMBER_PROFILE` route.
- Read the source/revision facts from Thread Feed and Group Meta.
- Keep exact four-tuple cache identity everywhere.

### 10. Full verification

Run only after each preceding area has been reviewed:

```bash
npm run build
npm test
npm run build:fe
npm run build:tauri
npm run test:e2e
npm run db:status
git diff --check
```

Also verify that no raw token, user-wide profile listener, legacy selector, or
profile rebase path remains.
