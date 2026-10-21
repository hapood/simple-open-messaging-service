# Federation Root Identity Model and Health Privacy (2025 redesign, final)

> **Status update (Profile Namespace Feed):** the successor-epoch behavior
> recorded here — "Peer rotation: insert a new peer epoch row (new
> namespaceId), retire the predecessor" — is superseded by
> [`profile-namespace-feed.md`](./profile-namespace-feed.md). Namespace ids
> are now lifelong: an approved root change or domain re-bind updates the
> existing `IdentityNamespace` row in place, and the change is published on
> the Profile Namespace Feed. The review queue, arrival verification, and
> health privacy sections below remain current. The server's own root-epoch
> model is untouched: an own root replacement still appends a new claimable
> `LocalFederationRoot` epoch and disables the predecessor, and an own domain
> replacement still swaps the binding directly. The current root-rotation
> implementation announces its own change with a `namespaceId` `0` Profile
> Namespace Feed item. `POST /s2s/v1/verify` is now sealed-challenge
> only; the namespace-id to bindings resolution it used to carry inline lives
> on `GET /s2s/v1/profile-namespaces/:nsid`.

Status: historical redesign rationale with the supersession notes above. The current normative working package is the final-review draft under [spec/](../../spec/README.md); this record does not define its release status.
This document records the threat-model reasoning, the wire decisions, and the
target shape of the implementation and database. It is documentation, not a
normative reference.

## 1. What changed and why

| Gap (before)                                                                                                        | Resolution (after)                                                                                                                                                                                                                                                              |
| ------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Root identity could never change; recovery from a lost root required a destructive bilateral reset with every peer. | Well-known publishes a `roots` group; a rotation is adopted per peer through an ordinary Recognize arrival that resolves via the still-pinned root, plus administrator approval backed by a sealed-challenge predecessor-key check (transport-security §1.5, recognition §4.5). |
| Identity lookup keyed on the domain inside `keyId`; a domain is a mutable binding, not the identity.                | Every signed request carries `S2S-Root-Key`; receivers resolve the namespace by the pinned root public key, and the domain is a reviewable binding.                                                                                                                             |
| Health answered authentication failures with stable error envelopes.                                                | Health emits no error envelope: every failure uniformly returns `200 unavailable`; only transport-level rate limiting may answer `503`.                                                                                                                                         |
| A peer recognized only through inbound Recognize had no cached certificates.                                        | The recognition commit persists the sender's pinned-root-authorized certificate set (recognition §5.2 step 6).                                                                                                                                                                  |
| Root fingerprints existed as a local implementation concept with three duplicated builders.                         | Deleted everywhere. The root public key itself is the identity coordinate on the wire and in the database.                                                                                                                                                                      |
| Nothing could verify a peer's historical artifacts after rotation.                                                  | A stateless sealed-challenge service (`POST /s2s/v1/verify`) proves possession of any retained key — current or retired — and discloses namespace pins; the public profile lookup carries the same primitive inline.                                                            |

## 2. The one primitive: sealed challenges

Everything identity-related reduces to one construction (transport-security
§3.7): the caller seals a value of its own choosing under a public key
(Ed25519 keys converted to X25519, sealed-box format); the holder of the
private counterpart returns the recovered plaintext; the caller compares
with what it sealed. The value is opaque to the protocol, the server keeps
no state, and replay protection is the caller's fresh challenge.

- **Rotation review evidence**: the reviewer challenges the pinned
  predecessor root; only the party operating the peer's domain can open it.
- **Card authenticity**: `GET /s2s/v1/accounts/:account?publicKey=&challenge=`
  returns the card plus `proof` = recovered plaintext, so the card is bound
  to the holder of the named key, not merely to the current domain endpoint.
- **Generic verification and namespace identity** (`POST /s2s/v1/verify`):
  `{publicKey, encryptedValue}` → `{value}` or `FEDERATION_PUBLIC_KEY_UNRECOGNIZED`;
  `{namespaceId}` → `{root, domain}` or `NOT_FOUND` (0 = the responder's
  current root), enabling introducer corroboration and historical re-checks.

Usage discipline: the recovered value is never stored, derived from, or
reused — it is compared and discarded; only the outcome (which key, when,
opened or not) is recorded.

## 3. Rotation semantics (immediate cutoff)

1. The rotating server's administrator publishes the successor root in the
   group and, in the same publication, removes every
   predecessor-authorized certificate from `keys[]` — removal is the
   revocation channel (the common trigger is key compromise; serving both
   generations would ask peers to keep trusting a possibly leaked lineage).
2. All traffic switches to successor-authorized certificates; peers that
   have not yet adopted the successor root answer `401` until their
   administrator approves. The interruption is accepted by design.
3. A rotation arrival is an ordinary Recognize under the successor root:
   the recipient authenticates it against the fetched group, finds its
   pinned root still present, records one review fact (claimed root, group
   snapshot, arrival domain), and answers `pending`.
4. The reviewer opens a sealed challenge under the pinned predecessor root
   before approving. Approval retires the old identity epoch and begins a
   new one in a single commit: pin swapped, domain binding updated, new
   peer-assigned namespace allocated, recognition facts/cursors/mirrors/
   authorizations carried over. Rejection surfaces as operation-level
   `50029 FEDERATION_ROOT_CHANGE_REJECTED` — nothing is halted by the
   rejection itself.
5. The predecessor root entry (but no certificates) stays published until
   every recognized peer adopted the rotation; the retained private keys
   keep sealed challenges under retired keys openable forever.

Recognize itself is wire-unchanged: body `{}` or `{namespaceId}`, results
`pending | recognized | failed`.

## 4. Database target shape (implementation phase)

One identity table, local and peer rows alike:

- `IdentityNamespace`: `id` (= namespaceId; `0` is the reserved local
  marker, never a stored id), `kind ∈ {local, peer}`, `domain`,
  `rootPublicKey` (unique partial index over active unretired rows, both
  kinds), `rootPrivateKey` (local rows; retained for retired rows of both
  kinds — see key history), `rootNotBefore/rootNotAfter`, `claimable`
  (local rows; partial unique index forces exactly one true), peer
  lifecycle columns (`active`, `haltedAt`, `retiredAt`, bidirectional
  `recognizedAt`).
  - Local rotation: insert a new local epoch row and flip `claimable`.
  - Peer rotation: insert a new peer epoch row (new namespaceId), retire the
    old one; domain re-binding updates the same row's `domain`.
- `S2SKeyCache`: gains `root` per cached certificate; written atomically at
  every recognition commit (including inbound) and refresh; rows whose
  authorizing root left the fetched group are replaced with it.
- `FederationIdentityReview` (replaces `federationNamespaceCandidate`):
  `kind ∈ {domain-rebind, root-rotation}`, `nextDomain`, `claimedRoot`,
  `matchedNamespaceId`, `claim` JSONB snapshot, `status`, timestamps.
- Key history: retired rows are never deleted; private key material of
  retired roots stays available for sealed challenges.
- Removals: `rootKeyFingerprint` column, all three fingerprint builders,
  the fingerprint admin surface, any challenge/nonce tables (the service is
  stateless).

## 5. Residual risks (accepted, documented)

- First contact still trusts the fetched group at that instant (web PKI +
  SRV/TLS), as before.
- A captured signed request remains replayable inside its ≤300 s signature
  window; Recognize idempotency bounds the effect.
- A full domain takeover can still place a rotation into human review; the
  sealed-challenge check and out-of-band confirmation are the mitigations,
  and after approval of the genuine server's rotation the leaked
  predecessor becomes worthless.
- Sealed challenges prove "the party operating this domain holds the key",
  not "only they do" — after a leak both the owner and the attacker can
  open boxes, but only the owner can run the service on the domain.

## 6. Phasing

1. Spec, schemas, vectors, this document (done, reviewable).
2. Unified identity table + destructive migration; well-known group
   publisher/validator; key-history retention.
3. Inbound resolution by root key; uniform Health `unavailable`; Recognize
   rotation-arrival resolution and review queue.
4. Sealed-challenge service + account lookup challenge; admin console
   review flow with predecessor-key check; outbound rotation lifecycle.
5. Tests: unit (box open, unrecognized key, review transitions), e2e
   (two-node recognize/health/rotation round trip, card challenge), lab
   smoke.
