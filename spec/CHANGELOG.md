# SOMFP Changelog

## 1.0.0-draft.2 (in progress)

Not backward compatible with draft.1.

- Remove `sentAt` from the lightweight `feed-heads` body; use the authenticated
  HTTP signature's `created` parameter for request send time instead.
- Require well-known `signingKeyCreatedAt` diagnostic metadata for the
  currently active HTTP signing key's creation time.
- Require `generatedAt` on every State Feed item to identify the publisher's
  generation time for its current `feedId` version, unchanged by retransmission.
- Require top-level `generatedAt` on public current-profile and both exact
  profile responses; original revision times stay stable across reads and
  forwarding, and revision-0 public responses carry `0`.
- Require `generatedAt` on Profile Namespace Feed items and namespace binding
  responses; both use the persisted binding-change time. Feed pages have no
  top-level generation time, and synchronization time follows processed items.
- Require `createdAt` and `originCreatedAt` on all Group Meta items.
- Replace intent `requestedAt` with required `statusChangedAt` for request,
  acknowledgement, and revocation times.
- In progress: review tombstone source timestamps.
- Clarify revision-0 profile evidence semantics without prescribing local storage
  or presentation; consolidate public-profile response and availability rules.

## 1.0.0-draft.1

Not backward compatible with draft.0.

- Nest public current-profile content under `profile`.
- Return `profileRev: 0` and `profile: null` for existing accounts without a
  profile; exact-revision requests still require positive revisions.

## 1.0.0-draft.0

Previous Final Review working draft, with flattened positive-revision-only public
current-profile responses.
