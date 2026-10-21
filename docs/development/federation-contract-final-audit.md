# Federation contract alignment: final audit checkpoint

This is an implementation review, not a normative protocol document. The
original checkpoint and its findings are retained below as historical context.
The implementation remediation subsequently authorized by the operator is
summarized separately; test results do not establish runtime interoperability
certification or deployment readiness.

## Authorized implementation remediation

### Recognition and review matching

Committed recognition is checked before reviews, followed by halted and retired
identity checks. Retired roots are refused rather than silently admitted into a
new namespace. Proposal lookup includes the arrival domain/root and the current
origin binding, preventing a different proposal from inheriting an older result.
The administrator list computes `epochMatched` from live identity data; approval
revalidates the binding and review evidence in the decision transaction. Matching
is separate from the policy governing whether a halt may be cleared.

The former reset operation is named retire. It archives the namespace without
removing identity-derived history; the old reset routes are not retained.

### Identity discontinuity and verified conflicts

A verified arrival whose root group no longer publishes the pinned predecessor
halts the old epoch and atomically opens an `identity-reset` review. Repeated
arrivals can therefore return pending for an actual administrator decision:

- New peer: retire the old namespace; a subsequent verified handshake allocates
  a fresh namespace, isolated from historical relationships.
- Replace identity: explicitly replace the root within the existing namespace,
  without predecessor-key possession proof. This inherits existing relationships
  and requires independent administrator identity confirmation.
- Reject: retain the halted old epoch and return the proposal rejection result.

Replacement approval must not clear an independently imposed administrator block.
Other verified terminal arrival conflicts are stored in
`FederationIdentityConflict` and served only while their namespace snapshot
remains applicable. These records are separate from the review queue.

### Request-local signature failures and bounded verification

`BAD_SIGNATURE` refusals are keyed by a SHA-256 fingerprint of request evidence,
including signature headers and body, not merely the claimed domain/root/keyId.
Different evidence does not inherit a forged request's failure. Domain conflicts
are answered from verified persisted state, not a duplicate memory cache.

A separate canonical-client-IP map permits one background verification start per
IP per ten minutes. The controller uses Fastify's `req.ip`, under the existing
trusted-proxy configuration. Checking/reserving a slot is synchronous. Already
established results are read before this gate; gated arrivals return pending
without waiting for verification. Exact-evidence work is coalesced, and the
number of simultaneous verifiers is capped at 4096.

Both memory caches have a 4096-entry FIFO limit and ten-minute lifetimes. Expired
entries are removed on access/insertion and by an independent one-minute sweep.
Async completion checks ownership of the in-flight entry before publishing cache
results. Shared egress addresses share the verification budget; eviction and
process restarts release that budget. This is process-local best-effort load
control, not a strict distributed rate limit or comprehensive DoS protection.

### Verification and remaining acceptance boundaries

- Backend/admin federation unit suites: 812 tests passed across 83 files.
- Admin client tests: 67 passed.
- Three PostgreSQL suites: 30 passed (root approval, domain rebind, and atomic
  recognition), including identity-discontinuity decisions and live list matching.
- Backend `tsc --noEmit --incremental false -p tsconfig.json`: PASS after fixing
  the bundle-example test's untyped JSON callback.
- E2E `tsc --noEmit --incremental false -p test/tsconfig.json`: PASS.
- Published-example and protocol-document suites: 21 passed.
- Standalone conformance tests: 21 passed with `SOMFP_SPEC_DIR` configured;
  release-package validation: PASS.

Real browser/backend acceptance remains blocked: local lab edge port 3101 and
backend port 3201 did not respond during the follow-up preflight. Component tests
are not recorded as a substitute for this live acceptance check. No lab database
was reset and no migration checksum was rewritten to bypass this blocker.

Schema verification used fresh isolated test databases. The working baseline
contains the new review kind and conflict table; it is not an upgrade procedure
for an already-deployed database. Such a deployment needs a separately approved
forward migration; rewriting a deployed baseline or its ledger checksum is not
an acceptable upgrade. No deployment-readiness claim is made here.

## Historical verification at the original checkpoint

- `tsc --noEmit --incremental false -p test/tsconfig.json`: PASS. The previously
  reported SRV compilation blocker did not reproduce; no SRV files were edited.
- Four PostgreSQL E2E suites: 24 tests passed (root approval, root epoch rotation,
  domain rebind, and Profile wire contract).
- Six targeted unit suites: 105 tests passed (example reproduction, protocol
  documentation, challenge answers, recognition controller, recognition Health,
  and namespace administration).
- Standalone conformance validator: 21 tests passed; release validation PASS.
- `git diff --check`: PASS.

## Documentation findings addressed at this checkpoint

1. Recognition Section 7 requires immediate answers without waiting for
   asynchronous verification, but Section 8.1 still permits synchronous
   verification before answering. Section 8.1 and the later discovery-failure
   paragraph still prescribe HTTP 503 for asynchronous discovery failures.
   Transport Section 1.4 also includes Recognize in its generic discovery/401
   rule. These statements need to defer to the approved Recognize four-result
   model rather than prescribe verification policy.
2. Health's own consumption table treats every non-result as unavailable-like
   reachability failure. Errors and Transport now say non-200 handling is
   identical for every operation, which could wrongly import fatal 409
   classification into Health. Remove that ambiguity: an invalid Health result
   supplies no acceptance or fatal identity evidence. No responder-side
   infrastructure error enumeration is needed.
3. Recognition's cooled-refusal paragraph still mandates stopping automatic
   retries and lists implementation policy. Review this wording against the
   operator's decision that only result categories belong in the protocol and
   cooldown/retry strategy belongs in the implementation.

The documentation cleanup now removes the synchronous-wait alternative,
Recognize-specific infrastructure outcome rows, and mandatory cooled-refusal
retry/retention policies. Transport defers Recognize to its four result
categories. Health non-results explicitly affect reachability only, including
HTTP 409, and cannot supply fatal identity evidence. These edits implement the
previously approved contracts; they do not introduce runtime policies.

## Historical implementation findings (before remediation)

### Review lookup ignores the proposed root

`FederationRecognitionService.findReviewForDomain` selects the latest review
by next domain or current namespace domain, without matching `claimedRoot`.
`submitInboundRecognize` returns a pending/rejected review before checking
recognized or halted state. A different proposal at the same domain can
therefore receive an older proposal's result; a pending review can mask an
existing relationship result. This is an unresolved F09 matching concern,
not fixed merely by aligning the textual idempotency coordinate.

### Halted lookup misses successor-root arrivals

`verifyInboundRecognize` can halt an existing namespace when a verified
successor-root document no longer contains its old pin, retaining that old pin.
`assertInboundNotHalted` requires both domain and the incoming claimed root to
match the halted row. A retry still claiming the successor will miss the
old-root halted row and can repeat pending/verification rather than receive
the persisted fatal result. A safe correction needs explicit identity and
proposal matching, not an unconditional domain-only fatal response.

### Cooldown cache requires safety and resource-bound review

`inboundRecognizeRefusals` retains BAD_SIGNATURE by domain/root/keyId, all of
which can be claimed before authentication. A failed signature is a fact about
one request, not proof that every later request for that tuple will fail. A
forged arrival can populate a refusal consulted by a later valid request.
Before changing this policy, define which failures may be shared across
requests and how fresh authenticated evidence can bypass a stale refusal,
while preserving immediate response semantics.

The map deletes expired entries only when their exact key is visited again;
there is no size cap or independent expiry cleanup. TTL bounds reuse of an
answer, but does not bound retained memory for one-off keys. These are local
implementation concerns and must not expand the protocol's four categories.

## Bundle-hash verification at this checkpoint

The three published forward-bundle digests (minimal root, nested child, and the
Resources response example) were recomputed from their canonical bodies and
match the published values exactly; the nested child references and the
request-path digest are consistent. A new regression test recomputes every
published bundle example from its canonical body and compares it with the
published `id`, so a digest or body edit that breaks content addressing now
fails the suite. During this check an incorrect unsorted-key recomputation was
briefly applied and immediately caught by that test; the published digests were
restored unchanged.

## Historical follow-up scope

This scope statement applied to the original checkpoint, before the operator
subsequently authorized the remediation above.

Per operator confirmation, protocol closure and implementation remediation are
separate workstreams. The current scope is consistency among normative text,
schemas, examples, and vectors. No business-code or database changes are
approved by this audit checkpoint.

Review/proposal matching, halted-result lookup, and cooldown safety remain
independent implementation follow-ups. The cooldown cache introduced during
alignment is not security-complete; this scope separation does not close its
findings or establish runtime conformance. Future remediation should cover new
roots on the same domain, active relationships during review, old-pin halted
rows, forged versus valid attempts, and cache bounds.

Broader example/bundle-hash coverage remains part of protocol artifact review;
do not label the final protocol audit complete until that review is finished.
