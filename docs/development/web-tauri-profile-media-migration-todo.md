# Web and Tauri Profile/Media Migration TODO

Backend status: exact profile resolution, profile disclosure authorization, and temporary media download progress SSE are implemented. This document is the handoff for Web/Tauri follow-up work.

## Profile Resolution

### Goal

Migrate Web/Tauri profile requests away from selector/evidence semantics to exact profile demands.

### Current backend contract

Client profile resolution accepts only these lookup values:

```ts
'ACCOUNT_PROFILE'
'GROUP_MEMBER_PROFILE'
'RELATIONSHIP_INTENT_PROFILE'
```

Shared target shape:

```ts
{
  namespaceId: number;
  target: {
    account: string;
    domain: string;
    rev: number;
  };
}
```

Additional fields:

```ts
// RELATIONSHIP_INTENT_PROFILE only
peerAccount: string;

// GROUP_MEMBER_PROFILE only
groupAccount: string;
```

Do not send `threadId`, `messageSeq`, Meta feed coordinates, `projection`, or a separate `evidence` object. The backend derives and validates evidence itself.

The exact profile identity/cache key is:

```text
(namespaceId, account, domain, rev)
```

For local identities, keep `target.domain = 'local'`.

### TODO

- Stop using `shared/profile-selector.ts` from Web/Tauri profile request paths.
- Replace old selector kinds such as `EXACT`, `MESSAGE_AUTHOR`, and `GROUP_META` with exact demands.
- Use `ACCOUNT_PROFILE` for account snapshots, including P2P message author/counterpart and group account profile snapshots.
- Use `GROUP_MEMBER_PROFILE` for Group Meta member snapshots. Always include `groupAccount`.
- Use `RELATIONSHIP_INTENT_PROFILE` for intent-selected snapshots. Always include `peerAccount`.
- Ensure frontend profile cache and wake handling are keyed by `(namespaceId, account, domain, rev)`.
- Treat `PROFILE_AVAILABLE` / `PROFILE_UNAVAILABLE` as exact-key wakes only. Do not reconstruct old selectors from SSE payloads.
- Remove selector/evidence conversion helpers once all callers are migrated.

### Likely Web files

- `web/src/app/services/profile-store.service.ts`
- `web/src/app/services/member-profile-store.service.ts`
- `web/src/app/services/resolution-dispatcher.ts`
- `web/src/app/services/thread-profile-projection.ts`
- `web/src/app/services/group-meta-model.ts`
- `web/src/app/services/group-meta-sync.ts`
- `web/src/app/components/user-avatar/user-avatar.component.ts`
- message card/avatar call sites under `web/src/app/components/message-cards/`

### Likely Tauri/native files

- `src-tauri/src/native_db/thread_store.rs`
- Tauri bridge/profile cache code that still mirrors Web selector semantics.

## Media Download Progress

### Goal

Replace old account-level media status push assumptions with temporary per-message and per-file SSE streams.

### Current backend endpoints

```text
GET /message/media-message-progress?threadId=&seq=
GET /message/media-file-progress?threadId=&seq=&digest=
```

The backend closes each temporary SSE stream after terminal `ready` or `failed`.

### Message-level event

```ts
{
  threadId: number;
  seq: number;
  status: 'downloading' | 'ready' | 'failed';
  completedFiles: number;
  totalFiles: number;
  activeFile: { digest: string; name: string } | null;
}
```

### File-level event

```ts
{
  threadId: number;
  seq: number;
  file: { digest: string; name: string };
  status: 'downloading' | 'ready' | 'failed';
  loaded: number;
  total: number | null;
}
```

`loaded` is always a number. `total` may be `null` when the remote total size is unknown.

### TODO

- Stop relying on old `MEDIA_STATUS` SSE push. `/message/media-status` remains only as a snapshot/probe endpoint.
- Subscribe to message-level progress when rendering or opening a media message that is not ready.
- Subscribe to file-level progress for the concrete file/digest being downloaded.
- Clear local progress state when the stream ends after `ready` or `failed`.
- Display GALLERY/BUNDLE progress without merging multiple files into one file-level byte progress.
- Use `{ digest, name }` everywhere for file references. Do not preserve `name: null` compatibility in new UI state.
- Handle `total: null` without showing a broken percentage.

### Likely Web files

- `web/src/app/services/image-download.service.ts`
- `web/src/app/services/image-download.adapter.ts`
- `web/src/app/services/media-availability.service.ts`
- message media card/gallery/file/audio components under `web/src/app/components/message-cards/`

### Likely Tauri/native files

- `src-tauri/src/media_cache.rs`
- native media download bridge and local progress storage, if it mirrors Web state.

## Verification

Run focused checks first:

```bash
npm run build:fe
npm test --prefix web
```

Then run the relevant browser/Tauri flows:

```bash
npm run build:tauri
npm run test:e2e
```

Manual scenarios to cover:

- P2P message author profile resolves from an exact `ACCOUNT_PROFILE` demand.
- Group member profile resolves from an exact `GROUP_MEMBER_PROFILE` demand.
- Intent/friend request profile resolves from an exact `RELATIONSHIP_INTENT_PROFILE` demand.
- `PROFILE_AVAILABLE` wakes only the matching exact profile key.
- Single-file media download shows byte progress and clears on terminal state.
- Gallery/bundle media shows message-level aggregate progress and per-file progress for the active file.
- Failed media download displays terminal failure and does not leave a stuck progress indicator.
