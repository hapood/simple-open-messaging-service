# Federation Root Identity Model and Health Privacy (2025 redesign)

Status: `DESIGNED` — the normative changes live in `spec/v1/` (still `1.0.0-rc.0`,
destructive in-place edit; the protocol was never published). This document records
the threat-model reasoning, the wire decisions, and the clean target shape of the
implementation and database. It is documentation, not a normative reference.

## 1. What changed and why

### 1.1 Resolved gaps

| Gap (before) | Resolution (after) |
| --- | --- |
| Root identity could never change; recovery from a lost root required a destructive bilateral reset with every peer. | Well-known publishes a `roots` group with validity intervals; a root rotation is adopted per peer through a Recognize challenge/proof arrival and local administrator approval ([transport-security §1.5](../../spec/v1/transport-security.md), [recognition §4.5](../../spec/v1/recognition.md)). |
| Identity lookup for inbound requests keyed on the domain inside `keyId`; a domain is a mutable binding, not the identity. | Every signed request carries `S2S-Root-Key`; receivers resolve the namespace by the pinned root public key, and the domain is treated as a reviewable binding ([transport-security §3.3](../../spec/v1/transport-security.md)). |
| Health answered authentication failures with stable error envelopes (`400`/`401`), creating a distinguishable failure surface. | Health emits no error envelope: every authentication, resolution, and disclosure failure uniformly returns `200 unavailable`; only transport-level rate limiting may answer `503` ([recognition §9](../../spec/v1/recognition.md)). |
| A peer recognized only through inbound Recognize had no cached certificates, so its first Health failed `401` (the `S2SKeyCache` write-through gap). | The recognition commit itself MUST persist the sender's pinned-root-authorized certificate set ([recognition §5.2, step 6](../../spec/v1/recognition.md)); Health remains cache-only by design. |
| Root key fingerprints (`sha256:` digests of the root public key) existed as a local implementation concept with three duplicated builders. | Deleted everywhere. The root public key itself is the identity coordinate on the wire and in the database; nothing derives a digest. |

### 1.2 Security invariant of the rotation design

Appending a root to a well-known document requires only control of the publication
endpoint (DNS + TLS at the fetch instant), which is not identity evidence for an
established peer. Adopting a successor root therefore requires an Ed25519 signature
by the private key of the root **already pinned by the receiver**, over a
self-contained rotation claim (challenge, claimed root, domain, and the complete
published group). The receiver additionally requires the signed group to be
value-equal to the group it fetched, so an altered well-known in transit cannot
inject a different successor. Publication control alone can never produce this
proof; only possession of the pinned root's private key can.

### 1.3 Accepted residual risks (documented, not solved here)

- TOFU at first contact still trusts the fetched group at that instant (web PKI).
- A captured signed request remains replayable inside its ≤300 s signature window;
  Recognize idempotency limits the effect to disclosing `peerAssignedLocalNamespaceId`.
- Compromise of the root private key remains catastrophic and in-band undetectable;
  v1 has no root revocation or transparency. Operation-level mitigations (DB access
  control, backup encryption, monitoring own well-known changes) are deployment
  concerns.

## 2. Wire contract summary

- Discovery (`GET /.well-known/somfp`): `roots: [{ed25519, notBefore, notAfter}]`
  replaces the single `rootKey`; each signing certificate gains `root` (its
  authorizing root) and the certificate statement now includes `root`.
- Every signed request carries `S2S-Root-Key` (base64 Ed25519 public key), unsigned
  by the RFC 9421 base; it is a routing/binding hint authenticated transitively by
  the certificate chain and the pin.
- Recognize request: `{}` | `{namespaceId}` | `{rotationProof}` | both; the proof
  object is closed and self-contained, and its canonical statement is the object
  minus `signature` serialized in fixed field order (`challenge`, `claimedRoot`,
  `created`, `domain`, `roots`).
- Recognize `pending` result may carry a single-use `challenge` (32-byte base64url
  nonce, ≤300 s TTL).
- Health returns exactly `available | degraded | unavailable` and never an error
  envelope.
- New stable code: `50029 FEDERATION_ROOT_CHANGE_REJECTED` (409, fatal).

## 3. Target implementation and database shape

The implementation phase is a destructive rewrite of the federation identity core.
No compatibility shims, no dual reads, no fingerprints.

### 3.1 Local identity (our own keys)

- `LocalFederationRoot` (replaces `LocalFederationIdentity`): one row per root key —
  `domain`, `rootPublicKey`, `rootPrivateKey`, `notBefore`, `notAfter`, `createdAt`,
  `retiredAt`. Exactly one root is "claimable" (sent in `S2S-Root-Key`) at any
  instant; the predecessor stays for the per-peer acceptance window. Rotation of the
  local root is an operator-initiated administrative action.
- `LocalFederationSigningKey`: gains `root` (the authorizing root public key); the
  rotation lifecycle (prepublication, switch, retention) is unchanged otherwise.
- `LocalFederationSigningState`: unchanged semantics.

### 3.2 Peer identity (their keys)

- `IdentityNamespace`: the identity epoch table. **Drop `rootKeyFingerprint`.**
  `rootPublicKey` is the pin and the lookup key; add a unique partial index
  `ON IdentityNamespace (rootPublicKey) WHERE id > 0 AND active = true AND retiredAt
  IS NULL` (the wire already requires at most one unretired namespace per root).
  `domain` remains the reviewable binding.
- `S2SKeyCache`: gains `root` per cached certificate; PK stays `(namespaceId,
  keyId)`; written atomically at (a) every recognition commit — including inbound
  Recognize — and (b) every successful well-known refresh; rows whose authorizing
  root is absent from the fetched group are dropped with the replace.
- `FederationIdentityReview` (replaces `FederationNamespaceCandidate`): the single
  review queue for identity changes, `kind ∈ {'domain-rebind', 'root-rotation'}`,
  `nextDomain`, `claimedRoot`, `matchedNamespaceId`, `claim` (the verified proof
  statement and signature, JSONB), `status`, `decidedAt`, timestamps. Approval of a
  root rotation swaps `rootPublicKey` (and the domain binding carried by the same
  claim) in one transaction; rejection surfaces `FEDERATION_DOMAIN_CHANGE_REJECTED`
  / `FEDERATION_ROOT_CHANGE_REJECTED` on the next arrival.
- Rotation challenges are short-lived single-use records (table or TTL store):
  `namespaceId`, `nonce`, `expiresAt`, `consumedAt`.

### 3.3 Inbound authentication paths

- Ordinary guard: resolve namespace by `S2S-Root-Key` (not by domain); halted or
  missing ⇒ `401`; cert lookup from `S2SKeyCache` filtered by `root = pin`;
  fetch-on-miss refresh unchanged, now validating the group and keeping only
  pinned-root certificates.
- Health: resolve namespace by `S2S-Root-Key`; any miss or failure ⇒ `200
  unavailable` (no error envelope anywhere in the handler); never fetches
  well-known.
- Recognize: always live-fetches the group; resolution matrix of
  [recognition §4.4](../../spec/v1/recognition.md); rotation arrivals run the
  §4.5 challenge state machine.

### 3.4 Removals

- All three fingerprint builders (`keypair.service.ts`, `discovery.service.ts`,
  `federation-recognition.service.ts`), the `rootKeyFingerprint` column and its
  admin surface, and the fingerprint regex in the admin self-check.
- The `hasFederationHistory` TOFU guard keyed on `IdentityNamespace`/`S2SKeyCache`
  presence is re-derived for the new local-root table.

## 4. Phasing

1. Spec and schemas (this change set) — reviewable independently.
2. Local root/signing model + well-known publisher/validator for groups; DB
   migration (destructive; lab databases are reset, not migrated).
3. Inbound resolution by root key (guard, Health uniform `unavailable`,
   Recognize rewrite, challenge state machine, review queue).
4. Outbound: rotation sender lifecycle (keep claiming predecessor until
   `recognized`), certificate-set write-through on inbound recognition.
5. Tests: unit (proof verification, challenge single-use, uniform Health), e2e
   (two-node recognize/health, rotation approval round trip, injected-root
   rejection), federation lab smoke.

## 5. Open items

- Whether ordinary data-plane operations should also be resolvable when the
  sender claims a successor root whose rotation is still pending (currently: no —
  401 until approval; the sender keeps the predecessor).
- Whether to surface review-state differences to administrators beyond the
  existing admin console surfaces.
