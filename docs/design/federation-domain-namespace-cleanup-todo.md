# Federation Domain-to-Namespace Cleanup TODO

This checklist tracks the remaining cleanup after the root-identity and profile-demand redesign. Work through it one section at a time and re-run the listed verification before moving to the next section.

## Ground Rules

- Domain is transport/discovery/binding metadata, not identity.
- Account identity should be namespace-based: `{ account, namespaceId }`.
- Profile identity is the 4-tuple `{ publisherNamespaceId, profileNamespaceId, account, rev }`.
- Message rows must not carry `creatorDomain`.
- Do not reintroduce `displayDomain` or put domain back into profile keys, profile targets, caches, SSE profile wake keys, or profile demand shapes.
- Keep transport target domain only where an HTTP request or peer routing endpoint actually needs a current domain binding.
- If a domain field is kept for forward/provenance/display compatibility, it must be optional and must not be used as the identity key.

## Verification Commands

Run incrementally after each section when practical:

```bash
npm run build:be
npx vitest run shared/ src/
cd web && npm run build
cd admin-web && npm test
cd admin-web && npm run build
```

E2E remains blocked until PostgreSQL is available.

---

## 1. Message Author Identity Cleanup

Goal: remove `Message.creatorDomain` from all message-author identity logic.

- [x] Update `MessageAuthorAddress` consumers to use `{ account, namespaceId }` only.
- [ ] Finish `src/message/message.service.ts` cleanup:
  - [ ] quote visibility / hide-creators uses account + namespaceId;
  - [ ] quote preview author lookup uses profile 4-tuple only;
  - [x] no inserts/selects reference `message.creatorDomain`;
  - [x] `stripMessageId` output has no domain.
- [ ] Update related tests:
  - [ ] `src/message/message.service.spec.ts`;
  - [ ] `src/message/thread-feed.service.spec.ts`;
  - [ ] `src/message/system-message-write.spec.ts`.

Notes:
- `PendingMedia.creatorDomain` is handled separately in Section 5.

---

## 2. Profile Evidence Projection Cleanup

Goal: profile evidence projection should not carry subject domain.

Already started:
- `ProfileEvidenceProjection.subjectDomain` removed from types.
- P2P/member projection SQL started moving to namespace-based matching.

Remaining:

- [ ] Finish `src/message/project-p2p-message-profile-in-tx.ts` review:
  - [ ] verify all author matching is account + namespaceId;
  - [ ] verify participant exclusion uses namespace identity, not domain.
- [ ] Finish `src/group/meta/publish-member-message-profile-in-tx.ts` review:
  - [x] remove all remaining `memberDomain`/`domain` references from member profile source projection;
  - [x] match `GroupMetaMemberFeed` by `(threadId, memberAccount, profileNamespaceId)`.
- [ ] Update specs:
  - [ ] `src/message/collect-committed-profile-work.spec.ts`;
  - [ ] `src/profile-resolution/profile-evidence-projection.service.spec.ts`;
  - [ ] group meta/member projection specs as needed.

---

## 3. Federation Message Feed / Tombstone / Peer Resource

Goal: remove `Message.creatorDomain` from outbound federation message selection/publication.

Files to inspect:

- [ ] `src/federation/federation-message-feed.service.ts`
- [ ] `src/federation/federation-message-tombstone-feed.service.ts`
- [ ] `src/federation/federation-peer-resource.service.ts`
- [ ] `src/federation/federation-quote-target.ts`

Decisions to apply:

- Feed dedup/origin coordinate logic uses message timeline/source coordinates, not author domain.
- Author identity uses `creatorAccount + profileNamespaceId`.
- Do not use `profileNamespaceId` or `publisherNamespaceId` inside quote target conversion unless strictly needed for timeline conversion.
- Quote target internal model should stay message-coordinate based, not profile-identity based.

Open review point:

- [ ] Re-confirm exact `publishFederationQuote` internal signature before implementation. Current preferred direction: target mapping should be no more than `{ seq, originSeq }`, with stored quote coordinate carrying its coordinate namespace.

---

## 4. Inbound Federation Message Routing / Page / Media

Goal: inbound message routing should not persist author domain on Message; transport domain comes from route/peer binding.

Files:

- [ ] `src/federation/federation-inbound-message-route.service.ts`
- [ ] `src/federation/federation-inbound-message-page.service.ts`
- [ ] `src/federation/federation-media-localization.service.ts`
- [ ] `src/federation/federation-pending-media-promoter.ts`
- [ ] `src/federation/select-inbound-message-profile-demand.ts`
- [ ] `src/federation/federation.service.ts`
- [ ] `src/federation/federation-profile.service.ts`

Decisions:

- Inbound profile demand/projection uses publisher namespace, profile namespace, account, rev.
- Media localization may need a transport domain, but it should come from route/binding/source peer, not `Message.creatorDomain`.
- Inbound wire `author.domain` is removed. Group messages use `author: { account, namespaceId }`; P2P messages use `authorRef`.

Follow-up checks:

- [x] `FederationService.publishMessageQueryEffects` must not read `effect.author.domain`; pending downloads should use the source peer transport domain already passed to the method.
- [x] `FederationProfileService` raw SQL must not join/filter Message authors by `m."creatorDomain"`; use `m."profileNamespaceId" = profile."profileNamespaceId"` and local author namespace `0` where appropriate.
- [x] Inbound route/page specs must stop constructing `author.domain`, top-level `namespaceId`, or `creatorDomain` route expectations.

---

## 5. Pending Media / Upload Staging

Goal: remove outbound local staging dependence on `PendingMedia.creatorDomain`.

Files:

- [ ] `src/database/schema.ts`
- [ ] `src/message/message.service.ts`
- [ ] `src/message/pending-media-row.ts`
- [ ] `src/upload/resumable-upload.service.ts`
- [ ] `src/federation/federation-inbound-media-batch.service.ts`
- [ ] `src/federation/federation-pending-media-promoter.ts`

Preferred direction:

- Outbound pending media author identity: `{ creatorAccount, publisherNamespaceId }`, with local authors using namespace `0`.
- Inbound pending media retains transport/source fields needed to resume downloads, but not as message-author identity.
- Update `PendingMedia_direction_shape_check` accordingly.

---

## 6. Peer State Feed Subject Identity

Goal: keep peer transport target domain, but replace subject identity domain.

Files:

- [ ] `src/database/schema.ts`
- [ ] `src/federation/peer-state-feed.service.ts`
- [ ] `src/federation/federation-audience.ts`
- [ ] `src/federation/federation-message-feed.service.ts`
- [ ] `src/federation/federation-message-tombstone-feed.service.ts`
- [ ] `src/federation/federation-thread-content-head.service.ts`
- [ ] all group/user intent SQL writers touching `PeerStateFeed`

Proposed model:

- Keep `peerDomain` only as transport/binding target if needed.
- Replace `subjectDomain` with `subjectNamespaceId`.
- Update compaction PK from `(subjectAccount, subjectDomain)` to `(subjectAccount, subjectNamespaceId)`.
- Update validation checks for relationship intent and thread-content-head events.

Open review point:

- [ ] Confirm whether this section is in current scope before implementation, because it touches many SQL writers.

---

## 7. Client State Feed Subject Identity

Goal: replace client-feed `subjectDomain` with namespace identity if in scope.

Files:

- [ ] `src/database/schema.ts`
- [ ] `src/client-state-feed/client-state-feed.service.ts`
- [ ] `src/user/p2p-intent/authored/user-intent-client-feed-sql.ts`
- [ ] `src/group/membership-intent/**/*.ts`
- [ ] `src/group/disband/**/*.ts`
- [ ] frontend state-feed consumers under `web/src/app/services/`

Open review point:

- [ ] Confirm whether to migrate `ClientStateFeed.subjectDomain` now. This may re-open frontend changes even though current web build passes.

---

## 8. Forward Bundle Domain / Root Provenance

Goal: forward keeps optional domain provenance and adds optional public root key, without using either as mandatory identity for profile resolution.

Files:

- [ ] `src/forward/forward-bundle.service.ts`
- [ ] `src/forward/forward-bundle.service.spec.ts`
- [ ] shared forward/message content schemas, if any
- [ ] `spec/v1/message/forward.md` or relevant spec files

Current intended model to confirm:

- Forward source/provenance may carry optional domain.
- Add optional public root key.
- Both domain and public root key are optional.
- Profile references inside forwarded content should use namespace/profile 4-tuple where applicable.

Open review point:

- [ ] Decide wire shape:
  - flat fields: `sourceDomain?: string`, `sourcePublicRootKey?: string`; or
  - structured field: `source?: { domain?: string; publicRootKey?: string }`.

---

## 9. Delete / Report / Moderation Paths

Goal: authorization/audit paths should not depend on message author domain.

Files:

- [ ] `src/message/deleted-message.service.ts`
- [ ] `src/message/message-report.service.ts`
- [ ] `src/federation/federation-thread-query-denial.service.ts`
- [ ] federation delete/tombstone paths as needed

Preferred direction:

- Author verification uses `creatorAccount + profileNamespaceId`.
- Federation source verification uses `publisherNamespaceId`, `originSeq`, and peer/namespace binding, not author domain.
- Query-denial/member diagnostics should project member namespace metadata instead of `memberDomain` as a member identity field.

---

## 10. Database Schema and Migrations

Goal: rewrite base migration to the final domain/namespace model now that destructive history rewrite is allowed.

Files:

- [ ] `src/database/schema.ts`
- [ ] `src/database/relations.ts`
- [ ] `database/migrations/0000_base.sql`
- [ ] `database/migrations/0004_profile_publisher_namespace.sql` or remove/squash if appropriate
- [ ] `database/migrations/0010_namespace_identity_cutover.sql` may become redundant or be rewritten/removed depending on migration strategy

Schema cleanup targets:

- [x] Remove `Message.creatorDomain` from base schema.
- [x] Remove old `Profile` domain keying from base schema.
- [x] Remove `GroupMetaMemberFeed.memberDomain` from base schema.
- [ ] Rebuild indexes/constraints around namespace identity.
- [ ] Rebuild `PeerStateFeed`/`ClientStateFeed` subject identity if Sections 6/7 are accepted.
- [x] Update trigger SQL that compares `creatorDomain` or joins Profile by domain.

---

## 11. Specs / Protocol Docs

Goal: keep protocol docs aligned with final model.

Files to revisit after implementation:

- [ ] `spec/v1/protocol.md`
- [ ] `spec/v1/profiles.md`
- [ ] `spec/v1/message.md`
- [ ] `spec/v1/message/envelope.md`
- [ ] `spec/v1/message/forward.md` if present
- [ ] `spec/v1/schema/*.json`
- [ ] `spec/v1/schema/vectors/*.json`
- [ ] `CONFORMANCE.md`
- [ ] `docs/overview/database.md`
- [ ] `docs/design/canonical-group-meta.md`
- [ ] `docs/design/federation-namespaces.md`

Specific checks:

- [ ] No profile exact key includes domain.
- [ ] Message author identity is namespace-based.
- [ ] Group message author namespace is inside `author.namespaceId`, not a top-level message `namespaceId`.
- [x] No profile/member endpoint path contains `memberDomain`.
- [ ] Forward source domain/root-key optionality documented.
- [ ] Transport target domain remains in transport/discovery sections only.

---

## 12. Additional Audit Findings

These were found by broad repository searches and are not fully covered by the sections above.

- [x] `src/message/pending-media-row.ts` no longer models pending-media identity with `creatorDomain`; inbound transport provenance remains separate from message author identity.
- [ ] `src/message/thread-preview.service.ts` and `src/message/thread-feed.service.ts` expose namespace-only preview/profile author coordinates for now; a later UI display-domain enrichment can resolve namespace metadata without changing identity keys.
- [x] `src/message/thread-feed-head.writer.ts` still compares `message."creatorDomain"` against viewer domain; replace with namespace-based self/remote visibility logic.
- [x] `src/federation/federation-inbound-media-batch.service.spec.ts`, `src/federation/federation-media-localization.service.spec.ts`, `src/federation/federation-message-feed.service.spec.ts`, and `src/federation/federation-message-isolation.spec.ts` no longer contain old `creatorDomain` fixtures.
- [x] `src/federation/federation.service.spec.ts` no longer contains obsolete `creatorDomain` fixtures; remaining `memberDomain` fields are transport/display coordinates.
- [ ] Search gates before final verification:
  - [x] namespace/domain identity audit completed for source and message paths.
  - [ ] `rg -n "toProfileWireDomain|profileDomainForNamespace|key\\.domain|target\\.domain|wake\\.key\\.domain" src shared web/src src-tauri/src`
  - [ ] `rg -n "subjectDomain" src/federation src/client-state-feed src/group src/user web/src spec docs`

## 13. Final Verification

- [ ] `npm run build:be`
- [ ] `npx vitest run shared/ src/`
- [ ] `cd web && npm run build`
- [ ] `cd admin-web && npm test`
- [ ] `cd admin-web && npm run build`
- [ ] `node tmp/check-vectors.mjs`
- [ ] PostgreSQL-backed e2e once DB is available.
