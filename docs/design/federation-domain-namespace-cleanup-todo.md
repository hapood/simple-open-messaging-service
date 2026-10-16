# Federation Domain-to-Namespace Cleanup TODO

This checklist tracks the remaining cleanup after the root-identity and
profile-demand redesign. Work through it one section at a time and re-run the
listed verification before moving to the next section.

## Status Summary

Identity-coordinate migration is complete. Domain is no longer part of message
author, profile, group membership, peer-state-feed subject, or client-state-feed
subject identity. The base migration has been rewritten (Section 10) and all
incremental migrations consolidated into `0000_base.sql`.

The v1 wire user-mention format is now `somfp://user/<namespaceId>/<account>`
(scheme 2b). Federation inbound/outbound passes message content through
unchanged — no namespace or domain conversion at the federation boundary.
CONTACT_CARD's `ContactCardTargetDto` no longer carries `domain`; the server
resolves the wire `domain` from `IdentityNamespace` by `namespaceId`. Legacy
compatibility code (`parseSomfpUserAddress`, `allowLocalDomain`, domain
fallbacks in `isSelfMentionMember`) has been removed.

What remains is **PostgreSQL-backed e2e** (blocked by a pre-existing NestJS DI
issue unrelated to the migration) and the broader `domain === 'local'` →
`namespaceId === 0` locality-check cleanup across the codebase.

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
- [x] Finish `src/message/message.service.ts` cleanup:
  - [x] quote visibility / hide-creators uses account + namespaceId;
  - [x] quote preview author lookup uses profile 4-tuple only;
  - [x] no inserts/selects reference `message.creatorDomain`;
  - [x] `stripMessageId` output has no domain.
- [x] Update related tests:
  - [x] `src/message/message.service.spec.ts`;
  - [x] `src/message/thread-feed.service.spec.ts`;
  - [x] `src/message/system-message-write.spec.ts`.

Notes:
- `PendingMedia.creatorDomain` is handled separately in Section 5.
- `message.service.ts` retains `user.domain === 'local'` (account-locality
  filter when resolving the local author) and `AccountTarget.domain` (account
  transport locality for fanout). These are account-locality/transport, not
  message-author identity.

---

## 2. Profile Evidence Projection Cleanup

Goal: profile evidence projection should not carry subject domain.

- [x] `ProfileEvidenceProjection.subjectDomain` removed from types.
- [x] P2P/member projection SQL moved to namespace-based matching.
- [x] Finish `src/message/project-p2p-message-profile-in-tx.ts` review:
  - [x] all author matching is account + namespaceId;
  - [x] participant exclusion uses namespace identity, not domain.
- [x] Finish `src/group/meta/publish-member-message-profile-in-tx.ts` review:
  - [x] remove all remaining `memberDomain`/`domain` references from member profile source projection;
  - [x] match `GroupMetaMemberFeed` by `(threadId, memberAccount, profileNamespaceId)`.
- [x] Update specs:
  - [x] `src/message/collect-committed-profile-work.spec.ts`;
  - [x] `src/profile-resolution/profile-evidence-projection.service.spec.ts`;
  - [x] group meta/member projection specs as needed.

---

## 3. Federation Message Feed / Tombstone / Peer Resource

Goal: remove `Message.creatorDomain` from outbound federation message selection/publication.

- [x] `src/federation/federation-message-feed.service.ts`
- [x] `src/federation/federation-message-tombstone-feed.service.ts`
- [x] `src/federation/federation-peer-resource.service.ts`
- [x] `src/federation/federation-quote-target.ts`

Decisions applied:

- [x] Feed dedup/origin coordinate logic uses message timeline/source coordinates, not author domain.
- [x] Author identity uses `creatorAccount + profileNamespaceId`.
- [x] `publishFederationQuote` internal model stays message-coordinate based
  (`{ seq, originSeq }`), not profile-identity based. The stored quote
  coordinate carries its coordinate namespace.
- [x] `publishFederationQuote` does not take `profileNamespaceId`/`publisherNamespaceId` as identity; it uses `{ seq, namespaceId }` source coordinates and the peer namespace for origin resolution.

---

## 4. Inbound Federation Message Routing / Page / Media

Goal: inbound message routing should not persist author domain on Message; transport domain comes from route/peer binding.

Files reviewed:

- [x] `src/federation/federation-inbound-message-route.service.ts`
- [x] `src/federation/federation-inbound-message-page.service.ts`
- [x] `src/federation/federation-media-localization.service.ts`
- [x] `src/federation/federation-pending-media-promoter.ts`
- [x] `src/federation/select-inbound-message-profile-demand.ts`
- [x] `src/federation/federation.service.ts`
- [x] `src/federation/federation-profile.service.ts`

Decisions applied:

- [x] Inbound profile demand/projection uses publisher namespace, profile namespace, account, rev.
- [x] Media localization transport domain comes from route/binding/source peer, not `Message.creatorDomain`.
- [x] Inbound wire `author.domain` is removed. Group messages use `author: { account, namespaceId }`; P2P messages use `author: { ref, namespaceId }`.

Follow-up checks:

- [x] `FederationService.publishMessageQueryEffects` must not read `effect.author.domain`; pending downloads should use the source peer transport domain already passed to the method.
- [x] `FederationProfileService` raw SQL must not join/filter Message authors by `m."creatorDomain"`; use `m."profileNamespaceId" = profile."profileNamespaceId"` and local author namespace `0` where appropriate.
- [x] Inbound route/page specs must stop constructing `author.domain`, top-level `namespaceId`, or `creatorDomain` route expectations.

---

## 5. Pending Media / Upload Staging

Goal: remove outbound local staging dependence on `PendingMedia.creatorDomain`.

- [x] `src/database/schema.ts`
- [x] `src/message/message.service.ts`
- [x] `src/message/pending-media-row.ts`
- [x] `src/upload/resumable-upload.service.ts`
- [x] `src/federation/federation-inbound-media-batch.service.ts`
- [x] `src/federation/federation-pending-media-promoter.ts`

Applied model:

- [x] Outbound pending media author identity: `{ creatorAccount, publisherNamespaceId }`, with local authors using namespace `0`.
- [x] Inbound pending media retains transport/source fields needed to resume downloads, but not as message-author identity.
- [x] `PendingMedia_direction_shape_check` updated accordingly.

---

## 6. Peer State Feed Subject Identity

Goal: keep peer transport target domain, but replace subject identity domain.

- [x] `src/database/schema.ts`
- [x] `src/federation/peer-state-feed.service.ts`
- [x] `src/federation/federation-audience.ts`
- [x] `src/federation/federation-message-feed.service.ts`
- [x] `src/federation/federation-message-tombstone-feed.service.ts`
- [x] `src/federation/federation-thread-content-head.service.ts`
- [x] all group/user intent SQL writers touching `PeerStateFeed`

Applied model:

- [x] `peerDomain`/`domain` columns removed from `PeerStateFeed` where they
  represented identity; transport target domain is resolved at send time from
  the namespace binding.
- [x] `subjectDomain` replaced with `subjectNamespaceId`.
- [x] Compaction PK changed from `(subjectAccount, subjectDomain)` to `(subjectAccount, subjectNamespaceId)`.
- [x] Validation checks updated for relationship intent and thread-content-head events.

---

## 7. Client State Feed Subject Identity

Goal: replace client-feed `subjectDomain` with namespace identity.

- [x] `src/database/schema.ts`
- [x] `src/client-state-feed/client-state-feed.service.ts`
- [x] `src/user/p2p-intent/authored/user-intent-client-feed-sql.ts`
- [x] `src/group/membership-intent/**/*.ts`
- [x] `src/group/disband/**/*.ts`
- [x] frontend state-feed consumers under `web/src/app/services/`

Applied model:

- [x] Server controller sends `subjectNamespaceId` (wire field) — no
  `subjectDomain` is sent. `ClientStateFeed.domain` column remains for the
  account transport domain (used by client compaction keys and display), which
  is account-transport, not subject identity.
- [x] Client wire types (`ClientStateFeedItem`, `ClientFriendIntentBase`,
  `ClientGroupInviteIntent`) and compaction keys (`friendRequestKey`,
  `groupRequestKey`) use `subjectNamespaceId`.
- [x] Group body `domain`/`isLocal` removed from `FriendRequestProjection.group`;
  group identity uses `account + namespaceId`.
- [x] Disband wake is namespace-keyed (`pushStateFeedNamespaces`), domain
  resolved at send time by the scheduler.

---

## 8. Forward Bundle Domain / Root Provenance

Goal: forward keeps optional domain provenance and optional public root key, without using either as mandatory identity for profile resolution.

- [x] `src/forward/forward-bundle.service.ts`
- [x] `src/forward/forward-bundle.service.spec.ts`
- [x] shared forward/message content schemas, if any
- [x] `spec/v1/message/forward.md` and relevant spec files

Applied model:

- [x] Forward source/provenance carries optional `sourceDomain` (flat field).
- [x] Optional `publicRootKey` is a wire field on the forward author
  (`publicRootKeyForNamespace` derivation), not a persisted identity column.
- [x] Both `sourceDomain` and `publicRootKey` are optional.
- [x] Profile references inside forwarded content use namespace/profile 4-tuple where applicable.
- [x] Wire shape decision resolved: `author.publicRootKey?` flat field on the
  author; `sourceDomain?` provenance field. No structured `source?` wrapper.

---

## 9. Delete / Report / Moderation Paths

Goal: authorization/audit paths should not depend on message author domain.

- [x] `src/message/deleted-message.service.ts`
- [x] `src/message/message-report.service.ts`
- [x] `src/federation/federation-thread-query-denial.service.ts`
- [x] federation delete/tombstone paths as needed

Applied model:

- [x] Author verification uses `creatorAccount + profileNamespaceId`.
- [x] Federation source verification uses `publisherNamespaceId`, `originSeq`, and peer/namespace binding, not author domain.
- [x] Query-denial/member diagnostics project member namespace metadata instead of `memberDomain` as a member identity field.

---

## 10. Database Schema and Migrations

Goal: rewrite base migration to the final domain/namespace model now that destructive history rewrite is allowed.

- [x] `src/database/schema.ts`
- [x] `src/database/relations.ts`
- [x] `database/migrations/0000_base.sql`
- [x] `database/migrations/0004_profile_publisher_namespace.sql` — squashed into `0000_base.sql` (file removed)
- [x] `database/migrations/0010_namespace_identity_cutover.sql` — squashed into `0000_base.sql` (file removed)

All incremental migrations `0001`–`0012` were squashed into a single
`0000_base.sql` generated from the final schema via `pg_dump --schema-only`
from a reference database built by the previous migration chain. The base
now carries the final namespace-identity model directly:

- `Message` uses `publisherNamespaceId` (no `creatorDomain`, no `sourceNamespaceId`).
- `Profile` primary key is `(publisherNamespaceId, account, profileNamespaceId, profileRev)` (no `domain`).
- `ThreadAudience` has no `targetDomain` (local/peer encoded by `localUserId`/`targetNamespaceId`).
- `PeerStateFeed` has no `peerDomain`/`domain` columns; PK uses `subjectNamespaceId`.
- `PendingMedia`/`FileSyncProgress` use `publisherNamespaceId`.
- `ClientStateFeed` uses `subjectNamespaceId` (no `subjectDomain` column).
- Dead functions left behind by the old incremental cutover
  (`client_thread_state_after_pair`, `client_thread_state_after_participant`,
  `publish_client_thread_state`) were removed; the `thread_feed_*` triggers
  are the live trigger set.

Schema cleanup targets:

- [x] Remove `Message.creatorDomain` from base schema.
- [x] Remove old `Profile` domain keying from base schema.
- [x] Remove `GroupMetaMemberFeed.memberDomain` from base schema.
- [x] Rebuild indexes/constraints around namespace identity.
- [x] Rebuild `PeerStateFeed`/`ClientStateFeed` subject identity (`subjectNamespaceId`).
- [x] Update trigger SQL that compares `creatorDomain` or joins Profile by domain.

Verification:

- [x] A fresh database built with the new `0000_base.sql` produces 1488 schema
  objects, matching the reference database built by the previous full migration
  chain (`0000_base` + `0001`–`0012`).
- [x] `npm run build:be` and `npm test` (1740 unit tests) pass.
- [x] The migration system (`migrate-db.ts`) applies the single `0000_base`
  migration and records its checksum.
- [ ] PostgreSQL-backed e2e remains blocked by a pre-existing NestJS DI issue
  (`FederationRecognitionService` undefined at `FederationPeerHttp` index [2],
  unrelated to this migration rewrite — reproduced with both old and new
  migration files).

---

## 11. Specs / Protocol Docs

Goal: keep protocol docs aligned with final model.

The original completed checkboxes overstated specification alignment. The
user-directed closeout pass has now corrected message authors, Group Meta body
shapes, profile response objects, and group-origin mention scope. This is not a
blanket completion claim: the subsequent user-authorized correction now makes
group-origin message queries submission-only and filters returned mirror copies
before receipt association, with federation unit regressions passing. Local
cached-profile disclosure checks remain deferred; remaining decisions and
multi-node verification are tracked in the temporary
[closeout audit](../development/documentation-closeout-audit.md).

Files reviewed:

- [x] `spec/v1/protocol.md`
- [x] `spec/v1/profiles.md`
- [x] `spec/v1/message.md`
- [x] `spec/v1/message/envelope.md`
- [x] `spec/v1/message/forward.md`
- [x] `spec/v1/schema/*.json`
- [x] `spec/v1/schema/vectors/*.json`
- [x] `CONFORMANCE.md`
- [x] `docs/overview/database.md`
- [x] `docs/design/canonical-group-meta.md`
- [x] `docs/design/federation-namespaces.md`

Specific checks:

- [x] No profile exact key includes domain.
- [x] Message author identity is namespace-based.
- [x] Group message author namespace is inside `author.namespaceId`, not a top-level message `namespaceId`.
- [x] No profile/member endpoint path contains `memberDomain`.
- [x] Forward source domain/root-key optionality documented.
- [x] Transport/routing domains and explicit display snapshots remain where needed; domains are not part of exact profile keys or message/Group Meta subject wire objects.

---

## 12. Additional Audit Findings

These were found by broad repository searches and are not fully covered by the sections above.

- [x] `src/message/pending-media-row.ts` no longer models pending-media identity with `creatorDomain`; inbound transport provenance remains separate from message author identity.
- [x] `src/message/thread-preview.service.ts` and `src/message/thread-feed.service.ts` expose namespace-only preview/profile author coordinates; a later UI display-domain enrichment can resolve namespace metadata without changing identity keys.
- [x] `src/message/thread-feed-head.writer.ts` no longer compares `message."creatorDomain"` against viewer domain; it uses namespace-based self/remote visibility logic.
- [x] `src/federation/federation-inbound-media-batch.service.spec.ts`, `src/federation/federation-media-localization.service.spec.ts`, `src/federation/federation-message-feed.service.spec.ts`, and `src/federation/federation-message-isolation.spec.ts` no longer contain old `creatorDomain` fixtures.
- [x] `src/federation/federation.service.spec.ts` no longer contains obsolete `creatorDomain` fixtures; remaining `memberDomain` fields are transport/display coordinates.
- [x] Search gates before final verification:
  - [x] namespace/domain identity audit completed for source and message paths.
  - [x] `rg -n "toProfileWireDomain|profileDomainForNamespace|key\.domain|target\.domain|wake\.key\.domain" src shared web/src src-tauri/src` — no identity-keying uses remain; hits are transport/locality/binding only.
  - [x] `rg -n "subjectDomain" src/federation src/client-state-feed src/group src/user web/src spec docs` — only `federation.service.ts` expiry-sweep SQL derivation (`sns.domain AS "subjectDomain"`, co-extracted with `subjectNamespaceId` for the transport-domain component of `toClientIdentity`) and this document remain.

## 13. Wire Mention Format & Federation Pass-Through (Scheme 2b)

Goal: replace the user-mention wire format and remove all namespace/domain
conversion at the federation boundary. The protocol is unreleased, so no
backwards compatibility is retained.

- [x] `spec/v1/message/text.md`: grammar changed to `somfp-user = "somfp://user/" namespace-id "/" user-account`; examples updated.
- [x] `spec/v1/schema/vectors/valid.json`: mention vector updated to `somfp://user/12/bob`.
- [x] `src/common/message-entity.ts`: `serializeUserMention(label, namespaceId, account)`; `parseEntityAt` parses two-segment path `namespaceId/account`.
- [x] `src/common/account.ts`: added `parseSomfpUserMentionEntity`; removed dead `parseSomfpUserAddress`.
- [x] `src/common/client-identity.ts`: removed unused `_localDomain` parameter from `toClientIdentity`.
- [x] `src/federation/federated-message-content.ts`: removed `localDomain` params from `toFederatedMessageContent`/`fromFederatedMessageContent`; removed `domainMapping` from `projectTextContent`; CONTACT_CARD passes through unchanged; removed `allowLocalDomain` switch.
- [x] `src/controller/message.controller.ts`: mention canonicalization uses `parseSomfpUserMentionEntity` + `serializeUserMention(label, namespaceId, account)`; `resolveActiveMember` takes `{ account, namespaceId }`.
- [x] `src/message/message.service.ts`: mention validation uses `parseSomfpUserMentionEntity`.
- [x] `src/message/thread-feed-head.writer.ts`: removed `ownDomain`.
- [x] `mentionsAccount` compares the complete group-origin namespace/account pair. Thread attention reads the origin's peer-assigned viewer namespace; PostgreSQL tests cover mirrored same-account identities and unknown mappings.
- [x] `src/group/group.service.ts`: `resolveActiveMember` identity is `{ account, namespaceId }`.
- [x] `src/group/meta/current-group-roster.ts`: `readCurrentGroupMemberByAddressInTx` identity is `{ account, namespaceId }`.
- [x] Frontend `web/src/app/lib/message-entity.ts`: `serializeUserMention(label, namespaceId, account)`; `serializeUserMentionFromChipId`; `toRenderMessageEntities` compares the complete group-origin namespace/account pair, using required nullable `selfMentionNamespaceId` from the thread feed. Optimistic sends and editor self filtering share that coordinate; web/Rust caches persist it without legacy compatibility or schema-version changes.
- [x] Frontend `web/src/app/components/chat-editor/mention-candidates.ts`: `isSelfMentionMember` uses `namespaceId` only; removed domain fallback.
- [x] Frontend mention chip id is `namespaceId/account`; specs updated.

## 14. CONTACT_CARD Client No-Domain

Goal: the client sends only `(account, namespaceId, profileRev)` for a contact
card target; the server resolves the wire `domain` from `IdentityNamespace`.

- [x] `src/dto/message.dto.ts`: `ContactCardTargetDto` removed `domain`.
- [x] `src/message/contact-card/contact-card-target.ts`: locality via `namespaceId === 0`; removed `domain` validation.
- [x] `src/group/group.service.ts`: `findVisibleGroupByAddress` queries by `namespaceId` only.
- [x] `src/account-thread-state/...`: `findP2PFriendByAddress` queries by `namespaceId`.
- [x] `src/message/contact-card/contact-card-profile.service.ts`: `findProfile` signature removed `domain`.
- [x] `src/controller/message.controller.ts`: resolves wire `domain` via `federation.activePeerDomainForNamespace(namespaceId)`.
- [x] Frontend `web/.../model.ts`: added `ContactCardSendTarget` (no `domain`).
- [x] Frontend `web/.../message.service.ts`: `sendContactCard` sends only `account, namespaceId, profileRev`.
- [x] Frontend `web/.../contact-card-share.service.ts`, `message-thread-adapter.ts`: removed `domain` from target.
- [x] Specs updated (`message-contact-card.spec.ts`, `playground-*.spec.ts`).

## 15. Remaining: Locality-Check Cleanup

Goal: replace `domain === 'local'` locality checks with `namespaceId === 0`
across the codebase (~60 sites). `domain` should be used only for
transport/routing/display, never for identity-locality decisions.

Also pending: remove the `messageThread.groupDomain` column (currently
participates in a unique index and CHECK constraints; replacement is
`authorityNamespaceId`).

- [ ] Replace `domain === 'local'` / `domain !== 'local'` with `namespaceId === 0` / `namespaceId !== 0` in quota, user, federation, group, message, controller, relationship, durable-task domains.
- [ ] Remove `messageThread.groupDomain` column from schema + base migration; rebuild unique index on `(groupAccount, authorityNamespaceId)`.

## 16. Final Verification

- [x] `npm run build:be`
- [x] `npx vitest run shared/ src/` (1736 passed)
- [x] `cd web && npm run build`
- [x] `cd admin-web && npm test` (57 passed)
- [x] `cd admin-web && npm run build`
- [x] `node tmp/check-vectors.mjs` (63 checked, all consistent)
- [ ] PostgreSQL-backed e2e once DB is available.
