# Simple Open Messaging Federation Protocol v1 Peer Recognition

Status: `DRAFT` — Final Review (`v1.0.0-draft.0`)

Operations:

- `POST /s2s/v1/recognize`
- `GET /s2s/v1/health`

This document defines the directional semantics and bidirectional establishment timing of peer recognition, identity pinning, success confirmation, failure handling, and the privacy-preserving behavior of health queries. [Simple Open Messaging Federation Protocol v1](./protocol.md) defines shared Federation types and response envelopes; [Transport and Security](./transport-security.md) defines HTTPS, discovery, key certificates, and HTTP Message Signatures; the [Stable Error Registry](./errors.md) defines error classification.

The key words `MUST`, `MUST NOT`, `SHOULD`, `SHOULD NOT`, and `MAY` are to be interpreted as described in RFC 2119 and RFC 8174.

## 1. Core semantics

The protocol meaning of `A → B Recognize` is:

> A has validated and recognized B's current Federation identity through B's HTTPS well-known document and asks B to recognize A and prepare to receive A's traffic.

The sole protocol meaning of B returning `recognized` is:

> B has authenticated A, recognized A's pinned identity, and prepared to receive A's Federation traffic.

Recognize is a prompt notification, not an indispensable proof channel or
business-authorization grant. Section 3 defines the recognition and reachability
facts required for traffic; Section 9 defines Health as an alternative source
of peer-acceptance evidence. Neither operation exchanges feed cursors or
initializes business mirrors.

Recognize is also the arrival operation for domain re-binding. A server whose
public domain has changed calls Recognize, signed from the new domain, on
peers that still hold its pinned root identity. The recipient resolves the
signer by root identity rather than by domain alone and discloses the
namespace it holds for the caller. Sections 4.4–4.6 define arrival validation,
implementation-selected adoption policy, and results.

## 2. Operation overview

| Item                   | Recognize                                                | Health                                                                      |
| ---------------------- | -------------------------------------------------------- | --------------------------------------------------------------------------- |
| Method                 | `POST`                                                   | `GET`                                                                       |
| Path                   | `/s2s/v1/recognize`                                      | `/s2s/v1/health`                                                            |
| Query                  | None; signed `@query` is `?`                             | None; signed `@query` is `?`                                                |
| Request                | Closed empty object or sender-assigned local namespace   | Zero-byte body                                                              |
| Request auth           | bootstrap signed                                         | status signed                                                               |
| Success                | HTTP `200`, success envelope with `RecognizeResult` data | HTTP `200`, success envelope with `HealthResult` data                       |
| Idempotency coordinate | `(signerRootKey, recipientDomain)`                       | No new identity may be pinned by the query                                  |
| State effect           | Commits local recognition and receive readiness          | A positive result confirms responder acceptance and may update reachability |

Both operations carry the `S2S-Root-Key` header required by [Transport and Security, Section 3.3](./transport-security.md#33-signed-request-headers); it names the root the sender claims and signs under, and never enters the signature base.

```ts
type EmptyRequest = Record<string, never>;

/** The positive namespace the sender allocated for the recipient's
    identity; preserved across accepted root and domain changes. */
interface SenderAssignedLocalNamespaceRequest {
  namespaceId: PositiveSafeInteger;
}

type RecognizeRequest = EmptyRequest | SenderAssignedLocalNamespaceRequest;

/** The data member of the common success envelope. */
type RecognizeResult =
  | {
      status: 'pending';
      message?: string;
    }
  | {
      status: 'recognized';
      peerAssignedLocalNamespaceId: PositiveSafeInteger;
    };
```

The objects listed here are closed. Every listed field is required unless marked
optional; duplicate and unknown fields are forbidden. Recognize returns these
result objects inside the common success envelope (`code: 0`, diagnostic
`message`, and `data`) defined in Core Section 7.2. Every failure uses the common
error envelope, not an additional Recognize result variant. Health returns the
same success envelope with the `HealthResult` data defined in Section 9.

The request member `namespaceId` carries the sender-assigned local namespace:
the positive namespace the sender allocated for the recipient's identity.
The recipient retains it as the `peerAssignedLocalNamespaceId` for the sender
and uses it to recognize its own subjects in the sender's traffic; it is never
a namespace in the recipient's own namespace space.

`peerAssignedLocalNamespaceId` is the positive namespace the responder
allocated for the caller's identity. The responder MUST use exactly this value
as the wire `namespaceId` whenever it serializes the caller's own subjects.
The caller retains it per recipient: it identifies the caller's local
identities as mirrored by the responder
([protocol.md Section 6.2.1](./protocol.md#621-publisher-scoped-namespace-interpretation))
and selects receipt and self-subject processing there. Both disclosed namespace
values MUST remain unchanged across an accepted root rotation or
domain re-binding. A new root key does not create a new subject namespace.
Only destructive identity reset retires the existing namespace; recognition
after that retirement MUST allocate a fresh namespace and MUST NOT reuse the
retired value.

`RecognizeResult.status` distinguishes the recognition attempt outcome.
`recognized` is the only success result that carries peer-acceptance evidence
and discloses `peerAssignedLocalNamespaceId`. `pending` means the responder
has accepted the attempt for asynchronous validation or local review,
including a rotation or re-binding arrival awaiting a local adoption decision.
A `pending` result MUST
NOT include `peerAssignedLocalNamespaceId`, carries no identity or acceptance
evidence, and the caller MUST NOT begin ordinary traffic from it. A definitive
failure already known when answering uses the common error envelope under
Section 7's result categories and the registered stable `code`; `message` is
diagnostic only. Refusing a proposed binding change is an HTTP `200`
operation-level error result, not peer-acceptance evidence and not a
relationship halt.

## 3. Recognition and reachability state model

These are distinct protocol facts, regardless of how a node represents them
internally:

| Protocol fact        | Meaning                                                                                   | Valid evidence                                                                                                          |
| -------------------- | ----------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| Local recognition    | This node has validated and pinned the peer's root identity and prepared its receive path | A committed local recognition decision; never merely reading well-known                                                 |
| Peer acceptance      | The peer recognizes this node and is prepared to receive its Federation traffic           | The peer's valid Recognize `recognized` result, its valid Recognize request, or its valid Health `available`/`degraded` |
| Current reachability | Authenticated communication with the pinned peer is currently possible                    | A valid authenticated request, positive Health, Recognize `recognized`, or another definitive protocol response         |

The peer lifecycle is this closed abstract protocol model. Its labels state only
whether communication with the peer may continue automatically and do not
require an implementation to store one same-named enum or to duplicate every
failure cause as a lifecycle value:

| State          | Exact definition                                                                                                                                                           |
| -------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `unrecognized` | No usable pinned/recognition identity exists.                                                                                                                              |
| `establishing` | Local recognition and receive-path preparation have committed, but peer acceptance has not yet been proven. Identity validation before that commit remains `unrecognized`. |
| `pending`      | Validation or local admission policy has not yet produced peer acceptance. This state cannot authorize ordinary traffic and is not peer-acceptance evidence.                 |
| `available`    | Local recognition and peer acceptance are both proven, and current authenticated reachability exists without unresolved transport degradation.                             |
| `degraded`     | Local recognition and peer acceptance are both proven, but current reachability is absent or a retryable transport or service failure occurred.                            |
| `halted`       | Verifiable hard-failure evidence exists; automatic Recognize, Health retries, and data-plane communication stop pending local administrator action.                        |

Recognize delivery is not a separate admission condition. Both nodes being
`degraded` means each has locally recognized the other and has evidence of the
other's acceptance; restoring authenticated reachability can make ordinary
traffic possible without repeating recognition.

A node MUST retain outside the lifecycle the original evidence and reason causing `halted`, such as a stable HTTP error from the target peer, a local policy block, pinned-root contradiction, or absence of a common version. Each cause retains its distinct wire error and security meaning but is not a lifecycle state. A node MAY retain diagnostic text for `pending`, but the text has no wire semantics. An implementation MUST NOT persist Health's `unavailable` result as a same-named lifecycle state.

Health's privacy projection is distinct from this bilateral lifecycle; its
response and consumption rules are defined in Section 9. An ordinary operation
MUST NOT authorize solely from a lifecycle label. Admission also requires valid
identity, version, policy, and business authorization.

Local `available` is calculated as:

```text
available =
  local recognition and prepared receive path
  AND peer acceptance
  AND current authenticated reachability
  AND pinned identity is valid
  AND a common protocol version remains selected
  AND local policy permits federation traffic
  AND no unresolved transport degradation remains
```

```mermaid
stateDiagram-v2
    [*] --> unrecognized
    unrecognized --> establishing: pin, recognize, and prepare local path
    establishing --> pending: validation or local decision outstanding
    pending --> degraded: peer acceptance without current reachability
    pending --> available: peer acceptance with current reachability
    pending --> halted: fatal authenticated conflict
    establishing --> available: peer acceptance and current reachability
    establishing --> degraded: peer acceptance without current reachability
    degraded --> available: authenticated reachability recovers
    available --> degraded: Health unavailable / transient failure
    establishing --> establishing: notification or Health still inconclusive
    unrecognized --> halted: local policy hard stop
    establishing --> halted: verifiable hard failure
    available --> halted: verifiable hard failure
    degraded --> halted: verifiable hard failure
```

Externally observable transitions MUST be equivalent to this table. A node
MUST make each fact change and resulting admission decision externally
indivisible; an intermediate state cannot authorize traffic.

| Event                                                                          | Prior state                               | Protocol effect                                                                                                                                                                                                             | Next state                                                         |
| ------------------------------------------------------------------------------ | ----------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------ |
| Commit local recognition and receive-path preparation                          | `unrecognized`                            | Pin and recognize the peer; acceptance remains unknown                                                                                                                                                                      | `establishing`                                                     |
| Accept Recognize for asynchronous validation                                   | Any non-`halted`                          | No identity, namespace, reachability, or acceptance evidence is disclosed                                                                                                                                                   | Existing state, or `pending` when review is required               |
| Process a valid inbound Recognize to `recognized`                              | Any non-`halted`                          | Recognize the signer locally and accept its explicit recognition of the recipient                                                                                                                                           | `available` when reachability is current                           |
| Receive valid Recognize `recognized` or positive Health                        | `establishing` / `degraded` / `available` | Accept the peer's recognition and receive-readiness assertion; refresh reachability                                                                                                                                         | `available`                                                        |
| Health returns `unavailable`, or the Health response is invalid or unreachable | `establishing` / `available` / `degraded` | Retain recognition evidence; mark reachability absent                                                                                                                                                                       | `establishing` if peer acceptance is unknown, otherwise `degraded` |
| Outbound Health receives any non-`200` or malformed response                        | `establishing` / `available` / `degraded` | Retain pins and acceptance evidence; mark reachability absent; adopt no acceptance assertion or fatal identity evidence from the response | `establishing` if peer acceptance is unknown, otherwise `degraded` |
| Authenticated protocol communication succeeds                                  | `establishing` / `available` / `degraded` | Refresh reachability without creating acceptance evidence                                                                                                                                                                   | `establishing` if acceptance is unknown, otherwise `available`     |
| Network failure, timeout, or HTTP `503`                                        | `establishing` / `available` / `degraded` | Retain pins and acceptance evidence; mark reachability absent                                                                                                                                                               | `establishing` if acceptance is unknown, otherwise `degraded`      |
| Verifiable hard-security or policy failure                                     | Any non-`halted`                          | Retain the original security evidence and stop automatic communication                                                                                                                                                      | `halted`                                                           |

Outside Health, only an HTTP `409` carrying a fatal code in the Stable Error Registry from the target peer of this request, over the same hostname-verified TLS connection and authority, or a locally validated hard pinned-root, version, or policy conflict MAY trigger `halted`. An unauthenticated proxy response, TLS or connection failure, timeout, HTTP `503`, malformed response, or Health `unavailable` MUST NOT trigger `halted`; those failures preserve acceptance evidence and affect only reachability.

After entering `halted`, the protocol defines no automatic recovery path or administration, approval, reset, or recovery interface. When and how to leave `halted` is local administration. Before explicit administrator action, an implementation MUST NOT automatically retry Recognize or Health, resume the data plane, or replace the root pin. Health projects `halted` and every cause of it uniformly as `unavailable`.

Operation gates are calculated separately from lifecycle:

| Operation class                                     | Required gate                                                                                                                                                                                                                                                              |
| --------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `recognize`                                         | bootstrap signed and its admission rule; no existing lifecycle required                                                                                                                                                                                                    |
| `health`                                            | status signed; authentication and privacy projection follow Section 9.1; no error-envelope or transport-level rate-limit response exception is defined                                                                                        |
| `feed-heads`                                        | The recipient's local recognition and prepared lightweight receive path, with a valid signer identity                                                                                                                                                                      |
| Ordinary recognized data sent by the local node     | Local recognition and prepared path, peer acceptance proven by valid Recognize `recognized`, inbound Recognize, or positive Health, current authenticated reachability without unresolved degradation, compatible version and policy, and operation-specific authorization |
| Ordinary recognized data received from the peer     | The recipient's local recognition and prepared path, valid signer identity, compatible version and policy, and operation-specific authorization; the sender's earlier Recognize delivery is not a separate receive gate                                                    |
| Termination convergence for an existing active call | Existing binding and tombstone rules in calls.md; health-cache degradation alone cannot block it                                                                                                                                                                           |

Sending Recognize, reading well-known, or merely validating a request signature MUST NOT create peer-acceptance evidence. A connected network socket is not a recognition fact. A transient disconnect MUST NOT delete an identity pin or acceptance evidence, although it MAY change current availability from `available` to `degraded`.

After Recognize is sent, a timeout, DNS/TLS/connect failure, interrupted
response, or retryable server failure retains local recognition and any
previously proven peer acceptance. With acceptance still unknown, the peer
remains `establishing`; with acceptance proven, it is `degraded` until
reachability recovers. Uncertain delivery does not itself prove acceptance.

Ordinary feed, call, user, media, and forward-bundle operations use the
`recognized signed` context from protocol.md. A sender MUST have local
recognition, peer acceptance, and current reachability. A receiver uses its
own local recognition decision and valid signer identity; it MUST NOT require
the requester's earlier Recognize notification before accepting otherwise
authorized traffic. A valid authenticated request refreshes reachability but
does not by itself prove peer acceptance to its recipient.

Local receive readiness is distinct from lifecycle `available`: the former
means this server can receive from a locally recognized signer; the latter
additionally requires peer acceptance and current reachability for its own
ordinary outbound traffic.

## 4. Identity verification, recognition, and pinning

### 4.1 The initiator recognizes the recipient

Before sending Recognize to peer domain `B`, A MUST:

1. Locate B using the SRV, TLS, and authority rules in [Transport and Security, Section 2](./transport-security.md#2-network-discovery-transport-and-signature-security).
2. Fetch B's `/.well-known/somfp` over HTTPS with successful hostname verification.
3. Select the highest common major version and require the selected version to be `1`, matching the request path.
4. Strictly decode every `roots[].ed25519` to exactly 32 bytes, require the group to contain at least one currently valid root, and identify B's root to be pinned or the already pinned root. Selection of B's root is distinct from A's outbound `S2S-Root-Key` header.
5. Validate at least one currently valid signing-key certificate for B authorized by that root under [Transport and Security, Section 1.3](./transport-security.md#13-root-authorized-signing-key-certificate).
6. Atomically pin B's root public key, make the local recognition decision, and prepare the local receive path before constructing and sending the HTTP request. If B's acceptance is not yet proven, the committed lifecycle is `establishing`; an already accepted peer retains its `available` or `degraded` lifecycle according to current reachability.

The A-to-B request MUST carry A's root in `S2S-Root-Key`: the root authorizing
A's request-signing certificate. It MUST NOT carry B's root merely because B is
the recipient. B validates this claim against A's certificate and well-known
document under Section 4.2. A's selection of B's pin neither selects nor changes
A's own signing root.

Successfully reading well-known alone does not constitute recognition. The caller MAY send Recognize only after completing these checks and making the local recognition decision. For an already pinned peer, the newly read group MUST still contain the pin byte for byte; a rotation of B's root is completed only through the flow of Section 4.5, never by A re-pinning on its own.

Step 6 is the mandatory commit boundary for the initiator. Local recognition,
receive readiness, and the `establishing` state remain valid even if the subsequent
operation times out, the connection resets, or the server returns HTTP `503`.
Only a hard rejection or security failure defined in Section 8 can make this
recognition unavailable. An implementation MUST NOT misclassify ordinary
network uncertainty as rejection or identity loss.

### 4.2 The recipient validates the recognition claim

After receiving A's Recognize request, B MUST satisfy the following checks.
These are recognition-specific requirements, not an alternative validation
order; [Transport and Security, Section 3.5](./transport-security.md#35-validation-order-and-failure-boundaries)
governs request validation:

- Extract canonical signer domain A from the HTTP Message Signature `keyid`, and A's claimed root from the `S2S-Root-Key` header.
- Require the body to be one of the two closed shapes of Section 5.1: the empty JSON object `{}` or the sender-assigned local namespace.
- Accept the attempt into the recognition verifier, or reject before entry using the common error envelope when the request is malformed, locally rate-limited, or cannot be queued.
- Before producing `recognized`, use A's hostname-verified HTTPS well-known document to validate A's root group, certificate, and request signature; the claimed root MUST byte-equal a currently valid `roots` entry and MUST authorize the request's certificate.
- If a root pin or prior authenticated record exists for A, resolve the signer by root identity under Section 4.4 before allocating any new peer or namespace.
- Apply local admission policy and verify that B currently permits establishing this peer.

B MAY return `pending` immediately after accepting the attempt into the
verifier; at that point B may not yet have validated A's well-known document,
request signature, root continuity, the sender-assigned local namespace, or admission policy. A
`pending` result therefore proves none of those facts and carries no namespace.
Validating A's well-known document and the request's HTTP signature proves
that the request was signed with A's currently authorized Federation signing
key under A's claimed root. B's subsequent atomic pinning,
policy decision, and receive-path preparation establish B's local recognition
of A. A learns that B accepts A only from B's valid `recognized` result, B's
Recognize, or B's valid `available` or `degraded` Health result.

### 4.3 Root and signing-key continuity

Every root public key — in `roots`, in `keys[].root`, in `S2S-Root-Key`, and in a sealed challenge — MUST be strictly decoded as RFC 4648 padded base64. Non-canonical base64, invalid padding, and trailing data MUST be rejected, and the result MUST be exactly 32 bytes. When first recognizing the signer, the recipient MUST atomically store the claimed root with that recognition decision; the pin is one root public key, never the whole group.

On every later well-known read of an established peer, the pinned root MUST remain present in the fetched `roots` group byte for byte, and the receiver MUST keep authenticating requests only against certificates authorized by the pinned root. A group that no longer contains the pin is an identity contradiction, not rotation: the node MUST retain the old pin, record the identity-contradiction reason, enter `halted`, revoke `available`, and reject the ordinary data plane. The sole exception is a root rotation accepted under Sections 4.5 and 4.6. Normal addition, overlap, expiration, and removal of root-authorized signing certificates MUST NOT clear recognition or acceptance evidence.

### 4.4 Root-identity resolution, domain re-binding, and rotation arrivals

A recipient MUST resolve a Recognize signer by root identity before creating
any new peer record or namespace. The claimed root obtained from
`S2S-Root-Key` and validated against the signer's fetched well-known group
under Section 4.1 rules is compared byte-for-byte with every pinned,
unretired root. A receiver MUST hold at most one unretired namespace per root
key, so the match is unique whenever it exists. The resolution outcomes are:

- No pinned root matches the claimed root and the signer domain is unknown:
  ordinary first recognition under Section 4.2; the recipient allocates the
  peer-assigned namespace and discloses it in the response.
- No pinned root matches the claimed root, and the fetched group also does
  not contain any pinned, unretired root of this signer domain: identity
  mismatch under Section 8.
- No pinned root matches the claimed root, but the fetched group contains a
  currently valid root `R` that matches a pinned, unretired namespace of this
  signer: a root rotation arrival; resolve it under Section 4.5 before any
  other outcome. The Recognize interface itself is unchanged by rotation:
  the body remains one of the two closed shapes and carries no
  rotation-specific member.
- The claimed root matches the pinned root and the match is bound to the
  signer domain: ordinary idempotent re-recognition; the disclosed
  `peerAssignedLocalNamespaceId` is the matched namespace's id.
- The claimed root matches the pinned root, and the unique match `N` is bound
  to a different domain: a domain re-binding arrival.

A domain re-binding does not require a new root or signing key. The sender MAY
reuse its key material and certificate validity intervals, publishing `keyId`
values under the new domain with recomputed root authorization signatures as
defined in Transport and Security, Section 1.3. A receiver MUST NOT require the
signing public key to differ from the old-domain certificate. A valid certificate
under the new domain does not bypass the following binding checks or the local
adoption decision.

For a domain re-binding arrival, the recipient MUST additionally:

1. Rely on the hostname-verified well-known fetch already performed for
   signature validation as the proof of control over the new domain.
2. When the request carries the `namespaceId` member, require it to equal
   the `peerAssignedLocalNamespaceId` recorded on the matched namespace —
   the sender-assigned local namespace that identity disclosed for the
   recipient before the domain change. A conflicting value is an identity
   contradiction: the caller presents the pinned key together with a
   relationship coordinate inconsistent with the one it assigned before, and
   the recipient fails closed with `FEDERATION_IDENTITY_MISMATCH`. An absent
   value is not an identity failure. A caller MUST include
   the member whenever its local store has allocated a namespace for the
   recipient.
3. Reject with `FEDERATION_DOMAIN_CONFLICT` when the signer domain is bound to
   another peer or reserved for another peer's pending proposal.
4. Apply the adoption and result rules in Section 4.6.

A domain re-binding arrival proves three facts together: possession of the
pinned root-authorized signing key, control of the new domain's discovery
endpoint, and — when the `namespaceId` member is present — retention of the
stable sender-assigned local namespace. Key possession without the well-known
fetch does not establish domain control; domain control without the key
cannot match a pin.

### 4.5 Root rotation arrival

A root rotation arrival is a Recognize whose claimed root is not pinned,
while the fetched well-known group still contains the currently valid pinned
root of the same signer. Publication of the successor root alone establishes
nothing (Transport and Security, Section 1.5), and the Recognize interface
carries no rotation-specific member: continuity is judged from what the
arrival already presents — a request authenticated under a
successor-root-authorized certificate that the hostname-verified well-known
fetch validates, and a fetched group that still contains the root the
recipient has pinned.

The recipient MUST validate a rotation arrival as follows:

1. Authenticate the request under the bootstrap rules: the claimed successor
   root MUST be a currently valid entry of the fetched group, and the signing
   certificate MUST be authorized by it and valid.
2. Match the fetched group against the local pins: exactly one pinned,
   unretired root of the matched namespace MUST appear in the group as a
   currently valid entry. No match is an identity mismatch under the rules
   above, not a rotation.
3. Apply the namespace-consistency and domain-conflict checks of Section 4.4,
   then the adoption and result rules in Section 4.6.

A signer with no pinned identity follows ordinary first recognition under
Section 4.2 rather than rotation.

A validated rotation arrival proves control of a successor-authorized signing
key and publication of a group containing the predecessor public key at the
hostname-verified domain. It does not prove possession of the predecessor
private key. Additional continuity evidence is a local adoption-policy choice;
Section 12 provides a sealed-challenge operation if the implementation uses it.

### 4.6 Identity-change adoption and results

Adoption policy is implementation-defined. A receiver MAY accept, defer, or
reject a validated domain re-binding or root rotation proposal according to
local policy. The protocol does not prescribe decision procedures, additional
evidence, review records, refusal retention, or retry scheduling. This policy
freedom does not waive the authentication and binding checks above.

For each Recognize response:

- When validation or a local adoption decision is outstanding, the receiver
  MUST return `pending`, without a
  namespace or new acceptance evidence. Until adoption, the receiver MUST
  retain the existing binding and MUST NOT authorize ordinary traffic under
  the proposed binding. Ordinary requests claiming an unadopted successor root
  fail authentication with HTTP `401`.
- Acceptance MUST atomically update the domain binding and, for rotation, the
  root pin before returning `recognized` under Section 5.2. The receiver MUST
  preserve the subject namespace, both disclosed namespace values, recognition
  and peer-acceptance facts, cursors, mirrors, and authorizations. It MUST NOT
  require a new reciprocal handshake solely because the binding changed.
  It MUST publish the changed bindings for that namespace through the Profile
  Namespace Feed; the changing publisher uses namespace `0` in its own feed.
- Rejection MUST use `FEDERATION_DOMAIN_CHANGE_REJECTED` or
  `FEDERATION_ROOT_CHANGE_REJECTED`, respectively, in the common HTTP `200`
  error envelope. The rejection MUST NOT replace the existing binding, create
  acceptance evidence, or by itself enter `halted`.

A repeated request MUST NOT duplicate adoption effects. These rules do not
create a rejection-notification endpoint or a required polling mechanism.

## 5. Recognize request and successful commit

### 5.1 Request body

For a request from A to B, the exact application body bytes used by the fixed vector below are:

```text
{}
```

The body is one of two closed objects: the empty object for a sender whose
local store has not allocated a namespace for the recipient; the
sender-assigned local namespace

```text
{"namespaceId":7}
```

carrying the namespace id A allocated for B's identity. An accepted root
rotation or domain re-binding MUST NOT change this value.
The Recognize body carries no rotation-specific member: a sender that has
rotated its root sends the same two shapes, claims and signs under the
successor root, and the recipient resolves the rotation arrival under
Section 4.5.

A MUST include the `namespaceId` member whenever its local store holds such an
allocation; B validates it under Section 4.4 when present and MUST NOT treat
its absence alone as an identity failure. The signer domain is
established by the validated `keyid`, the recipient domain by the signed
`@authority`, the protocol version by `/s2s/v1`, and the claimed root by the
`S2S-Root-Key` header; the body repeats none of them.

The recipient adopts a first-time disclosure by storing it as the
`peerAssignedLocalNamespaceId` for the sender; it MUST NOT substitute a
namespace id of its own store when the member is absent.

The request MUST be constructed in the common order defined in
[Transport and Security, Section 3](./transport-security.md#3-request-construction-overview):
final JSON UTF-8 bytes, `Content-Digest`, `Date` and signature parameters,
RFC 9421 signature base, then Ed25519 `Signature`. The protocol does not generally require compact serialization for JSON objects, but the digest and signature MUST cover the exact bytes sent. The body MUST NOT be serialized again after signing.

### 5.2 Recipient commit boundary and recognition result

After all validation and policy checks succeed, B MUST atomically complete the following before returning a response:

1. Pin or verify A's root identity.
2. Apply B's local admission policy and commit `recognizesPeer(A)`.
3. Prepare B's receive path and commit `localServiceAvailable`.
4. Accept A's explicit recognition of B in this request.
5. Prepare B's lightweight receive path.
6. Persist A's currently published certificate set authorized by the pinned root as A's local certificate state, in the same indivisible commit. This persisted set is the only key material a subsequent inbound Health from A may authenticate against, because inbound Health authentication MUST NOT initiate well-known discovery.
7. Treat the authenticated request as current reachability evidence and set B's peer lifecycle to `available`.

These steps apply only to a `recognized` result. A `pending` result MUST NOT
execute them before responding; a domain re-binding arrival (Section 4.4) or
an unadopted root rotation arrival (Section 4.5) MUST NOT disclose the
peer-assigned namespace or create acceptance evidence before adoption under
Section 4.6.

The first bootstrap Recognize establishes B's local recognition of A and A's
recognition of B together. B therefore has both recognition decisions and
current reachability in the same externally indivisible commit. A later
duplicate MUST NOT reset the first recognition time or business state.

After a successful commit, return the closed `recognized` variant of
`RecognizeResult`. The formatted JSON below is a complete valid response;
whitespace and line breaks have no application semantics:

```http
HTTP/1.1 200 OK
Content-Type: application/json

{
  "code": 0,
  "message": "successful",
  "data": {
    "status": "recognized",
    "peerAssignedLocalNamespaceId": 7
  }
}
```

Requester A MUST parse B's response body as `application/json` and validate the
common envelope. For a successful response, `data` MUST be one of the exact
closed `RecognizeResult` variants in Section 2. For `recognized`, its members
are exactly `status` (`recognized`) and `peerAssignedLocalNamespaceId` (a
`PositiveSafeInteger`). For `pending`, they are exactly `status` (`pending`) and
optional diagnostic `message`; `peerAssignedLocalNamespaceId` MUST NOT appear.
Non-zero `code` uses the common error envelope and MUST NOT provide acceptance
evidence. The `ok` member, a `failed` data variant, and the former bare result
objects are not valid responses. A missing or mistyped required member, an
unknown extra member, `[true]`, an empty body, and trailing non-whitespace data
are invalid. An implementation MUST NOT determine success
from the raw UTF-8 bytes, whitespace, or object-member layout.

B MUST NOT return `recognized` before making all required effects durably
recoverable as one externally indivisible commit. A may adopt B's acceptance
evidence only after receiving HTTP `200`, strictly validating the
`recognized` response shape above, and confirming that the response came from
the same TLS connection and authority as the request. A `pending` result adopts
no acceptance and exposes no namespace. It permits a later Recognize to obtain
an updated result; identity-change retry policy remains local under Section 4.6. A non-zero error result adopts no acceptance and is classified by its
HTTP status and stable `code`. A timeout or a network error cannot substitute for acceptance evidence,
but a later valid positive Health result can. A peer with acceptance still
unknown remains `establishing` and may retry recognition.

The response does not use an additional detached signature. Hostname-verified
HTTPS authenticates the responder, while B's indivisible durable commit and the
fixed response semantics confirm B's acceptance of A.

### 5.3 Optional reverse notification

B MAY send `B → A Recognize` as a prompt reverse notification after returning
the first `recognized` result, but MUST NOT wait for it before responding. Its
absence or lost response is not a separate admission failure. The first request
and `recognized` result already give both peers the reciprocal acceptance
evidence needed for ordinary traffic, subject to current reachability and
business authorization. Health can provide the same acceptance evidence after
an uncertain response. Notification timing after identity-change adoption is a
local policy choice.

## 6. Complete sequence

```mermaid
sequenceDiagram
    participant A as Peer A
    participant B as Peer B

    A->>B: GET /.well-known/somfp
    B-->>A: B versions, root group, signing certificates
    Note over A: Pin and recognize B; prepare receive path<br/>status = establishing
    A->>B: POST /s2s/v1/recognize {}
    Note over B: Authenticate A; pin and recognize A<br/>A's request asserts A recognizes B<br/>status = available
    B-->>A: 200 {code: 0, message: "successful", data: {status: "recognized", peerAssignedLocalNamespaceId: 7}}
    Note over A: recognized proves B accepts A<br/>status = available
    Note over A,B: Ordinary signed traffic may start<br/>subject to authorization
```

B MAY reuse A's validated well-known document for an optional reverse request.
B MUST NOT wait for reverse Recognize before returning the first `recognized`
result, because two symmetric implementations could otherwise wait for each
other.

### 6.1 Recovery after a lost first `recognized` result

```mermaid
sequenceDiagram
    participant A as Peer A
    participant B as Peer B

    A->>B: Recognize A → B
    Note over B: Recognize A and prepare receive path<br/>A's notification proves A recognizes B
    B--xA: 200 recognized lost or timed out
    Note over A: B acceptance still unknown<br/>status = establishing
    A->>B: Authenticated Health
    B-->>A: 200 {status: available | degraded, peerAssignedLocalNamespaceId: 7}
    Note over A: Positive Health proves B accepts A<br/>status = available; no Recognize retry needed
```

If A's first request never reached B, B does not initiate reverse Recognize
because of that request. If B has not independently recognized A, Health
returns `unavailable`; A remains `establishing` and MAY retry Recognize with
bounded backoff. If both parties independently initiate Recognize, the same
recognition decisions converge without requiring two `recognized` responses.

## 7. Retries, duplicates, and concurrency

The application-level idempotency coordinate for Recognize is `(signerRootKey, recipientDomain)`; no nonce is required. The short HTTP-signature time window limits replay of old requests, while operation idempotency prevents replays within that window from duplicating recognition side effects.

- First `pending`: accept the attempt for asynchronous validation or review without creating acceptance evidence or disclosing a namespace.
- First `recognized`: commit local recognition, receive readiness, and the requester's explicit recognition assertion before returning the result.
- Duplicate request with the same root identity: MUST NOT reset the first-recognition time, cursor, mirror, or application authorization; return the current `pending`, `recognized`, or definitive error result for that attempt.
- Identity-change arrival duplicates follow Section 4.6 without resetting prior recognition facts.
- Same domain with a different root: MUST NOT replace the pin merely because
  the domain matches. A valid rotation arrival under Section 4.5 is subject to the local adoption
  decision; arrivals that do not satisfy that exception MUST fail as an identity
  mismatch.
- Concurrent Recognize and Health: MAY commit independently. A valid `recognized` result and a valid positive Health result are equivalent peer-acceptance evidence; the final recognition and reachability state MUST equal a valid serial ordering.
- Lost response: retain facts already committed by the recipient. The sender MAY obtain peer acceptance through positive Health or safely retry Recognize while acceptance remains unknown.

Recognize has exactly four result categories. The recipient MUST answer
immediately, without waiting for asynchronous verification.

1. **Recognized** — the recipient durably commits reciprocal recognition;
   later arrivals for the same idempotency coordinate read the committed
   result without re-executing side effects.
2. **Pending** — verification or review is outstanding; no acceptance or
   rejection has been established.
3. **Cooled refusal** — an HTTP `200` non-zero-code result declining the
   current recognition attempt without halting the relationship. It is not
   permanent; retry and cooldown policies are implementation choices.
4. **Irrecoverable error** — HTTP `409` with a registered fatal code. The
   relationship is durably halted; the sender stops and escalates to its
   administration.

Verification and review policies — cooldown windows, arrival coalescing,
retention, re-verification timing, and network-failure handling — are
implementations' choices and are not observable protocol obligations beyond
the categories above.

Each HTTP retry uses the same JSON application semantics but MUST regenerate `Date`, `created`, `expires`, and the HTTP signature. The body contains neither time nor nonce, so its bytes and `Content-Digest` MAY remain unchanged across retries.

Rotation arrivals fail closed on ordinary authentication errors without halting the peer: they are one attempt's outcome, not an identity contradiction.

## 8. Pending, failed, and error handling

In this section, A is the Recognize requester and B is the recipient. B validates the request, commits or rejects reciprocal recognition, and generates the HTTP response. A may adopt B's acceptance only from a validated response or independently verified evidence.

### 8.1 Recipient B: validation, local state, and response

B answers immediately from the recognition result currently available,
without waiting for network verification or a local adoption decision. Incomplete
verification or an outstanding decision yields `pending`. B MUST commit the effects in
Section 5.2 before disclosing `recognized`. A known refusal or irrecoverable
error uses the corresponding category in Section 7 and the common error
envelope. Background completion does not change a response already sent.

The table below maps known outcomes to their wire results. A malformed
request is rejected with `400 FEDERATION_MALFORMED` before it can be treated
as a recognition attempt. Infrastructure failures are not additional
Recognize result categories.

| Condition observed by B                                                   | HTTP | Stable code                               | B's local action                                                                                                                                                                    |
| ------------------------------------------------------------------------- | ---: | ----------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Malformed JSON, header, or type                                           |  400 | `FEDERATION_MALFORMED`                    | Do not commit new recognition effects                                                                                                                                               |
| Path version disabled or no common version                                |  409 | `FEDERATION_PROTOCOL_VERSION_UNSUPPORTED` | Record the version reason and enter `halted`; do not commit a new fact                                                                                                              |
| Signature or published-key verification fails                             |  200 | `FEDERATION_BAD_SIGNATURE`                | Do not commit recognition effects; deliver the definitive refusal as the cooled-refusal result of Section 7; do not replace a root pin merely because signature verification failed |
| Recognize body is not one of the two closed shapes of Section 5.1         |  400 | `FEDERATION_MALFORMED`                    | Reject the malformed request without committing recognition effects                                                                                                                 |
| Local policy blocks A                                                     |  409 | `FEDERATION_PEER_BLOCKED`                 | Record the policy reason and enter `halted`; do not commit a new fact                                                                                                               |
| A root obtained through hostname-verified HTTPS differs from its old pin  |  409 | `FEDERATION_IDENTITY_MISMATCH`            | Retain the old pin, record an identity contradiction, and enter `halted`                                                                                                            |
| A is already halted for an identity contradiction                         |  409 | `FEDERATION_IDENTITY_MISMATCH`            | Remain `halted`                                                                                                                                                                     |
| Arrival sender-assigned local namespace conflicts with the recorded value |  409 | `FEDERATION_IDENTITY_MISMATCH`            | Retain the pin, record the identity contradiction, and enter `halted`                                                                                                               |
| Arrival signer domain bound to or pending on another peer                 |  200 | `FEDERATION_DOMAIN_CONFLICT`              | Record no re-binding; retain all pins, recognition, and lifecycle                                                                                                                   |
| Local policy rejected the domain re-binding proposal            |  200 | `FEDERATION_DOMAIN_CHANGE_REJECTED`       | Retain the current binding, namespace, and acceptance; retry and refusal-retention policy are implementation choices                                                           |
| Local policy rejected the root rotation proposal         |  200 | `FEDERATION_ROOT_CHANGE_REJECTED`         | Retain the current pin, namespace, acceptance, and lifecycle; retry and refusal-retention policy are implementation choices                                                    |

When returning any error envelope, B MUST NOT create
acceptance evidence or open the lightweight gate because of this request.
Facts committed by an earlier successful idempotent request are not rolled back
by a later failure. HTTP signature failure alone is not evidence that the root
identity changed. Only a root independently obtained through hostname-verified
HTTPS that conflicts with the existing pin MAY trigger identity mismatch.
Normal rotation of signing certificates authorized by the same pinned root is
not identity mismatch.

### 8.2 Requester A: consuming the response and updating local state

A has committed local recognition and is `establishing` if B's acceptance is not yet known. A MUST NOT infer that B accepted A merely because Recognize was sent. A MUST handle the result as follows:

| Result observed by A                                                  | Recognition and reachability effect                                                   | Required action                                                                                                            |
| --------------------------------------------------------------------- | ------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| HTTP `200` with valid `status: 'recognized'`                          | Adopt B's acceptance and current reachability; become `available` if other gates hold | Ordinary traffic may begin subject to authorization                                                                        |
| Timeout, DNS/connect failure, TLS interruption, or truncated response | Acceptance remains unknown unless already proven; reachability is absent              | Retain the pin; obtain a positive Health result or retry Recognize with backoff                                            |
| HTTP `503`                                                            | Same as a retryable transport failure                                                 | Retain the pin and back off                                                                                                |
| HTTP `200` with valid `status: 'pending'`                             | Do not adopt acceptance, reachability, or namespace evidence                          | Adopt no new traffic grant; if retrying, use bounded backoff. Identity-change scheduling follows Section 4.6.                                                  |
| HTTP `200` with a valid non-zero common error envelope                | Do not adopt acceptance; classify as an operation error, not HTTP `409` halt evidence | Apply the registered code's operation-level rule; an unknown code fails only this operation                                |
| HTTP `200` + `FEDERATION_DOMAIN_CONFLICT` (`50027`)                   | Retain pins and the current binding                                                   | Stop re-binding attempts for that domain; local administration decides                                                     |
| HTTP `200` + `FEDERATION_DOMAIN_CHANGE_REJECTED` (`50028`)            | Retain the current binding, namespace, and acceptance                                 | Whether and when to retry the rejected proposal are implementation choices.                                   |
| HTTP `200` + `FEDERATION_ROOT_CHANGE_REJECTED` (`50029`)              | Retain the current pin, namespace, acceptance, and lifecycle                          | Whether and when to retry the rejected proposal are implementation choices. |
| HTTP `200` with an invalid body                                       | Do not adopt acceptance from this response                                            | Record a protocol-response error; do not retry tightly                                                                     |
| Malformed, bad signature, or binding violation                        | Retain pin and previously proven acceptance                                           | Stop identical automatic retries until corrected                                                                           |
| HTTP `409` + `FEDERATION_PROTOCOL_VERSION_UNSUPPORTED`                | `halted`; retain version reason                                                       | Stop automatic communication; do not downgrade                                                                             |
| HTTP `409` + `FEDERATION_PEER_BLOCKED`                                | `halted`; retain remote-blocked reason                                                | Stop automatic communication                                                                                               |
| HTTP `409` + `FEDERATION_IDENTITY_MISMATCH`                           | `halted`; retain old pin                                                              | Fail closed and stop automatic communication                                                                               |
| A directly verifies that B's root differs from its pin                | `halted`; retain independent security evidence                                        | Do not treat the contradiction as a network error                                                                          |

An authenticated HTTP error response does not always trigger `halted`; it MUST be classified by stable code. `FEDERATION_MALFORMED`, `FEDERATION_BAD_SIGNATURE`, `FEDERATION_BINDING_VIOLATION`, `RATE_LIMITED`, and generic `INTERNAL` reject or delay only the current request and do not independently halt the peer; on Recognize, a definitive signature or published-key failure is delivered as the HTTP `200` cooled-refusal result, never as an authenticated-route `401`. `FEDERATION_DOMAIN_CONFLICT`, `FEDERATION_DOMAIN_CHANGE_REJECTED`, and `FEDERATION_ROOT_CHANGE_REJECTED` are HTTP `200` operation-level results: each refuses only the proposed binding change, preserves the existing relationship's pins, namespace, acceptance, and lifecycle, without prescribing the retry policy for that proposal. Only HTTP `409` with a registered fatal code, plus a pinned-root conflict directly verified by A, triggers `halted`. Identity-change adoption and result handling follow Section 4.6. An unparseable proxy body, TLS or connection failure, timeout, or HTTP `503` MUST NOT trigger `halted`. For an unknown HTTP status or a status/code conflict, A MUST follow the classification rules in the [Stable Error Registry](./errors.md#http-layer), but MUST NOT replace or delete a root pin without an identity contradiction.

### 8.3 Lost responses and recognition convergence

See [Section 6.1](#61-recovery-after-a-lost-first-recognized-result) for the lost
response sequence and recovery paths. Uncertain delivery follows the
recognition-preserving lifecycle rules in Section 3.

### 8.4 Blocklist

An implementation MAY allow an administrator to add a canonical peer domain to
a local blocklist. The blocklist MUST be checked before committing a new inbound
Recognize. On a match, return HTTP `409` with `FEDERATION_PEER_BLOCKED` and MUST
NOT create acceptance evidence, open the lightweight receive gate, or expose
service availability.

An initiator receiving this explicit error MUST record a remote-blocked reason, enter `halted`, and stop all automatic communication. Health still returns the uniform `unavailable` projection for a peer halted by blocking and MUST NOT expose the reason. The local administrator determines whether and how to remove the block; that decision is outside the Federation v1 wire protocol.

A complete blocklist rejection response is:

```http
HTTP/1.1 409 Conflict
Content-Type: application/json

{"code":50009,"message":"peer blocked","data":null}
```

`message` is diagnostic only. The caller MUST identify the explicit rejection by `code`, not by text. Temporary discovery failure is not identity loss and MUST NOT erase a pin or acceptance evidence. Verification and retry policy remain implementation choices under Section 7.

## 9. Health query and privacy

Health returns the common success envelope with this closed `data` union:

```ts
type HealthResult =
  | {
      status: 'available' | 'degraded';
      peerAssignedLocalNamespaceId: PositiveSafeInteger;
    }
  | {
      status: 'unavailable';
    };
```

All listed fields are required; unknown fields are forbidden. `unavailable`
carries no namespace. The namespace in either positive result has the meaning
defined in Section 2.

Health queries the reachability and privacy-safe status of a known peer; it is not an application keepalive. Trigger timing, initial delay, cadence, and stopping conditions are local concerns. Automatic queries SHOULD use bounded, jittered backoff and MUST NOT create tight polling or traffic amplification.

When A queries B, its Health request has no query and exactly zero body bytes. It MUST NOT send
`Content-Type`; `Content-Digest` is the fixed digest of the empty byte string.
The authenticated `keyid` identifies signer A directly. A successful response
MUST include `Cache-Control: no-store`.

### 9.1 Recipient B: validating the request and producing the privacy projection

B MUST authenticate the request under the cache-only Health rules in
[Transport and Security, Section 3.5](./transport-security.md#35-validation-order-and-failure-boundaries).
Authentication failure returns the uniform `unavailable` response below. After
successful authentication, B applies the readiness and privacy checks in this
section. Health MUST NOT establish first recognition or replace the root pin.

B MUST return exactly one of the following closed objects:

```json
{
  "code": 0,
  "message": "successful",
  "data": { "status": "available", "peerAssignedLocalNamespaceId": 7 }
}
```

```json
{
  "code": 0,
  "message": "successful",
  "data": { "status": "degraded", "peerAssignedLocalNamespaceId": 7 }
}
```

```json
{ "code": 0, "message": "successful", "data": { "status": "unavailable" } }
```

These are success-envelope responses: `code: 0` reports that the status query
was answered and discloses nothing about why the peer is not available.
Health MUST NOT emit an error envelope.

Only when the request validates against A's identity pinned and locally
recognized by B, B's ordinary and lightweight receive paths are prepared,
and query authorization is valid, MAY B return `available` or `degraded`. The response projects B's
readiness to receive A and B's reachability observation at request admission;
it does not require B to have already received A's reciprocal acceptance:

- Return `available` when B is prepared to receive from A and has current authenticated reachability evidence for A.
- Return `degraded` when B is prepared to receive from A but current reachability was absent at admission. The authenticated Health request itself may refresh B's reachability after this projection is captured.
- Both results prove B recognizes A's pinned identity and is prepared to receive A's traffic, including lightweight hints. A MUST consume either as peer-acceptance evidence equivalent to B's Recognize `recognized` result.

The `peerAssignedLocalNamespaceId` disclosure is the same value B's Recognize
response carries for A: the namespace B allocated for A's identity.
An accepted root rotation or domain re-binding MUST NOT change that value in
either response. A positive Health result refreshes A's retained disclosure;
it does not itself authorize namespace retirement, replacement, or identity
reset.

The following cases MUST uniformly return HTTP `200` with `{"status":"unavailable"}`:

- The authenticated signer is not locally recognized by B, or B has not prepared the receive path for that identity.
- The requester lacks query authorization, or B has placed the peer in `halted` for any reason.
- A reset is in progress, or another identity or version state cannot safely be disclosed.
- Any other local connection state that cannot safely be disclosed.

For authentication failures and all cases above, the recipient MUST return the
same unavailable object and MUST NOT disclose the specific reason through HTTP
status, error code, additional fields, or diagnostics. Implementations SHOULD
minimize obvious response-timing differences and MUST rate-limit by source,
domain, and globally without changing this response contract.

This `unavailable` result is only an external privacy projection; it does not erase B's handling of the actual local cause. For example, if B confirms a root conflict using independent hostname-verified HTTPS evidence, B still MUST retain the old pin, record the reason, and enter `halted`, while returning `200 unavailable` to A's Health query.

### 9.2 Requester A: consuming a Health result

| Result observed by A                                                    | Protocol action A MUST take                                                                                                                                                                         |
| ----------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Valid `available` or `degraded`                                         | Adopt B's acceptance and prepared receive path, refresh reachability and the retained `peerAssignedLocalNamespaceId`, and become `available` if local recognition, version, and policy remain valid |
| Valid `unavailable`                                                     | Treat current reachability as absent; retain pins and acceptance evidence. Remain `establishing` if acceptance is unknown, otherwise become or remain `degraded`                                    |
| Timeout, network error, HTTP `503`, invalid body, or any other response | Treat reachability like `unavailable`; adopt no assertion from the response                                                                                                                         |

A MUST NOT infer B's actual reason from `unavailable`, nor enter `halted`
solely because of that result. A non-`200` or malformed response is not a Health
result; its unavailable-like classification, including the prohibition on
halting for a fatal code returned to Health, follows the
[Stable Error Registry](./errors.md#shared-validation-failure-mapping).
A later Health retry requires a newly constructed request; a failed signed
request MUST NOT be retried unchanged after its signature window has passed. Refreshing A's copy
of B's well-known does not directly refresh B's copy of A's signing keys.
B's copy of A's signing keys is maintained by the certificate set persisted
at recognition time (Section 5.2), by B's outbound Health overlap refresh,
and by other ordinary discovery refreshes; B does not initiate well-known
discovery while authenticating A's inbound Health request. `halted` requires
either an authenticated, non-automatically-recoverable HTTP error from the
target peer as defined in Section 8 or hard security evidence independently
verified by A.

### 9.3 Other reachability evidence and convergence optimization

In addition to Health, every request whose signer is successfully authenticated
against a pinned, locally recognized, and receive-ready peer MUST serve as fresh
evidence of `remoteServiceReachable`, regardless of whether later shape or
operation-specific business authorization succeeds. Recognize, Health,
`feed-heads`, and ordinary operations all qualify. A first bootstrap Recognize
qualifies atomically once its identity validation, pinning, recognition
decision, and receive-path preparation succeed. A validated success or
definitive application response to
a locally initiated request also supplies reachability evidence. An
unauthenticated request, malformed or unverifiable response, network error, or
`5xx` provides no such evidence. This general reachability rule alone MUST NOT
invent peer acceptance. The positive Health assertion defined in Section 9.2
is the explicit acceptance path; ordinary authenticated communication supplies
reachability alone.

Existing valid acceptance and reachability evidence requires no additional
Health call. Recovery after a lost Recognize response follows Section 6.1.

## 10. Complete HTTP construction examples

The following vectors use the public test signing private key `ICEiIyQlJicoKSorLC0uLzAxMjM0NTY3ODk6Ozw9Pj8=`, which MUST NEVER be deployed as a production secret. Its Ed25519 public key is `Kay64UG8yvCyLhqU000LxzYeUm0L/hLIl5S8kyKWbdc=`. The public test root private key `AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8=` produces the root `A6EHv/POEL4dcN0Y50vAmWfk1jCbpQ1fHdyGZBJVMbg=`; the rotation example additionally uses the public test root private key `QEFCQ0RFRkdISUpLTE1OT1BRUlNUVVZXWFlaW1xdXl8=` producing `JUO5L/EJVRFHatyDadtt3JM2ZaEZeN2hQE7hBmypVZ0=`. The corresponding `a.example` well-known v1 view before a rotation is:

```json
{
  "protocolVersions": [1],
  "roots": [
    {
      "ed25519": "A6EHv/POEL4dcN0Y50vAmWfk1jCbpQ1fHdyGZBJVMbg=",
      "notBefore": 1699990000000,
      "notAfter": 1899990000000
    }
  ],
  "keys": [
    {
      "keyId": "a.example/key-1",
      "ed25519": "Kay64UG8yvCyLhqU000LxzYeUm0L/hLIl5S8kyKWbdc=",
      "root": "A6EHv/POEL4dcN0Y50vAmWfk1jCbpQ1fHdyGZBJVMbg=",
      "notBefore": 1699990000000,
      "notAfter": 1899990000000,
      "authorizationSignature": "xyJJS+reShl4dW0H10b0KXCD40MuXk9L9fsuwSU051gU2ldnijgi7jVbqF5e+759z4cUY3BG+864jdV/DIsJAw=="
    }
  ]
}
```

The exact certificate statement covered by `authorizationSignature` is defined in Section 1.3 of [Transport and Security](./transport-security.md). The root group, certificate, and signature above jointly validate the root-to-signing-key authorization chain.

### 10.1 Recognize

```http
POST /s2s/v1/recognize HTTP/1.1
Host: b.example
Content-Type: application/json
Date: Tue, 14 Nov 2023 22:13:20 GMT
S2S-Root-Key: A6EHv/POEL4dcN0Y50vAmWfk1jCbpQ1fHdyGZBJVMbg=
Content-Digest: sha-256=:RBNvo1WzZ4oRRq0W9+hknpT7T8If536DEMBg9hyq/4o=:
Signature-Input: sig1=("@method" "@path" "@query" "@authority" "date" "content-digest");created=1700000000;expires=1700000300;keyid="a.example/key-1";alg="ed25519"
Signature: sig1=:MOF5zofzJLLbgs7+YeV1dcKqDbyXOrOEgMMeTNU4Dob8dySVVT4uhIVxwvhMBOvsVEXZOgMrej4yjQw5QG3jCQ==:

{}
```

The signature base is:

```text
"@method": POST
"@path": /s2s/v1/recognize
"@query": ?
"@authority": b.example
"date": Tue, 14 Nov 2023 22:13:20 GMT
"content-digest": sha-256=:RBNvo1WzZ4oRRq0W9+hknpT7T8If536DEMBg9hyq/4o=:
"@signature-params": ("@method" "@path" "@query" "@authority" "date" "content-digest");created=1700000000;expires=1700000300;keyid="a.example/key-1";alg="ed25519"
```

The sender-assigned local namespace form signs its exact application bytes with the same construction; only `Content-Digest` and `Signature` differ:

```http
POST /s2s/v1/recognize HTTP/1.1
Host: b.example
Content-Type: application/json
Date: Tue, 14 Nov 2023 22:13:20 GMT
S2S-Root-Key: A6EHv/POEL4dcN0Y50vAmWfk1jCbpQ1fHdyGZBJVMbg=
Content-Digest: sha-256=:D2Dirv2ieU6TqH1QtCKAsLuuBEgc1On+avtIs6HDfFA=:
Signature-Input: sig1=("@method" "@path" "@query" "@authority" "date" "content-digest");created=1700000000;expires=1700000300;keyid="a.example/key-1";alg="ed25519"
Signature: sig1=:MuXuFcG0O0ZIkUtnSaawevEt4zjzgyosKBY2Jzko6ZGf98oeVS2GEDMoeVUlK6pMmbsVWbQgNh6tXh2x2azDBQ==:

{"namespaceId":7}
```

A successful ordinary response body is:

```json
{
  "code": 0,
  "message": "successful",
  "data": { "status": "recognized", "peerAssignedLocalNamespaceId": 7 }
}
```

A pending response body is:

```json
{
  "code": 0,
  "message": "successful",
  "data": { "status": "pending", "message": "verification in progress" }
}
```

A rotation arrival is an ordinary-shape Recognize under the successor root; its resolution (Section 4.5) is invisible on the wire. After the rotation switch the publisher keeps only successor-authorized certificates in `keys[]` — removing the predecessor-authorized certificates is the revocation channel — while the predecessor root entry stays in `roots` so peers can still resolve the chain to their pin. The publisher's group during the rotation transition is:

```json
{
  "protocolVersions": [1],
  "roots": [
    {
      "ed25519": "A6EHv/POEL4dcN0Y50vAmWfk1jCbpQ1fHdyGZBJVMbg=",
      "notBefore": 1699990000000,
      "notAfter": 1899990000000
    },
    {
      "ed25519": "JUO5L/EJVRFHatyDadtt3JM2ZaEZeN2hQE7hBmypVZ0=",
      "notBefore": 1699995000000,
      "notAfter": 1999990000000
    }
  ],
  "keys": [
    {
      "keyId": "a.example/key-2",
      "ed25519": "1CwF+0mIZPnj4dAFuy/aabG6Ro+sbcKMZQEoDqEG3oM=",
      "root": "JUO5L/EJVRFHatyDadtt3JM2ZaEZeN2hQE7hBmypVZ0=",
      "notBefore": 1699995000000,
      "notAfter": 1999990000000,
      "authorizationSignature": "eHQbhwHzj6WTsBFz3+DbHrCdX2bZZe2ZqtZGdShx95VehKEZ6J/Rddsi9WM6ZLXSDOOF1V/ewyV4WZzzAVWDCg=="
    }
  ]
}
```

The additional public test signing private key for `key-2` is the 32 ASCII bytes `SOMFP-TEST-SIGNING-KEY-2-PRIVATE`, which MUST NEVER be deployed as a production secret. A complete rotation-arrival Recognize claims and signs under the successor root with the ordinary empty body:

```http
POST /s2s/v1/recognize HTTP/1.1
Host: b.example
Content-Type: application/json
Date: Tue, 14 Nov 2023 22:13:20 GMT
S2S-Root-Key: JUO5L/EJVRFHatyDadtt3JM2ZaEZeN2hQE7hBmypVZ0=
Content-Digest: sha-256=:RBNvo1WzZ4oRRq0W9+hknpT7T8If536DEMBg9hyq/4o=:
Signature-Input: sig1=("@method" "@path" "@query" "@authority" "date" "content-digest");created=1700000000;expires=1700000300;keyid="a.example/key-2";alg="ed25519"
Signature: sig1=:s4ZNPXgRlXNeLtD9O+FZfjCPaYsUJrS/4Xp4ezUCztsjlYLBH7S6HvPJ7dUA8dmqlP7QzjMUVFebZvw/EGdKBw==:

{}
```

The recipient authenticates `key-2` against the fetched group, finds its pinned root `A6EHv/POEL4dcN0Y50vAmWfk1jCbpQ1fHdyGZBJVMbg=` still present in `roots`, defers adoption under its local policy, and answers:

```json
{
  "code": 0,
  "message": "successful",
  "data": { "status": "pending", "message": "root rotation decision pending" }
}
```

Ordinary traffic signed under `key-2` stays unauthenticated (HTTP `401`) until
the recipient adopts the rotation under Section 4.6. After adoption, Recognize
returns `recognized` with the unchanged `peerAssignedLocalNamespaceId`.

A domain re-binding rejected by local policy returns the operation-level
HTTP `200` error envelope:

```json
{
  "code": 50028,
  "message": "domain re-binding rejected"
}
```

### 10.2 Health

Health uses the empty-body digest and a method/path-specific signature:

```http
GET /s2s/v1/health HTTP/1.1
Host: b.example
Date: Tue, 14 Nov 2023 22:13:20 GMT
S2S-Root-Key: A6EHv/POEL4dcN0Y50vAmWfk1jCbpQ1fHdyGZBJVMbg=
Content-Digest: sha-256=:47DEQpj8HBSa+/TImW+5JCeuQeRkm5NMpJWZG3hSuFU=:
Signature-Input: sig1=("@method" "@path" "@query" "@authority" "date" "content-digest");created=1700000000;expires=1700000300;keyid="a.example/key-1";alg="ed25519"
Signature: sig1=:fuvhDBclzxrAtoUsntLajbLeWY/mNQdtUIczb5jMYtmbz4r5qQlepQAWuGFGoANj1rf7s7fzRvJrDK1HZRXbDg==:

```

## 11. Administrative boundary

Ordinary network failure, service restart, SRV change, or signing-key rotation under the same pinned root MUST NOT place a peer in `halted` and MUST NOT delete pins, recognition or acceptance evidence, cursors, mirrors, or authorizations.

Diagnosis, approval, recovery, reset, and re-recognition after `halted` are local administrative actions. Federation v1 defines no endpoint, interaction, or automation policy for them. The protocol safety floor is that communication MUST NOT resume automatically before explicit administrative handling, and a new root MUST NOT automatically inherit the old identity's recognition facts or application authorizations.

Normal identity-change adoption is distinct from recovery after `halted` or a
destructive reset. Section 4.6 defines its implementation-selected policy and
binding invariants; it does not require an administrative workflow.

## 12. Sealed-challenge verification service

`POST /s2s/v1/verify` is a stateless challenge-answering service every
server offers to its recognized peers: it proves whether the responder
still holds the private counterpart of a supplied public key by opening a
sealed challenge. Namespace-id to bindings resolution is not part of this
service; it lives on
[`GET /s2s/v1/profile-namespaces/:nsid`](./profile-namespace-feed.md#6-namespace-bindings-query).

The request body is one closed object:

```ts
interface SealedChallengeRequest {
  publicKey: Base64Ed25519Key; // a root or signing key of the responder, current or retired
  encryptedValue: Base64SealedChallenge; // sealed under that key
}

type VerifyRequest = SealedChallengeRequest;
```

For `SealedChallengeRequest` the responder looks the public key up in its
retained key history — every root and signing key it has ever published,
current or retired. An unknown key returns the error envelope with
`FEDERATION_PUBLIC_KEY_UNRECOGNIZED`. A known key opens the sealed box with
the corresponding retained private key and returns the recovered plaintext
bytes as canonical padded base64 in `value`, using the answer encoding of
[Transport and Security, Section 3.7](./transport-security.md#37-sealed-challenge-construction). The responder MUST treat the plaintext as opaque bytes: it MUST
NOT validate, interpret, or reject it by content, and encodes exactly the bytes
it recovered. A box that fails to open under the supplied key returns
`400 FEDERATION_MALFORMED`.

The caller controls the entire challenge semantics. It seals a value of its
own choosing — the protocol does not require any particular content; a
caller MAY bind the plaintext to the artifact it is verifying, for example
the canonical JSON `{"account":"<account>","domain":"<domain>"}` when
checking a profile card. The caller MUST be able to compare the returned
base64-decoded `value` byte-for-byte with what it sealed, SHOULD generate each challenge
fresh (never reusing a sealed value), and SHOULD discard the value after
comparing: the value has no downstream use, and only the comparison outcome
— which public key, when, opened or not — is worth recording. Because the
service is stateless, replay protection is the caller's fresh challenge,
not server memory.

The sealed-challenge success `data` is the closed object
`{ "value": string }`.

To keep the answer possible for retired keys, a server MUST retain every
root and signing key it has ever published — private key material included,
since sealed challenges under retired keys must stay openable forever.
Publication removal from well-known and internal retention are separate
acts (Transport and Security, Section 1.5). The service discloses nothing
about peers: it answers only from its own retained key history.

The sealed-box construction itself — key conversion and the exact
cryptographic format of `Base64SealedChallenge` — is defined in
[Transport and Security, Section 3.7](./transport-security.md#37-sealed-challenge-construction).
