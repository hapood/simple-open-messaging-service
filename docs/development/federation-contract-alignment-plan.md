# Federation Contract and Implementation Alignment Plan

## Status and purpose

Status: F01's stable-namespace contract is operator-approved and its targeted
runtime regressions passed. Approval-time proof is mandatory in this
implementation, but SHOULD in the protocol. F01a's preservation of existing
acceptance without re-handshake is operator-approved. First-pin
selection and other contract decisions remain open. Work proceeds one item at
a time; passing targeted tests is not full protocol acceptance.

Align the current SOMFP v1 draft across normative text, business behavior,
wire validation, examples, and tests. The initial review identified conflicts;
each finding must be revalidated against the complete implementation path before
choosing a correction. Existing code is evidence of current behavior, not an
authority that overrides the protocol or determines the best design.

This is an implementation work plan, not part of the normative release package.
The contract remains under [spec/](../../spec/README.md).

## Working rules

1. Investigate one item and present its business consequences and proposed
   contract before editing. Confirm identity, security, lifecycle, or wire-shape
   choices with the operator; do not silently decide them through an edit.
2. Trace both publisher and consumer, including HTTP controllers, guards,
   response classification, domain services, durable writes, background work,
   and affected client projections. A controller-only inspection is insufficient.
3. Classify the outcome as a text defect, implementation defect, artifact defect,
   or an intentional draft-contract change. An already-correct layer needs no
   artificial rewrite, but record why it is unaffected.
4. Complete each item as one logical change: normative text, implementation,
   schemas, manifest, vectors, examples, tests, and current implementation docs
   must describe the same decision. Do not defer all artifact updates to the end.
5. Preserve business ownership. Reusable relationship, membership, and profile
   rules belong in their domain capabilities, not only in generic task handlers.
   Native client business/runtime changes belong in Rust; platform adapters stay
   thin. Do not add source-to-documentation path references.
6. Preserve unrelated working-tree changes. Do not reset databases, retire
   identities, rewrite deployed migrations, or clear caches as a shortcut.
   If persisted data must change, assess compatibility and use a new migration.
7. Retain established lock ordering and use appropriate non-key write locks.
   Identity and authorization changes require PostgreSQL-backed concurrency
   verification, not just mocks or schema validation.
8. Record commands and actual outcomes. Static inspection, an existing test,
   and a previously passing test are not evidence of newly verified behavior.

## Per-item completion gate

An item is complete only when its record includes:

- [ ] Revalidated conflict and observed publisher/consumer behavior.
- [ ] Agreed contract, invariants, and reason for the choice.
- [ ] Business, persistence, security, client, and compatibility impact assessment.
- [ ] Synchronized normative documents and affected implementation.
- [ ] Synchronized schemas, manifest, vectors, and examples, or explicit N/A.
- [ ] Regression tests for successful, rejected, replayed, and racing paths as applicable.
- [ ] Executed verification results, or an explicit verification blocker.
- [ ] Remaining limitations and related documentation updates.

If execution is blocked or paused, use `implemented; verification pending`, not
`complete`. Each item below remains `pending` until its investigation begins.

## Sequence and issue ledger

| Order | ID | Topic | Status |
| --- | --- | --- | --- |
| 1 | F01 | Root rotation and stable namespace identity | Aligned; targeted runtime tests passed |
| 1a | F01a | Approval-time acceptance and reachability evidence | Preservation and atomic replacement implemented; targeted tests passed |
| 2 | F02 | Initiator pin selection versus outbound root header | Header corrected; bootstrap selection decision pending |
| 3 | F03 | Recognize failures, HTTP envelopes, and fatal lifecycle mapping | Envelope + operation-level codes aligned; E2E blocked by unrelated compile errors |
| 4 | F04 | Root-rotation continuity proof and legal-arrival exception | Proof enforced; targeted tests passed; boundary verification remains |
| 5 | F05 | Health privacy and transport-failure exceptions | Resolved: single `200` envelope; no error envelope; non-`200` = generic transport failure |
| 6 | F06 | State Feed directional authorship | Core wording corrected; source-authored directions retained for P2P and GROUP |
| 7 | F07 | Sealed-challenge byte representation | Resolved: `value`/`proof` are canonical padded base64 of the recovered bytes; strict wire schema; callers compare against base64 of original bytes |
| 8 | F08 | Join-intent to Group Meta namespace translation | Group Meta wording clarified; origin-assigned namespace and selected revision distinguished |
| 9 | F09 | Recognize idempotency coordinates | Resolved: unified on `(signerRootKey, recipientDomain)`; four-category Recognize result model normative in §7 |
| 10 | F10 | Profile parameters and remaining field-description drift | Resolved: five local wording corrections; no wire or implementation change |
| 11 | F11 | Complete HTTP and message examples | Corrected identified examples and vectors; targeted checks pass |
| 12 | F12 | Cross-artifact regression coverage and final alignment audit | In progress: E2E blocker cleared; remaining documentation and recognition safety findings recorded |

### F01 — Root rotation and stable namespace identity

**Conflict:** [Recognition §4.5 and §11](../../spec/v1/recognition.md)
allocates a successor namespace, whereas
[Profile Namespace Feed §1](../../spec/v1/profile-namespace-feed.md) replaces
bindings on the same namespace id.

**Implementation entry points:**
[namespace administration](../../src/admin/federation-namespace-admin.service.ts),
[recognition](../../src/federation/federation-recognition.service.ts),
[namespace service](../../src/federation/federation-namespace.service.ts),
[namespace feed](../../src/federation/profile-namespace-feed.service.ts), and
[database schema](../../src/database/schema.ts).

**Observed implementation:** `applyRootRotation` updates the existing namespace
row and publishes its binding change.
[The root-rotation E2E test](../../test/federation-root-epoch-rotation.e2e-spec.ts)
asserts namespace preservation; expanded wire assertions passed in the targeted run.
The approval code's former acceptance/reachability reset is corrected separately
under F01a rather than hidden in the namespace correction.

**Approved decision:** preserve both disclosed namespace coordinates across
approved root rotation; change the root binding, not subject identity. The
rotating publisher announces its own change at namespace `0`. Destructive reset
is distinct and does not reuse a retired namespace. No message rewrite,
historical-data migration, or old-wire compatibility branch is intended.

**Scoped acceptance:** verify unchanged namespace disclosure in Recognize and
Health, same-id feed publication and binding resolution, and no namespace birth
or retirement during rotation. Unit coverage checks that rejection emits no
binding-change notification and approval does not reset namespace coordinates
or feed progress. Existing stale-review and duplicate-decision tests remain;
proof/admission concurrency and approval evidence are covered separately by
F04 and F01a. See the F01 record below for actual verification results.

### F01a — Approval-time acceptance and reachability evidence

**Approved correction:** the operator requires existing acceptance to survive
approved root/domain changes without a new reciprocal handshake. Both approval
updates preserve acceptance instead of resetting it. Successful verification
refreshes reachability and makes an already accepted, locally prepared peer
available; it neither invents acceptance nor revives a halted peer. A domain arrival records its review without clearing the
existing peer's acceptance or changing admission under the old binding. The
proposed binding remains unusable until approval. Approval no longer schedules
an automatic reciprocal Recognize solely to rebuild discarded evidence.

**Certificate boundary:** approval obtains a validated well-known document and
performs its challenge outside decision locks. Under the review and namespace
locks it revalidates the binding and certificate validity, then replaces the
pin/domain and certificate set, updates reachability, publishes feed changes,
and marks the review approved in one transaction. Notifications run only after
commit. No reciprocal handshake is scheduled. Existing inbound verification
is cache-only; clearing the cache without installing successor certificates
was exposed by the root E2E and is not a valid no-handshake solution.

**Rollback verification:** PostgreSQL triggers inject failure at successor
certificate insertion and at the final review update. Snapshots of namespace,
old certificates, review, both binding feeds and feed heads remain unchanged;
no client notification or refresh is emitted. Success cases test degraded to
available with acceptance retained and ensure absent acceptance stays absent.

**Acceptance:** test the chosen gates under approval, lost notifications,
concurrent requests, stale key/context use, and retry. Do not fix a lifecycle
mismatch by renumbering subjects or rewriting business history.

### F02 — Initiator pin selection versus outbound root header

**Conflict:** [Recognition §4.1](../../spec/v1/recognition.md) describes B's root
as the header on A's outbound request; [Transport §3.3](../../spec/v1/transport-security.md)
requires the root authorizing A's signing certificate.

**Inspect:** recognition initialization, `keypair.service.ts`,
`signature.service.ts`, `federation-peer-http.ts`, and `s2s-signature.guard.ts`
under `src/federation/`, including well-known root selection during overlap.

**Progress:** corrected the reversed header ownership in Recognition §4.1:
A selects B's pin independently and sends A's certificate-authorizing root.
`SignatureService.signOutbound` already reads the local keypair's root, and
`runRecognize` delegates signing without substituting the recipient's root.
Added an outbound Recognize signing regression and a database-backed recognition
case using the real outbound signer with mocked discovery/transport. The latter
publishes two recipient roots, only one with a current certificate, and checks
that the persisted recipient pin differs from the sender root on the signed
request. Both regressions passed in the targeted run recorded below. This does
not yet verify receiver-side wrong-root rejection or the complete bootstrap
flow. Test-project TypeScript checking also passed.

**Open selection decision:** `runRecognize` currently requires exactly one root
authorizing current certificates before preparing any outbound recognition.
Transport permits multiple root entries, but its rotation publication rule
removes predecessor certificates on switching. Specify first-pin selection
separately from established-pin continuity, including ambiguous live certifying
roots and a retained pin with no remaining live certificate. Do not silently
turn current implementation behavior into the normative selection rule.
The operator identified existing-pin continuity as a code defect and authorized
its repair. `prepareOutbound` now inspects the full fetched root group under
the namespace lock: an existing published pin is retained independently of
which root authorizes current certificates. Only first contact uses unique
certifying-root selection. A missing pin still commits identity loss before
raising the conflict. This repair does not select or adopt a successor root.
Added database-backed regressions for predecessor-first and successor-first
root order after certificate cutover, unchanged namespace/cursor/disclosure,
and missing-pin rejection. Test-project TypeScript, Prettier checks on changed
files, and `git diff --check` passed; the added runtime regressions also passed
in the targeted run recorded below.

**Remaining first-contact proposal, not yet approved:** first-contact outbound recognition
selects the unique root authorizing validated, currently valid certificates;
multiple root entries alone are not ambiguous. If multiple roots authorize
current certificates, do not choose by array order, key name, or timestamp and
do not establish a pin from that discovery result. Existing relationships
retain their pin: discovering successor certificates does not authorize root
adoption or by itself constitute identity loss while the pin remains published.
Successor adoption continues through the reviewed rotation path. Specify retry
and ordinary-traffic behavior together with F04. The existing-pin correction
above follows the already specified certificate-cutover and pin-retention
rules; it does not depend on accepting the first-contact proposal.

**Challenge enforcement:** the operator required challenge-backed continuity.
Approval now runs its own fresh predecessor challenge against a captured review
and revalidates the proposed binding under locks before mutation. The operator
chose approval-time automatic checking; the separate admin check endpoint and
its UI/API surface have been removed. See F04 for test scope
and the remaining runtime-verification requirement.

**Acceptance:** use distinct A/B roots and multiple published roots. Prove that
A pins B under a defined selection rule while its request claims A's signing
root. Wrong-root headers fail without replacing a pin. Align bootstrap vectors
and sender/receiver tests, not only the prose.

### F03 — Recognize failures, envelopes, and fatal mapping

**Review:** [unification findings and proposal](./federation-recognize-error-unification-review.md).
The operator approved the envelope direction: Recognize and Health success
responses use the common success envelope with closed `data` result objects;
failures use the common error envelope; well-known and raw media stay bare.

**Approved and implemented so far (envelope scope):**

- Removed the `ok`/`failed` Recognize result variants. Success is
  `code: 0, message, data` where `data` is the closed `pending`/`recognized`
  object; producer and strict consumer parsing reject the legacy shapes.
- Health now returns the same success envelope with `available`, `degraded`,
  or uniform `unavailable` `data`. Authentication, resolution, and disclosure
  failures still answer `200` with `code: 0` and `unavailable`; no reason is
  exposed through code, message, or data. The `503` transport exceptions are
  unchanged.
- A non-zero `code` inside HTTP `200` rejects only the current operation; the
  outbound Recognize consumer no longer fabricates a `409` status from it, so
  an application failure cannot be mistaken for authenticated fatal evidence.
- Synchronized recognition.md/protocol.md prose, identity schema
  (`recognizeResult` now describes envelope `data`), HTTP manifest
  (`responseEnvelope` for recognize/health), and valid vectors for both
  success envelopes. Conformance package passes.
- Updated unit tests (78 passing across the four touched suites) and the
  recognition/rotation E2E expectations to the envelope shapes. A stale
  domain-review unit expectation was corrected to the F01a rule that a pending
  review does not quarantine the existing peer's acceptance.

**Verification blocker (unrelated to this change):** the E2E harness compile
step fails in `src/admin/federation-self-check.service.ts` and the untracked
`src/federation/srv-rrset.ts`, both containing the user's unrelated
in-progress SRV work that imports `SrvRecord` from `node:dns/promises`, which
the installed `@types/node` does not export from that specifier. Root and
TypeScript checks for the rest of the project pass. Runtime E2E confirmation of
the envelope change is pending removal of that blocker; do not modify the
user's in-progress files to unblock it.

**Still open under F03 (operator decisions pending):** the status/code table
from the review — notably moving `50027`–`50029` to HTTP `200` operation
results, demoting domain-change rejection from fatal, asynchronous terminal
result retention, and the strict shared error-envelope classifier.

**Second operator approval and implementation (status/code scope):** the
operator approved the review's remaining recommendations.

- `FEDERATION_DOMAIN_CONFLICT` (`50027`), `FEDERATION_DOMAIN_CHANGE_REJECTED`
  (`50028`), and `FEDERATION_ROOT_CHANGE_REJECTED` (`50029`) are now HTTP `200`
  operation-level error results in the registry and Recognition's tables. Each
  refuses only the proposed binding change and preserves the existing
  relationship's pins, namespace, acceptance, and lifecycle. Domain-change
  rejection is no longer fatal; the fatal set is exactly `50009`, `50015`, and
  `50020` behind HTTP `409`.
- Fatal classification now requires a strictly parsed closed error envelope
  (`parseStrictPeerErrorEnvelope`): a fatal code with extra members, a missing
  message, a zero or non-safe-integer code, or a junk body is not halt evidence.
  Applied to both the Recognize HTTP-failure path and the shared peer-HTTP
  rejection path; the lenient parse remains for diagnostics only.
- The producer side already answered these codes on HTTP `200` (exception
  filter default), so no producer change was needed beyond tests.
- Updated recognition.md and errors.md prose/tables/examples accordingly;
  conformance package passes; the full backend unit suite (70 files, 685
  tests) passes, including new regressions: non-closed envelopes and
  operation-level codes on HTTP `409` must not halt.

**Still open under F03:** PostgreSQL-backed runtime confirmation once the
unrelated E2E compile blocker is cleared. The asynchronous terminal-outcome
gap itself is closed via the four-category model (see F09).

**Conflict:** [Recognition §8](../../spec/v1/recognition.md) returns bare
`200 failed` and applies code-specific halt actions; the
[error registry](../../spec/v1/errors.md) requires a common non-zero envelope
and restricts fatal actions to `409`. Its fatal summary also omits domain-change
rejection despite that registry row declaring it fatal.

**Inspect:** `s2s-recognition.controller.ts`, `federation-recognition.service.ts`,
`federation-peer-http.ts`, and `federation-errors.ts` under `src/federation/`;
`src/common/business-code.ts` and `src/common/exception.filter.ts`.

**Decide and synchronize:** one table for synchronous admission errors,
asynchronous terminal results, operation-only review refusals, and fatal peer
conflicts. Define exact HTTP/body combinations and provenance requirements.
Preserve the distinction between root-rotation rejection and domain-rebind
rejection unless an explicit contract decision changes it.

**Acceptance:** exercise both HTTP transport and application-result parsers;
unknown codes, status/code conflicts, forged or malformed responses, repeated
failed arrivals, and transient errors must not create unintended halt or
recognition effects. Update the error schema and validator expectations.

### F04 — Root-rotation continuity proof and arrival exceptions

**Conflict:** [Core §10](../../spec/v1/protocol.md) and
[Transport §1.5](../../spec/v1/transport-security.md) require predecessor-key
proof, while Recognition uses `SHOULD` and permits out-of-band confirmation.
Recognition §7 also rejects same-domain/different-root arrivals without stating
the legal rotation exception.

**Inspect:** namespace administration's approval-time challenge, `approve`, and
transactional review validation; recognition arrival resolution; verification
service; admin API/UI; persisted review evidence and audit fields.

**Approved policy distinction:** predecessor possession checking is SHOULD in
the independent protocol, including Core, Transport, Recognition, and the
conformance checklist. A failed check is not successful possession evidence;
local administration decides whether alternative evidence is sufficient.
Our implementation deliberately enforces successful automatic proof at approval
and provides no bypass. This stricter local policy is not a universal wire
requirement. Recognition §§4.5 and 11 recommend the possession check, and §7
explicitly permits the reviewed rotation exception rather than
rejecting every same-domain root change. No new wire field or schema is needed.

`approve` captures a pending review in a short transaction, runs a fresh sealed
challenge against its proposed domain outside row locks, and then locks the
review and namespace again. It compares review kind, namespace, matched domain,
proposed domain, successor root, and claim snapshot (including predecessor root)
before checking the current namespace pin and applying the change. Failure or
unreachability leaves the review and pin untouched; concurrent review replacement
or decision invalidates approval. The separate admin check endpoint, public
service method, admin client API/type/hook, check button, and diagnostic output
were removed at the operator's request. Approval is the sole admin action for
proof and adoption; the federation `/s2s/v1/verify` service remains. No proof
cache, new database field, or migration is introduced.

**Coverage added:** unit assertions for wrong plaintext, network failure, real
sealed-box opening, superseded binding, unchanged rejection behavior, and no
transaction spanning the challenge. New PostgreSQL-backed tests in
`test/federation-root-approval.e2e-spec.ts` acquire both rows from another
connection during the challenge and change the proposed domain, successor,
predecessor, decision, or current pin; approval must not publish or overwrite
those concurrent changes. The existing dual-node root-rotation test exercises
automatic approval-time proof with actual HTTP transport. These runtime tests
passed in the targeted run recorded below.
Admin API and UI tests now use approval as the only action and cover reporting
an automatic-proof failure without a success notification. The dual-node test
no longer calls a separate admin check endpoint before approving.

**Static verification:** backend/test-project TypeScript checking passed after
removing the separate endpoint. Prettier checks on the changed backend, test,
and admin client files and `git diff --check` passed. Admin application and
admin test-project type checks did not pass: they report widespread translation
key typing errors (for example `errors.parseFailed` and quota keys). These
checks do not establish an admin build pass, and unrelated translation typing
changes are not included in this correction. Targeted runtime tests were
subsequently authorized and passed; unrelated suites remain outside that scope.

**Boundaries:** proof plaintext encoding is still tracked by F07; this approval
uses a fresh base64 ASCII nonce, not arbitrary invalid UTF-8 bytes. Simultaneous
rotations at both ends and expired/missing predecessor cases need additional
runtime verification; the added tests do not establish complete rotation
conformance.

**Acceptance:** approval cannot bypass the agreed proof policy; evidence for
another or superseded review cannot authorize adoption. Test legal rotation,
unrelated roots, missing/expired predecessor, repeated review, and concurrent
pin or domain changes. No network I/O under a lifecycle database lock.

### F05 — Health privacy and transport-failure exceptions

**Conflict:** [Transport §3.5](../../spec/v1/transport-security.md) prohibits
all Health error envelopes; [Recognition §9.1](../../spec/v1/recognition.md)
allows only `503 RATE_LIMITED`; [Errors](../../spec/v1/errors.md) also allows
`503 INTERNAL` independent of peer existence.

**Resolution (implemented, spec-only):** Health defines exactly one response
— the HTTP `200` status envelope with the uniform privacy projection. It
emits no error envelope of any kind: a non-`200` or unparseable response is
not a Health result and is handled as a generic transport failure under the
Stable Error Registry's HTTP classification, identically for every operation.
Per operator decision, the interim `503 RATE_LIMITED`/`503 INTERNAL`
responder-side exception enumeration was removed entirely: transport
protection and generic server failure are infrastructure behavior, not
federation protocol semantics, and enumerating them was the source of the
original inconsistencies. Unified at recognition.md §9/§9.1, errors.md's
Health entry, and transport-security.md §3.5. The inbound implementation
already never emits `503` on Health, so no code change was required; Health
still initiates no well-known discovery.

**Acceptance:** one explicit exception set; authentication and disclosure
failures stay indistinguishable. Health never initiates inbound key discovery
or recognition. Test malformed/unknown/blocked signers, expired keys, generic
service failure, rate limiting, and lifecycle/reachability effects.

### F06 — State Feed directional authorship

**Conflict:** [Core §9](../../spec/v1/protocol.md) allows returning a fact
originally authored by the requester, while [State Feed §4](../../spec/v1/state-feed.md)
requires source-authored directions and prohibits authoring on a peer's behalf.

**Resolution (documentation only):** corrected Core §9, retaining State Feed
§4's source-authored rule for both user/user and user/group relationships.
A received request may trigger the publisher's own reverse-direction response;
it does not authorize republishing or transitioning the peer's direction.
The example distinguishes `user -> group REQUESTED` from the origin's
`group -> user ACCEPTED`. Group roster authority and message processing
receipts do not grant authority over the member-authored intent.

An earlier review mistakenly inferred member-direction echoing from outbound
feed allocation alone. Inspection of
`src/group/membership-intent/shared/group-membership-acceptance-sql.ts`
corrected that inference: `accepted_intent` selects the group-authored row,
and `peer_feeds` publishes with `account = groupAccount`. The remote member's
own direction is promoted by its home, not rewritten by the origin.
The consumer in `src/federation/federation-state-feed-consumer.service.ts`
also resolves the author from the authenticated source. No business code,
database migration, schema shape, or wire example payload was changed.

**Verification:** conformance package PASS; five targeted unit suites passed
(28 tests): protocol documentation, State Feed consumer, mirror membership
acceptance SQL, group membership revocation SQL, and group relationship fold.
The broader concurrency and recovery scenarios below remain the behavioral
acceptance checklist; a documentation-only correction does not establish
that every implementation path has been audited.

**Acceptance:** distinguish a peer request triggering a new locally authored
response from republishing the peer's own direction. Test crossed requests,
acceptance, revocation, expiration, replay, and compacted rebuild. Directional
authority and atomic local promotion must remain explicit for P2P and GROUP.

### F07 — Sealed-challenge byte representation

**Gap:** [Transport §3.7](../../spec/v1/transport-security.md) accepts arbitrary
plaintext bytes, but [Verify](../../spec/v1/recognition.md) and
[Profiles](../../spec/v1/profiles.md) return JSON strings without a reversible
byte-encoding rule.

**Inspect:** `sealed-box.ts`, `s2s-verify.controller.ts`, `keypair.service.ts`,
profile lookup and all challenge producers/comparators under `src/federation/`,
plus administrator verification consumers.

**Resolution (implemented):** both answer fields — Verify's `value` and
Profile's `proof` — are now the canonical RFC 4648 padded base64 encoding of
the recovered plaintext bytes (zero pad bits, empty plaintext = empty
string), never a UTF-8 interpretation. Transport §3.7 defines the single
answer-encoding rule (`Base64ChallengeAnswer`); Recognition §12 and Profiles
§3 reference it and instruct callers to compare the decoded answer with the
original bytes (equivalently, the answer string with the base64 of the
original bytes). Producers (`s2s-verify.controller.ts`,
`keypair.service.openCardChallenge`) encode with `toString('base64')`;
consumers (profile possession check, approval-time predecessor challenge,
harness, admin tests) compare against the base64 of the original bytes, so
legacy raw-plaintext answers fail closed. `common.schema.json` gained a
strict `base64ChallengeAnswer` definition (length- and pad-bit-exact, max
5464 chars); `identity.schema.json` `verifyResult.value` and
`profile.schema.json` `proof` reference it; valid vectors updated. This is a
draft-stage wire change: pre-encoding answers are invalid by schema. No
database change.

**Verification:** new `sealed-challenge-answer.spec.ts` covers non-UTF-8
binary round trips through both endpoints, the 4096/4097/4098 boundary
(same encoded length, distinguished by pad bits), empty plaintext, and
canonical-form rejection (legacy `hello`, missing/loose padding, non-zero
pad bits, whitespace). Full backend unit suite 2111 tests pass; conformance
package PASS; tsc clean (excluding the user's unrelated SRV WIP).

**Initial observation:** both verification response paths previously
converted opened bytes using `Buffer.toString('utf8')`, which silently
replaced non-UTF-8 challenge bytes and broke byte-for-byte comparison.

**Decide and synchronize:** choose one precise plaintext/response encoding and
byte limit; align Verify and Profile proof semantics. Recheck the sealed-box
layout/KDF prose against the primitive and independent interoperability vectors.

**Acceptance:** empty input, embedded NUL, multibyte text, invalid UTF-8,
arbitrary binary, limit boundaries, unknown keys, and damaged boxes have defined
outcomes. A byte-to-string conversion cannot silently alter a valid proof.

### F08 — Join-intent to Group Meta namespace translation

**Conflict:** [Group Meta §2](../../spec/v1/group-meta.md) requires the exact
join-intent namespace while also requiring the origin's positive namespace for
foreign members; the member-home intent uses its local namespace `0`.

**Resolution (documentation only):** clarified Group Meta §2 without changing
the namespace model in Core §6.2.1. A foreign member uses the namespace the
origin allocated for the member's home identity and disclosed through Peer
Recognition, not the reverse allocation or a receiver-local number. The first
`MEMBER_UPSERT` preserves the selected member identity and `profileRev`, not
the join intent's numeric namespace. A short H/G example translates H's local
`0` to G's existing `17` while retaining revision `42`; every receiver
interprets the published number in G's space. Joining does not allocate a new
namespace or trigger a new handshake.

Targeted source inspection of
`src/group/membership-intent/shared/group-membership-acceptance-sql.ts`
confirms that the roster fact uses the origin-side member namespace and the
member intent's selected revision. No business code, schema, or database was
changed. The broader scenarios below remain an implementation audit checklist,
not a claim that this documentation change verifies all such paths.

**Acceptance:** preserve subject identity and the selected immutable revision,
not a foreign publisher's numeric namespace. Use multiple homes with colliding
local namespace numbers. Test first join, delayed profile work, role-only
change, leave/rejoin, and subsequent message-selected profile replacement.

### F09 — Recognize idempotency coordinates

**Conflict:** Recognition §2 uses `(signerDomain, recipientDomain)` while §7
uses `(signerRootKey, recipientDomain)`.

**Resolution (implemented):** unified on `(signerRootKey, recipientDomain)`.
The root key is the only coordinate that separates a rotation arrival (same
domain, new root) from an ordinary re-recognition of the same domain, which a
domain-based coordinate would merge. §2's table row was corrected; §7 was
already authoritative. Implementation storage keys (domain/root/keyId in the
in-flight map, `matchedNamespaceId` for reviews) stay distinct from the
observable rule, as required.

Alongside the coordinate fix, F03's asynchronous terminal-outcome gap was
closed through the operator-approved four-category Recognize result model,
now normative in §7: (1) recognized, (2) pending, (3) cooled refusal
(HTTP `200` non-zero code, definitive for the sender's current evidence,
not a relationship state), (4) irrecoverable error (HTTP `409` with a
registered fatal code, backed by the durable `halted` state). The recipient
MUST answer immediately; cooldown windows, retention, coalescing, and
re-verification timing are explicitly implementation policy. An interim
bounded grace-window design was reverted after operator review because it
violated the always-answer-immediately design.

Implementation: `submitInboundRecognize` answers immediately; an in-process
cooldown map (`{50002, 50027}`, 10-minute default, never persisted) re-serves
definitive refusals per coordinate so they are no longer eternally
`pending`; `assertInboundNotHalted` answers a durably halted relationship
synchronously with `409 + haltCode`; a fatal identity contradiction is
therefore never cooled — it is durable. `FEDERATION_BAD_SIGNATURE` gained a
registry note and a Recognition table row change (delivered on Recognize as
the `200` cooled-refusal result, `401` remains the authenticated-route form).
No schema change was needed.

**Verification:** backend unit suite passes (2089 tests), including new
regressions for immediate pending with coalescing, cooled-refusal answering,
cooldown expiry re-verification, transient failures never cooled, and the
synchronous halted conflict; conformance package passes. PostgreSQL E2E
rerun remains blocked by the unrelated SRV compile error in user WIP files.

**Acceptance:** define ordinary attempt and review identity precisely. Replays,
new domains, new roots, rejected attempts, and concurrent arrivals cannot reset
first recognition or merge unrelated reviews. Keep implementation storage keys
distinct from the observable protocol idempotency rule.

### F10 — Profile and field-description drift

**Scope:** Profile introduction's no-query statement versus required
`publicKey/challenge`; the `profileNamespaceId` spelling versus wire
`namespaceId`; Recognize's all-fields-required sentence versus optional pending
`message`; stale resource/operation counts and cross-references found in review.

**Resolution (documentation only):** corrected five remaining descriptions:
Profiles distinguishes its public lookup query from feed pagination and ranges,
explicitly orders `publicKey` before `challenge`, and names the Relationship
Intent wire field `namespaceId`. Resources now says both operations rather than
three. Core's Profile retention link now names Section 7, matching its target.
The public/exact Profile distinction and Recognize's optional-field wording
were already correct and were left unchanged. Route parsing and parameter
schemas required no changes; no compatibility aliases were introduced.
Incomplete path examples remain in F11's separate example audit.

**Verification:** conformance package PASS; protocol documentation, resource
request parsing, and S2S controller tests passed (three suites, 55 tests).
`git diff --check` passed.

**Acceptance:** document one exact parameter set/order and conditional-field
policy per operation; missing/extra/duplicate parameters have matching tests.
Do not add compatibility aliases merely to accommodate stale prose.

### F11 — Complete HTTP and message examples

**Confirmed review findings:** the Transport feed-head example omits
`profileNamespaceFeedEndId` and its advertised body digest is incorrect; the
signature vector also contains the old one-field body. Some complete signed
request examples omit `S2S-Root-Key`. Several embedded message `content`
examples are not producer-canonical JCS; the P2P reply example uses a self-author
with null receipt coordinates.

**Resolution:** added the missing Profile Namespace Feed bound and regenerated
the feed-head digest, signature base, and signature from the public fixture
seed. Added root headers to Call, Media, Forward-bundle, and signature vectors;
Call now uses its deterministic vector's digest and signature. A new request
reproduction test also found and corrected a stale Forward-bundle signature.
Canonicalized IMAGE, CONTACT_CARD, and LINK embedded content. The P2P reply
example now explicitly represents a receipt with non-null origin coordinates.
Profile path-only examples are labeled as partial illustrations.

The offline validator now checks each signed vector's operation body against
the HTTP manifest's request schema, requires a canonical root header, and
reconstructs the signature base from the declared request. Regression tests
re-sign deliberately invalid body/base/header variants to ensure valid
cryptography cannot conceal these defects. Runtime behavior, database, and
consumer acceptance of noncanonical message content were not changed.

**Verification:** conformance PASS; standalone validator tests 21 passed;
example reproduction and protocol-document tests 20 passed; diff check clean.
The new example tests cover signed Transport/Call/Resource requests, selected
embedded producer content, and self-author receipt coordinates. Exhaustive
cross-artifact and bundle-hash review remains part of F12.

**Acceptance:** regenerate complete vectors from public fixture keys; validate
headers, body shape, digest, signature, embedded JCS, receipt invariants, and
bundle hashes. Keep consumer acceptance of valid noncanonical content separate
from the producer's canonical-output requirement. Clearly label partial or
illustrative snippets rather than presenting them as complete valid exchanges.

### F12 — Cross-artifact regression and final audit

**Current checkpoint:** see [final audit findings](./federation-contract-final-audit.md).
The former SRV compile blocker no longer reproduces: E2E typecheck passed,
and four targeted PostgreSQL suites passed (24 tests). Earlier blocker notes
above are historical. Six targeted unit suites passed (105 tests), as did
21 standalone validator tests and release conformance. The Recognize/Health
prose conflicts were resolved under the approved four-category and
reachability-only contracts. Bundle example digests were recomputed and
confirmed correct under JCS, with a new regression test pinning them.
Implementation findings (review/proposal matching, halted lookup, cooldown
cache safety) are recorded separately and remain open; F12's documentation
track is complete pending the operator's final review.

**Inspect:** [offline validator](../../tools/federation-conformance/conformance.ts),
[validator tests](../../tools/federation-conformance/conformance.test.mjs), all
`spec/v1/schema/` artifacts, and implementation protocol-document tests.

**Acceptance:** validation rejects a cryptographically valid vector whose
operation body is malformed, checks the decided response/status exceptions,
and covers complete examples without treating illustrative fragments as full
requests. Re-read all affected normative chapters together; update current
implementation docs and label superseded design records where necessary.
Account for every item in this ledger, including explicitly reclassified
findings. Do not claim runtime conformance from offline checks alone.

## Verification strategy

Verification is incremental per item, followed by a combined audit. Planned
commands from the repository root include:

```bash
npm test -- <affected-unit-spec-paths>
npm run test:e2e -- <affected-e2e-spec-paths>
npm run build:be
npm run federation:conformance
SOMFP_SPEC_DIR="$PWD/spec" npm test --prefix tools/federation-conformance
npm run typecheck --prefix tools/federation-conformance
```

Select exact test files after tracing the affected paths; add frontend/native
checks only where their behavior changes. E2E runs use the isolated database
configured by `test/global-setup.ts`; never substitute a development or
production database or run the reset-oriented federation lab as a default check.

[The implementation handoff](./federation-implementation-handoff.md) records a
prior operator-requested automated-test pause. Confirm its current scope before
running implementation suites; until then, add/update tests and report runtime
verification as pending. Device and browser acceptance remain separate.

Baseline evidence from the preceding text review: the offline command
`npm run conformance --prefix tools/federation-conformance -- --spec "$PWD/spec"`
returned `PASS`, despite the obsolete feed-head vector body and incorrect
printed HTTP example digest. This records a coverage gap, not completed
verification for any planned correction. No implementation suite was run while
creating this plan.

## Decision and completion records

Append a record for each item as work proceeds:

```text
Item:
Status:
Observed implementation and tests:
Agreed contract and rationale:
Affected files/layers (include explicit N/A):
Persistence, migration, and draft-wire compatibility:
Verification commands and actual results:
Open limitations / follow-up:
```

### F01 record

- **Status:** text and regression coverage aligned; targeted runtime tests passed.
- **Decision:** the operator approved stable subject namespaces across reviewed
  root rotation and required implementation-independent specification text.
- **Normative changes:** Recognition namespace disclosure, rotation approval,
  Health disclosure, and the rotation example now preserve the same namespace.
  Transport separates a replaceable root pin from subject identity. Profile
  Namespace Feed describes same-id binding replacement and namespace `0`
  publication without prescribing key-epoch storage or cache rows. Conformance
  lists the externally observable namespace-continuity checks.
- **Business-code inspection:** `FederationNamespaceAdminService.applyRootRotation`
  updates the existing `IdentityNamespace` and publishes its binding change in
  one transaction. `KeypairService.rotateRoot` separately changes the local key
  epoch and publishes namespace `0`. Recognition and Health disclose the
  receiver's existing namespace; subsequent requests retain the reverse
  coordinate. Binding resolution follows the same id. Feed consumers expire
  binding-cache entries rather than assigning successor subjects. Namespace
  preservation therefore requires no production-code rewrite.
- **Tests updated:** namespace-admin unit assertions cover exact feed namespace,
  unchanged reverse coordinate/feed cursors, and no publication on rejection.
  Root-rotation E2E assertions cover both peers' namespace coordinates, no extra
  namespace allocation, actual signed Recognize/Health responses, both namespace
  feed announcements, and current root resolution under the original ids.
  Returned wire objects are checked against the existing schemas.
- **Artifacts:** schema shapes, HTTP manifest, and JSON vectors need no change
  for this lifecycle-only correction. The normative rotation example and
  conformance checklist are updated. The broader F11 vector defects remain open.
- **Clients:** browser cache and Rust native namespace persistence use stable
  publisher/subject pairs with mutable bindings. No client wire shape, schema,
  or runtime change is needed for this correction; no device verification is
  claimed.
- **Persistence and compatibility:** no migration, data reset, message rewrite,
  or legacy fallback. This draft correction explicitly rejects the earlier
  contradictory successor-namespace interpretation; it does not claim
  compatibility with an implementation of that interpretation.
- **Verification:** `npm run federation:conformance` passed. Test-project static
  checking with `node_modules/.bin/tsc --noEmit --incremental false -p
  test/tsconfig.json` passed after the final assertion changes. Prettier checks
  on both changed F01 tests, `git diff --check`, and local documentation link
  target checks passed. Targeted unit, admin UI, and PostgreSQL E2E execution
  was subsequently authorized and passed; commands and counts follow below.
- **Related boundaries:** F01a records approved evidence preservation. F04 tracks
  continuity-proof enforcement and legal rotation admission; F09 tracks review
  idempotency. No claim of complete rotation or runtime conformance is made.

### Targeted runtime verification

The operator's continuation after the proposed validation step authorized the
following targeted tests, not a blanket resumption of unrelated suites:

- `npm test -- src/admin/federation-namespace-admin.service.spec.ts
  src/federation/signature.service.spec.ts`: **2 files, 40 tests passed**.
- `npm test --prefix admin-web -- src/api/federation.spec.ts
  src/routes/federation/peer-detail-page.spec.tsx`: **2 files, 9 tests passed**.
- `npm run test:e2e -- test/federation-root-approval.e2e-spec.ts
  test/federation-recognition-atomic.e2e-spec.ts
  test/federation-root-epoch-rotation.e2e-spec.ts`: **3 files, 20 tests passed**.
  The harness applied migrations to isolated run-specific databases and compiled
  its node entry before running. No application database reset was requested.

The passing E2E run covers concurrent review/domain/root/pin changes during a
successful sealed challenge, recognition commit behavior, the certificate-cutover
pin-retention regressions, and real dual-node rotation with same-namespace wire
responses. It does not cover simultaneous root rotation at both peers or all
missing/expired predecessor cases. Admin project-wide type checking remains
blocked as recorded above, despite the passing targeted runtime tests.

### F01a atomic-certificate follow-up verification

After preserving acceptance and removing automatic re-handshake, the first
root-rotation run failed on immediate Health (`unavailable`). An ordinary
request then also failed (`401`), disproving the assumption that its cache miss
would fetch successor certificates. Approval was corrected to install validated
certificates in its binding transaction, not merely delete obsolete keys.

- `npm test -- src/admin/federation-namespace-admin.service.spec.ts`:
  **19 tests passed** after the availability and certificate replacement changes.
- `npm run test:e2e -- test/federation-root-approval.e2e-spec.ts
  test/federation-root-epoch-rotation.e2e-spec.ts
  test/federation-domain-rebind.e2e-spec.ts`: **3 files, 15 tests passed** on the
  final run, including both transaction rollback injection points and immediate
  signed Health returning `available` before a new Recognize or ordinary request.
- Test-project TypeScript checking, Prettier checks on all changed implementation
  and test files, `git diff --check`, and `npm run federation:conformance` passed.

Protocol proof checks remain SHOULD; automatic verification is our stricter
local approval policy. No schema migration or new wire member was required.

The final state must align normative text, runtime business behavior, wire
artifacts, and verified tests. No unresolved decision is resolved merely by a
passing build, a matching schema, or the current reference implementation.
