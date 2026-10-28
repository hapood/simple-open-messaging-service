# SOMFP Changelog

## 1.0.0-draft.2 (in progress)

Not backward compatible with draft.1.

- Add required `generatedAt` to `feed-heads`; request send time comes from the
  authenticated HTTP signature's `created` parameter.
- Require well-known `signingKeyCreatedAt` diagnostic metadata for the
  currently active HTTP signing key's creation time.
- Require `generatedAt` on every State Feed item to identify the publisher's
  generation time for its current `feedId` version, unchanged by retransmission.
- Require top-level `generatedAt` on public current-profile and both exact
  profile responses; original revision times stay stable across reads and
  forwarding, and revision-0 public responses carry `0`.
- Require `generatedAt` on Profile Namespace Feed items and namespace binding
  responses; both identify the binding version's generation time.
- Restrict Namespace Feed items and binding queries to positive namespace IDs;
  the publisher's own binding follows verified identity exchange.
- Require non-null `originCreatedAt` on all Group Meta items; local copy
  `createdAt` is not part of the S2S response.
- Replace intent `requestedAt` with required `statusChangedAt` for request,
  acknowledgement, and revocation times.

## 1.0.0-draft.1

Not backward compatible with draft.0.

- Nest public current-profile content under `profile`.
- Return `profileRev: 0` and `profile: null` for existing accounts without a
  profile; exact-revision requests still require positive revisions.

## 1.0.0-draft.0

Previous Final Review working draft, with flattened positive-revision-only public
current-profile responses.
