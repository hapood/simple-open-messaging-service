# SOMFP Changelog

## 1.0.0-draft.2 (in progress)

Not backward compatible with draft.1.

- Require `createdAt` and `originCreatedAt` on all Group Meta items.
- In progress: review intent transition times and tombstone source timestamps.
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
