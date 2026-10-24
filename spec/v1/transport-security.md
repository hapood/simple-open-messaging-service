# Simple Open Messaging Federation Protocol v1 Transport and Security

Status: `DRAFT` — Final Review (`v1.0.0-draft.1`)

This document defines the Federation v1 discovery document, root identity, signing-key certificates, network discovery, TLS, HTTP request targets, Content-Digest, and HTTP Message Signature profile. It is a normative component explicitly referenced by the [Simple Open Messaging Federation Protocol v1](./protocol.md). An operation document cannot weaken its identity, transport, or signature-security requirements.

The key words `MUST`, `MUST NOT`, `SHOULD`, `SHOULD NOT`, and `MAY` are to be interpreted as described in RFC 2119 and RFC 8174.

## 1. Well-known discovery and signing keys

### 1.1 Public discovery mode

`GET /.well-known/somfp` without a query is a public discovery request and does not use an HTTP Message Signature. A successful response MUST use `Content-Type: application/json` and return this bare JSON object:

```ts
interface RootKeyEntry {
  ed25519: Base64Ed25519Key;
  notBefore: EpochMilliseconds;
  notAfter: EpochMilliseconds;
}

interface DiscoveryDocumentV1View {
  software?: string;
  protocolVersions: number[];
  roots: RootKeyEntry[];
  keys: SigningKeyCertificate[];
}
```

The interface above is the view that MUST be validated after selecting v1; it does not restrict a cross-version well-known object to those fields. A node publishing `[1, 2]`, for example, MAY retain all shared v1 fields and add v2 fields. A v1 consumer ignores the additions, while a v2 consumer validates their presence and meaning under v2.

`software` is an optional, untrusted opaque diagnostic string. If present, its UTF-8 encoding MUST be 1–128 bytes and MUST NOT contain a Unicode control character. A consumer MUST NOT parse or depend on its format and MUST NOT use it for version negotiation, capability decisions, authentication, authorization, or implementation-specific behavior.

`protocolVersions` MUST follow [Core Protocol, Section 2](./protocol.md). `roots` is the server-identity anchor set: the root public keys that currently authorize this server's signing keys, together with each key's half-open validity interval. Within one document, `roots[].ed25519` values MUST NOT repeat, and at least one root MUST be currently valid when the response is generated. A root public key is not self-certifying; it is trusted only through the pinning rules in Section 1.2. Root keys and HTTP signing keys have distinct roles; equality of their public-key values MUST NOT be a protocol requirement.

`keys` MUST be a non-empty array and may contain old, current, and not-yet-active signing-key certificates simultaneously. `keyId` values MUST NOT repeat within one document, and at least one certificate MUST be valid when the response is generated. Each certificate names its authorizing root in `keys[].root`; that root MUST appear in `roots` with a validity interval enclosing the certificate's own interval.

| JSON key                         | Required | Role and example                                                                                                                                                                                                                      |
| -------------------------------- | -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `software`                       | No       | Untrusted diagnostic text such as `example-server/1.4.2`; never used for protocol decisions.                                                                                                                                          |
| `protocolVersions`               | Yes      | The complete set of fully supported majors, such as `[1, 2]`.                                                                                                                                                                         |
| `roots`                          | Yes      | The root identity anchor set: every root public key currently authorized to sign this server's signing-key certificates, with validity intervals; may overlap during a root rotation.                                                 |
| `roots[].ed25519`                | Yes      | An Ed25519 root public key, such as `A6EHv/POEL4dcN0Y50vAmWfk1jCbpQ1fHdyGZBJVMbg=`; a root does not directly sign ordinary HTTP requests.                                                                                             |
| `roots[].notBefore` / `notAfter` | Yes      | The half-open validity interval `[notBefore, notAfter)` in Unix epoch milliseconds during which this root may authorize certificates.                                                                                                 |
| `keys`                           | Yes      | Root-authorized signing-key certificates, permitting rotation overlap.                                                                                                                                                                |
| `keys[].keyId`                   | Yes      | A domain-bound certificate name such as `a.example/key-1`; neither a public key nor a secret.                                                                                                                                         |
| `keys[].ed25519`                 | Yes      | The online HTTP request-signing public key, such as `Kay64UG8yvCyLhqU000LxzYeUm0L/hLIl5S8kyKWbdc=`.                                                                                                                                   |
| `keys[].root`                    | Yes      | The base64 Ed25519 public key of the root authorizing this certificate; MUST byte-equal one `roots[].ed25519` entry.                                                                                                                  |
| `keys[].notBefore` / `notAfter`  | Yes      | The half-open validity interval `[notBefore, notAfter)` in Unix epoch milliseconds, enclosed by the authorizing root's interval.                                                                                                      |
| `keys[].authorizationSignature`  | Yes      | An Ed25519 signature by the authorizing root's private key over the Section 1.3 certificate statement. See [Peer Recognition, Section 10](./recognition.md#10-complete-http-construction-examples) for a complete verifiable example. |

A consumer selecting v1 MUST ignore well-known fields undefined by v1 and MUST NOT create v1 surface, authorization, or security branches from them. v1 does not publish runtime limits through well-known. Each operation's deterministic responses govern page, body, media, quota, group-capacity, and retention limits.

### 1.2 Root-key validation and pinning

A root public key cannot establish first trust through a self-signature. First trust comes from hostname-validated HTTPS. A root signature binds a rotatable signing key to that root, and an HTTP Message Signature proves possession of the signing private key. These purposes MUST NOT be conflated.

A receiver MUST pin exactly one root public key for a recognized peer at a time. At first recognition, this is the root the sender claims in `S2S-Root-Key` and under which the request's certificate is authorized (Section 3.3). The claimed root MUST byte-equal one currently valid entry of the sender's well-known `roots` group. The pin, not the whole group, is the local trust anchor. An approved rotation under Section 1.5 replaces this pin without replacing the peer's subject namespace.

[Federation v1 Peer Recognition, Section 4](./recognition.md#4-identity-verification-recognition-and-pinning) defines strict base64 handling, byte-for-byte root pinning, the first-Recognize validation order, domain binding, and the pin transaction. Successfully reading well-known alone MUST NOT establish recognition.

Subsequent validation of an established peer MUST use the local pinned root rather than treating a newly fetched root as a new trust anchor. On a well-known refresh of a recognized peer, the pinned root MUST remain present in the fetched `roots` group byte for byte, and the receiver MUST continue to authenticate requests only against certificates authorized by the pinned root until a rotation is accepted under Section 1.5. A fetched group that no longer contains the pin is an identity contradiction, not rotation: the peer MUST enter `halted`, record the identity-mismatch reason, and reject ordinary S2S operations — unless a root rotation is accepted through Recognize under Section 1.5.

Normal addition, overlap, expiration, and removal of signing certificates authorized by the pinned root MUST NOT clear recognition or acceptance evidence.

### 1.3 Root-authorized signing-key certificate

```ts
interface SigningKeyCertificate {
  keyId: KeyId;
  ed25519: Base64Ed25519Key;
  root: Base64Ed25519Key;
  notBefore: EpochMilliseconds;
  notAfter: EpochMilliseconds;
  authorizationSignature: Base64Ed25519Signature;
}
```

The domain in `keyId` MUST equal the publisher's server domain, and `notBefore < notAfter`. The certificate statement therefore does not repeat a `domain` field; its complete canonical `keyId` provides domain binding. `root` MUST byte-equal one `roots[].ed25519` entry of the same document, and the certificate's validity interval MUST be enclosed by that root's interval. A publisher MAY choose any unique `KeyName` satisfying the shared `KeyId` grammar; the name MUST NOT be interpreted as key age, rotation order, activation state, priority, or predecessor/successor relationship. Once published under one root identity, a `keyId` is permanently bound to the same `ed25519`. The publisher MUST NOT reuse it for another public key.

A domain re-binding is not a signing-key or root-key rotation. A publisher MAY retain the same root key, signing key, `KeyName`, and certificate validity interval when changing its domain. In that case it MUST construct `keyId` with the new domain and recompute `authorizationSignature` over the new statement. The underlying key material and validity interval remain unchanged; the domain-bound certificate representation changes. The same public key MAY therefore appear under different complete `keyId` values. This does not permit reassigning any previously published `keyId` to a different public key, including after changing back to an earlier domain.

`authorizationSignature` is an Ed25519 signature by the private key of the certificate's `root` over this canonical certificate statement. The statement is UTF-8 JSON with fixed field order and no extra whitespace. `notBefore` and `notAfter` use the JSON integer literals from the certificate:

```text
{"keyId":"<key-id>","ed25519":"<base64-key>","root":"<base64-root-key>","usage":"somfp-http-message-signature","notBefore":<epoch-ms>,"notAfter":<epoch-ms>}
```

The statement above is the exact signed input used by v1 to validate `authorizationSignature`. A later major MAY reuse this shared certificate core or add its own certificate fields, but MUST NOT change existing fields or the v1 meaning of `authorizationSignature`. If an added field affects key authorization, the new major MUST define a new independently verifiable signature field or structure. Well-known needs no separate `certificateVersion`; the selected Federation major determines the applicable requirements.

A consumer MUST validate `authorizationSignature` with the certificate's `root` public key, which MUST itself be a currently valid member of the discovery document's `roots` group — or, for an established peer, the pinned root. The certificate authorizes HTTP request signing and signature validation only while both its own interval and its authorizing root's interval satisfy `notBefore <= now < notAfter`. An expired or not-yet-active certificate or root MUST NOT be used to accept a request, although a consumer MAY cache one before activation. The consumer MUST evaluate these intervals using its current UTC wall clock and MUST NOT add an implicit clock-skew grace period before `notBefore` or after `notAfter`.

### 1.4 Signing-key rotation

A publisher performing signing-key rotation MUST publish the successor certificate in `keys` before using it for a request. The successor certificate MUST be currently valid before the first request signed with it, and the predecessor certificate MUST remain currently valid and published after that first successor-signed request until its `notAfter`, so that the receiver can validate the successor before it is used and can continue validating the predecessor after the switch. The publisher MUST NOT send a request with a key before `notBefore` or at or after `notAfter`, and MUST NOT remove a certificate from well-known before its `notAfter` — with two exceptions: when the certificate's authorizing root is rotated out under Section 1.5, its removal is the revocation channel; when the publisher changes its domain, it MAY replace old-domain certificate representations with new-domain representations under Section 1.3 before their `notAfter`. A domain-only replacement preserves the root, signing public key, `KeyName`, and validity interval of each replaced certificate. It does not require generating new keys or restarting their rotation lifecycle. Receivers still match complete `keyId` values exactly; an old-domain in-flight request is not rewritten or authenticated using a new-domain `keyId`. Adoption of the new domain remains subject to the Recognize binding checks and local adoption policy, not merely successful certificate verification.

For newly generated requests, a publisher MUST select exactly one signing key at any instant. During a normal rotation, it MUST use the predecessor before switching and the successor after switching. It MUST NOT alternate between the predecessor and successor as a normal rotation strategy. After the switch, the predecessor is retained only for receiver validation of requests made with its `keyid`; it MUST NOT be used for newly generated signatures. The local switching instant is not a well-known field and is not part of the wire contract. A publisher MUST ensure that the successor is valid before the first successor-signed request and that the predecessor remains valid after that request until its advertised `notAfter`.

During the overlap, a receiver MUST accept each currently valid, root-authorized certificate independently. The validity intervals in a well-known document need not be contiguous, and a receiver MUST NOT reject an otherwise valid document merely because the published certificate set contains a gap or more than one future interval. For one request, it MUST select the certificate identified by that request's `keyid` and verify the request with that certificate; it MUST NOT verify the same request by trying unrelated certificates in sequence or by treating discovery-document order as a preference. Matching is exact over the complete `KeyId`; a receiver MUST NOT apply case folding, whitespace trimming, URL decoding, prefix matching, suffix matching, `KeyName`-only matching, or any other normalization.

For signing-key rotation, a deployment's clock-skew budget `S` is the maximum permitted absolute difference between the UTC wall clocks used by a sender and receiver when constructing, switching, or validating signed requests and certificate validity intervals:

```text
|senderClock - receiverClock| <= S
```

The clock-skew budget is a local deployment parameter. It is not a well-known field, is not negotiated between peers, and MUST NOT be used by a receiver as a certificate-validity grace period. A publisher MUST provision its successor prepublication and predecessor post-switch overlap to cover the configured clock-skew budget together with the maximum HTTP Message Signature lifetime, expected request retry and delivery latency, and the normal interval in which a recognized peer can obtain and validate the current well-known document. A deployment that cannot maintain its configured clock-skew budget MUST NOT rely on receiver-side tolerance to preserve rotation safety.

The successor prepublication interval MUST be long enough for recognized receivers to obtain and validate the successor before its first use, including the configured clock-skew budget and the deployment's expected discovery delay. The predecessor post-switch overlap MUST be long enough for requests made with the predecessor to remain verifiable, including the configured clock-skew budget, maximum signature lifetime, delivery and retry latency, and discovery delay. A rejection caused solely by a certificate being not-yet-valid or expired, including one caused by clock skew, MUST NOT replace a root pin, reset recognition, or enter `halted`; it affects only the current request or temporary reachability state.

The overlap window SHOULD normally be at least one hour and SHOULD normally be 24 hours or longer for peers that may be offline; an implementation MAY choose another value when its configured timing bounds provide equivalent protection. Signing-key certificates SHOULD have finite validity periods rather than remaining valid indefinitely.

The publisher MUST keep the same authorizing root during ordinary signing-key rotation. Addition, activation, expiration, and removal of a signing key correctly authorized by the pinned root are normal rotation and MUST NOT change peer identity, initial-recognition confirmation time, cursors, mirrors, or existing authorization. A root change is governed exclusively by Section 1.5; it is never implied by certificate churn.

A receiver MAY cache certificates validated by the pinned root, but MUST validate the selected certificate's validity interval when authenticating a request. A receiver MUST reject a request using a `keyid` that is unpublished, invalidly authorized by the pinned root, or not currently valid. For an established peer with a pinned root, a receiver of non-Health signed operations SHOULD obtain a newer well-known document when the selected `keyid` is absent or no longer valid in its local cache, subject to local rate limits and loop prevention. The refresh mechanism and its scheduling are implementation concerns described outside this wire specification. Temporary inability to obtain well-known is not identity loss. For ordinary authenticated operations that use such key discovery, temporary discovery failure is a retryable key-fetch failure, normally HTTP `503 INTERNAL`; if well-known is obtained but the `keyid` remains unauthorized or outside its validity interval, the result is HTTP `401 FEDERATION_BAD_SIGNATURE`. Recognize instead follows the immediate-response, four-category result contract in Peer Recognition, Section 7; it does not wait for discovery to answer. Health instead uses the cache-only authentication boundary in Section 3.5 and the status projection in [Peer Recognition, Section 9](./recognition.md#9-health-query-and-privacy).

### 1.5 Root-key rotation

A publisher MAY rotate its root identity. Each receiver adopts the change through
a validated Recognize rotation arrival and its own local policy, not merely by
refreshing well-known. The publication rules cut over immediately instead of
serving both generations, permitting revocation of a compromised lineage.

Publication rules:

- Before its first use, the publisher MUST add the successor root to `roots` with `notBefore` at or before the present, while the predecessor root remains in `roots`. On the switch, the publisher removes every predecessor-authorized certificate from `keys[]` in the same publication: removal from `keys[]` is the revocation channel, and successor-authorized certificates are the only ones left. During the transition the predecessor root entry intentionally carries no live certificates; receivers MUST NOT require a currently valid root to have one.
- The publisher then signs only under successor-authorized certificates and claims only the successor root in `S2S-Root-Key`. Ordinary requests to peers that have not yet adopted the successor root fail authentication with HTTP `401` until that peer adopts the rotation; that interruption is accepted by design, because continued use of predecessor credentials would ask peers to keep trusting a possibly compromised lineage.
- The predecessor root entry MUST remain in `roots` until every recognized peer has accepted the rotation or the publisher has abandoned the rotation: a peer can no longer resolve a rotation arrival once its pinned root disappears from the group. Removal of a still-pinned root before adoption is an identity contradiction for the peers that still pin it. When a successor root is abandoned before adoption, the publisher removes it and restores predecessor-authorized certificates.
- A receiver MUST NOT adopt a successor root merely because it appears in a fetched well-known document. Requests claiming an unpinned root fail authentication except on the bootstrap Recognize path. [Peer Recognition, Sections 4.5–4.6](./recognition.md#45-root-rotation-arrival) define rotation-arrival validation, implementation-selected adoption policy, and the atomic binding change.
- To keep sealed challenges under retired keys openable and rotation arrivals verifiable forever, the publisher retains every root and signing key it has ever published — private key material included — in its internal history; publication removal and internal retention are separate acts.

A validated arrival proves control of a successor-authorized signing key and
publication at the hostname-verified domain of a group containing the pinned
root. It does not prove possession of the predecessor private key. Whether to
require additional evidence before adoption is implementation policy.

## 2. Network discovery, transport, and signature security

A Federation peer is a server-configured and recognized domain identity, not an arbitrary client-facing URL resource.

### 2.1 Mandatory SRV resolution

Given canonical peer `Domain` value `D`, an implementation MUST query the DNS SRV RRset at the exact owner name `_somfp._tcp.D`. Publishing a valid SRV record is mandatory for a server enabling Federation. v1 does not permit bypassing SRV to resolve `D` directly and defines no alternative discovery path such as default port `443` or local direct-connect configuration:

1. For a non-empty, syntactically valid SRV RRset, apply RFC 2782: lowest `priority` first and weighted random selection among records of equal priority. `priority` and `weight` MUST be in `0..65535`. For a target other than `.`, `port` MUST be in `1..65535`, and the target MUST be a DNS hostname normalizable as the `Domain` in [Core Protocol, Section 6.2](./protocol.md). A target MUST NOT be an IPv4 or IPv6 address literal; bracketed IPv6, decimal IPv4, and every other direct IP representation are invalid. A target MAY be outside `D` but MUST NOT be a CNAME alias under RFC 2782.
2. Resolve A/AAAA for a selected target and connect to its selected port. Each connectable target MUST resolve to at least one usable A or AAAA record; supporting both IPv4 and IPv6 is not required. v1 does not prescribe address-family or same-family address priority. A caller MAY select, interleave, or race connection attempts according to local routing, historical success, connection latency, and current network conditions. After a failed connection, it SHOULD continue with untried addresses and SRV records while preserving SRV priority and weight semantics. An A/AAAA result is only a substitute connection address for the hostname, not an SRV target, peer identity, TLS name, or HTTP authority. A target without a usable A/AAAA result is not connectable; its text MUST NOT be interpreted as another IP notation.
3. A publisher MUST ensure that every A/AAAA address for one SRV target, and every target in the same SRV RRset serving the same logical peer domain, provides the same Federation identity, protocol versions, and consistent durable state and shares the operation-defined idempotency keys, recognition state, and cursor state. Switching between IPv4, IPv6, or targets MUST NOT cause one conformant retry to produce a second business side effect.
4. Address-level racing means racing connection establishment only. Unless the operation explicitly makes the request safely retryable under the same idempotency key, a caller MUST NOT send the same side-effecting HTTP request concurrently merely because multiple addresses are reachable. A retry after an uncertain connection result remains subject to [Core Protocol, Section 7.4](./protocol.md) and the operation's idempotency rules.
5. A definitive `NXDOMAIN` or `NODATA` SRV answer means `D` does not currently publish Federation service. The caller MUST NOT issue a Federation request or try `D:443` or another guessed location. It may query again only after the negative DNS TTL expires or an administrator explicitly triggers it.
6. DNS timeout, `SERVFAIL`, `REFUSED`, or another temporary resolution failure is a retryable discovery failure. The caller MUST back off and retain existing pins, cursors, and mirrors. It MUST NOT interpret the failure as an unpublished service or identity loss.
7. A sole SRV target `.` explicitly states that the domain provides no SOMFP service. This special record SHOULD use port `0`; a caller MUST NOT attempt a connection. Mixing `.` with another target, using an IP literal or invalid hostname or port, or returning an RRset without one unambiguous interpretation is a configuration error.
8. If every usable target in a valid RRset fails to connect, the operation ends with connection failure. The caller MUST NOT fall back to resolving `D` directly, try a bare IP or another common port, or infer an alternative location from well-known or an HTTP redirect.

Positive and negative SRV/A/AAAA caching MUST NOT exceed the effective TTL supplied by the DNS resolver. Resolution after TTL expiry MAY change the connection location but MUST NOT change peer identity. v1 does not require DNSSEC because DNS and SRV provide only untrusted routing input. An implementation MAY use DNSSEC, a fixed resolver, IP or egress policy, or other local hardening, but MUST NOT use a DNS result to skip HTTPS, root-pin, or request-signature validation.

Minimal valid publication example:

```dns
_somfp._tcp.chat.example. 3600 IN SRV 0 0 443 chat.example.
chat.example.            3600 IN A   192.0.2.10
chat.example.            3600 IN AAAA 2001:db8::10
```

Listing both A and AAAA only illustrates both address families; publishing either one alone conforms to v1. The SRV target is `chat.example`, not `192.0.2.10` or `[2001:db8::10]`. Under the rules above, the target MAY delegate to another valid hostname. Regardless of target, the selected port MUST serve a TLS certificate valid for logical peer domain `chat.example`.

### 2.2 Logical authority, TLS, and redirects

SRV delegates only the TCP connection to target `T` and port `P`. The logical request target remains peer domain `D`:

- TCP connects to `T:P`, but TLS SNI MUST send `D`, and the TLS certificate hostname MUST be validated against `D`, not SRV target `T`.
- HTTPS request authority, HTTP/2 or HTTP/3 `:authority`, and HTTP/1.1 `Host` MUST be `D`, or `D:P` when `P != 443`. SRV target `T` MUST NOT appear in request authority.
- The HTTP Message Signature `@authority` MUST cover the logical authority actually sent.
- Well-known and every S2S operation MUST NOT automatically follow an HTTP redirect. Any `3xx` fails the current operation. A redirect target MUST NOT become a new peer, establish a pin, supply accepted response data, or advance a cursor.

For example, if `_somfp._tcp.chat.example` returns target `edge.provider.example` and port `8443`, the client connects to `edge.provider.example:8443` but sends TLS SNI `chat.example`, validates `chat.example` in the certificate, sends `Host: chat.example:8443`, and signs `"@authority": chat.example:8443`.

DNS and SRV results determine only connection location and MUST NOT change a pinned root identity or bidirectional recognition fact. An identity contradiction after a DNS change MUST be handled fail closed; the current domain controller cannot automatically be treated as the original peer.

### 2.3 Identity recovery and transport requirements

After an identity contradiction, automatic processing MUST remain `halted` and MUST NOT recover merely because DNS changes again. After DNS is repaired, an administrator MAY initiate nondestructive recovery of the original identity. Recovery MUST resolve the connection location again and retrieve discovery over hostname-validated HTTPS. The original recognition relationship may resume only if the discovered `roots` group contains the pre-contradiction pin byte for byte and that root correctly validates a current signing-key certificate. The signing key or certificate set may differ through normal rotation and need not equal the old cache entry by entry. Recovery MUST preserve bidirectional recognition facts, initial-confirmation time, cursors, mirrors, and existing authorization. A different root identity remains fail closed unless a root rotation is accepted under Section 1.5. Leaving `halted` still requires administrative recovery under [Peer Recognition, Section 11](./recognition.md#11-administrative-boundary).

Identity continuity requires no additional public proof endpoint. For an inbound request, the HTTP Message Signature proves possession of the current signing private key, the certificate's `authorizationSignature` binds that key to its authorizing root, and the receiver's pin binds the root to the original Federation identity. For an outbound connection and response, hostname-validated HTTPS authenticates the current domain endpoint, and the well-known `roots` group MUST contain the local pin. Failure of any check MUST NOT open ordinary S2S operations.

Federation v1 communication MUST use HTTPS and validate the TLS hostname of the logical peer domain. Plain HTTP is nonconformant. Choice of DNS resolver, IP classification, connector, or outbound network policy is local implementation behavior and MUST NOT change v1 identity or signature-validation semantics.

## 3. Request construction overview

Except for public well-known discovery, a sender MUST construct a v1 request in this order:

1. Select the method, path template, query fields, and body shape under the operation specification, and select a signing key satisfying Sections 1.3 and 1.4.
2. Construct the final method, path, query, and authority under Section 3.1.
3. Serialize the body to its final UTF-8 bytes and calculate `Content-Digest` under Section 3.2; use an empty byte string for an operation without a body.
4. Generate `created`, `expires`, and `Date`, then construct all request headers under Section 3.3.
5. Construct `Signature-Input`, the signature base, and `Signature` under Section 3.4.
6. Send exactly the request target, header values, and body bytes established in Steps 2–5. After signing, the sender MUST NOT reserialize the body, rewrite the URI, change authority, or modify a covered header.

An operation determines whether a business field belongs in path, query, or body. This section defines only how those values become one HTTP representation.

### 3.1 Request-target construction

The method MUST exactly match the case specified by the operation. A `/` used as a structural separator in a path template MUST be sent unchanged. Each path variable MUST be URI percent-encoded independently rather than concatenated before encoding. Unreserved characters `ALPHA / DIGIT / "-" / "." / "_" / "~"` are not encoded. Every other UTF-8 byte uses upper-case hexadecimal `%HH`. A `/` in a variable value MUST become `%2F`; a space MUST become `%20` and MUST NOT become `+`.

The query `?`, `&` between fields, and `=` between key and value are structural characters and MUST be sent unchanged. An operation document lists fixed ASCII query keys in appearance order. The sender MUST use that order and independently apply the encoding above to each value. A sender MUST NOT append an empty query marker not defined by the operation. With no query, the request target has no `?`, while the derived signature component `@query` is the single character `?` as defined below.

A duplicate or unknown query key, missing required value, empty value, invalid percent-encoding, or out-of-range value is a malformed request. `@path` is the received absolute path without query. `@query` is the raw query beginning with `?`, or the single character `?` when no query is present. During signature validation, path and query MUST NOT be reordered, decoded and re-encoded, or normalized.

`@authority` is the logical HTTP request authority constructed and actually sent under Section 2.2: the lower-case peer domain, retaining a non-default HTTPS port and omitting HTTPS port `443`. HTTP/2 and HTTP/3 use `:authority`; HTTP/1.1 uses `Host`. An SRV target MUST NOT appear in `@authority`. Signer identity always comes from validated `keyid`, never from authority.

### 3.2 Request body and content digest

An operation with a body MUST first produce its final UTF-8 bytes according to [Core Protocol, Section 6.1](./protocol.md) and any operation-specific field-order requirement. An operation without a body uses a zero-length byte string. `Content-Digest` MUST be calculated over those exact bytes according to RFC 9530 and has the fixed form `sha-256=:<base64-sha256>:`. Before validation is complete, neither sender nor receiver may replace those bytes through JSON reconstruction, reserialization, whitespace formatting, or Unicode or number normalization.

`Content-Digest` alone does not authenticate the sender because anyone can recompute a digest for a substituted body. The HTTP Message Signature covers the `content-digest` header rather than body bytes directly: the digest binds body bytes to the header, then the signature binds that header together with method, request target, authority, and time to the signer. A receiver MUST validate both digest and signature and MUST NOT treat either as a substitute for the other.

### 3.3 Signed request headers

Except for public well-known discovery, every v1 request, including `recognize` and `health`, MUST use this fixed HTTP Message Signature profile. The authentication contexts in [Core Protocol, Section 3](./protocol.md) change only key resolution and recognition or authorization gates, not this wire format.

| Header            | Requirement                                                                                                                                                                                                                                                                                                                                             |
| ----------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `Content-Type`    | MUST be `application/json` with a JSON body; MUST NOT be sent without a body.                                                                                                                                                                                                                                                                           |
| `Accept`          | MAY be sent as `application/json`; not signed and does not change the v1 response shape.                                                                                                                                                                                                                                                                |
| `S2S-Root-Key`    | MUST be sent; the base64 Ed25519 public key of the root authorizing the request's signing certificate. A routing and binding hint only: it is not covered by the signature base, and a receiver MUST NOT trust it beyond resolving the local identity; authentication always derives from the certificate chain and pinned root (Sections 1.2 and 1.5). |
| `Date`            | MUST be sent as IMF-fixdate representing the same whole second as `created`.                                                                                                                                                                                                                                                                            |
| `Content-Digest`  | MUST be sent; calculated over final body bytes under Section 3.2, or over the empty byte string without a body.                                                                                                                                                                                                                                         |
| `Signature-Input` | MUST be sent with exactly one label, `sig1`.                                                                                                                                                                                                                                                                                                            |
| `Signature`       | MUST be sent with exactly one label, `sig1`.                                                                                                                                                                                                                                                                                                            |
| `Range`           | MAY be sent only by the media operation; a single bytes range, not covered by the v1 request signature.                                                                                                                                                                                                                                                 |

Header names are case-insensitive, but signature component names use the lower-case forms in the table. A receiver MUST reject a request if `Date`, `Content-Digest`, `Signature-Input`, or `Signature` appears in multiple field lines, has multiple dictionary members, or has a combined value that cannot be parsed unambiguously. `S2S-Root-Key` MUST appear at most once and MUST decode to exactly 32 bytes of Ed25519 public key under the strict base64 rules of [Peer Recognition, Section 4.3](./recognition.md#43-root-and-signing-key-continuity); it never enters the signature base, so removing or altering it cannot invalidate the signature — it only changes which local identity the receiver resolves, and a wrong value fails authentication. `Content-Length`, `User-Agent`, and hop-by-hop headers are not covered by the v1 signature.

### 3.4 HTTP Message Signature construction

| Item               | Federation v1 fixed value or rule                                                                                                                                   |
| ------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Signature standard | RFC 9421 wire format with the single label `sig1`.                                                                                                                  |
| Algorithm          | `ed25519`.                                                                                                                                                          |
| Covered components | `"@method" "@path" "@query" "@authority" "date" "content-digest"` in this fixed order.                                                                              |
| `keyid`            | A signing-key ID published by the signer in well-known and valid for the authentication context; the substring before the first `/` is the canonical signer domain. |
| `created`          | A safe integer in Unix epoch seconds.                                                                                                                               |
| `expires`          | A safe integer in Unix epoch seconds satisfying `created <= expires <= created + 300`.                                                                              |
| `alg`              | Fixed to `"ed25519"`.                                                                                                                                               |

After completing the request target, body bytes, and `Content-Digest` under Sections 3.1 and 3.2, the sender MUST construct time fields and the signature in this order:

1. Set `created = floor(nowMilliseconds / 1000)` and `expires = created + 300`, and construct `Date` for the same whole UTC second represented by `created`.
2. Construct `Signature-Input` in the exact parameter order below.
3. Construct the RFC 9421 signature base using the final method, raw path, raw query, authority, `Date`, and `Content-Digest`.
4. Sign the signature base with the Ed25519 signing private key identified by `keyid` and construct `Signature`.

```text
sig1=("@method" "@path" "@query" "@authority" "date" "content-digest");created=<seconds>;expires=<seconds>;keyid="<key-id>";alg="ed25519"
```

The RFC 9421 signature base consists of these seven lines separated by `LF`, with no additional `LF` after the final line:

```text
"@method": <uppercase-method>
"@path": <absolute-path-without-query>
"@query": <raw-query-with-leading-question-mark-or-question-mark-only>
"@authority": <HTTP-authority>
"date": <Date-header-value>
"content-digest": <Content-Digest-header-value>
"@signature-params": ("@method" "@path" "@query" "@authority" "date" "content-digest");created=<seconds>;expires=<seconds>;keyid="<key-id>";alg="ed25519"
```

`Signature` is `sig1=:<base64-ed25519-signature>:`. The signature's base64 value MUST decode to exactly 64 bytes. See [`schema/vectors/http-message-signature.json`](./schema/vectors/http-message-signature.json) for the complete fixed, non-secret vector.

### 3.5 Validation order and failure boundaries

A receiver MUST validate a signed request according to these security boundaries. An implementation MAY combine internal steps that do not change observable results, but MUST NOT perform a later business side effect before completing its prerequisite security check:

1. Bound request-line, header, and body sizes, and reject duplicate or ambiguously parseable security headers.
2. Parse `Signature-Input` and `Signature`; check the single label, fixed component order, parameter set, and `alg`. Decode `S2S-Root-Key` to a root public key and use it — together with the canonical signer domain from `keyid` — to resolve the local identity: for an established peer, the active namespace pinned to that root; for `bootstrap signed`, the identity to be validated against the freshly fetched well-known group under recognition.md.
3. Extract the canonical signer domain from `keyid` and resolve the selected
   certificate under the authentication context in [Core Protocol, Section 3]
   (./protocol.md). For `recognized signed`, the pinned identity and prepared
   receive path are prerequisites to authentication, and the certificate's
   authorizing `root` MUST byte-equal the pinned root. For `health`, any failure
   to resolve or authenticate produces the uniform `unavailable` result defined
   by recognition.md; no error envelope is emitted. For `bootstrap signed`, use
   the dedicated well-known validation path defined by recognition.md.
4. Check `created <= expires <= created + 300` and that `Date`, parsed as Unix epoch seconds, equals `created` exactly. Reject `created < now - 300`, `created > now + 60`, or `expires < now`.
5. Validate `Content-Digest` over the received raw body bytes. Its Structured Fields dictionary MUST contain exactly one parameterless `sha-256` byte sequence.
6. Validate the Ed25519 signature using the received method, raw path, raw query, authority, and header values.
7. Validate the recipient's local recognition and prepared path when the context is `recognized signed`, then parse JSON and validate the operation shape, shared Federation types, signer/body/resource binding, and business authorization.
8. Perform operation side effects only after every preceding check succeeds.

After Step 6 succeeds for a pinned, locally recognized peer whose receive path
is prepared, the receiver MUST treat the authenticated request as current
reachability evidence before applying the later direction, shape, binding, and
business checks. A rejection in Step 7 does not undo that reachability
observation and does not create peer-acceptance or business-authorization
evidence. For a first bootstrap Recognize, recognition.md instead requires
identity pinning, the local recognition decision, receive-path preparation,
the requester's explicit recognition assertion, and this reachability
observation to become externally visible together before `OK` is returned.

The authenticated signer domain comes exclusively from the validated `keyid`.
An operation body MUST NOT repeat it as a generic source, origin, or sender
field. Operation-specific addresses remain subject to their own author and
resource-binding rules.

A header or profile parsing error, digest mismatch, or signature mismatch MUST NOT be downgraded to a business rejection. The Stable Error Registry defines the exact HTTP status, stable code, and caller action.

Inbound Health authentication MUST use only already available pinned identity
and certificate state and MUST NOT initiate well-known discovery to answer the
query, even for a known peer. Every failure in the common authentication checks,
including request-size or parsing failure and missing, unresolvable, invalid,
expired, or unpublished credentials, MUST produce the uniform HTTP `200`
`unavailable` status envelope, not an error envelope. Only an authenticated
request proceeds to status projection. The projection uses admission-time
reachability before the authenticated-request refresh above.

[Peer Recognition, Section 9](./recognition.md#9-health-query-and-privacy) owns
Health response shapes, privacy decisions, requester behavior, and the
relationship between certificate freshness and Health. The
[Stable Error Registry](./errors.md) defines classification of invalid or
non-`200` responses; they supply neither acceptance nor fatal identity evidence.

Federation v1 does not add an HTTP Message Signature to an ordinary JSON response; hostname-validated TLS provides response origin and integrity. This does not alter response-digest rules separately defined by the media operation.

### 3.6 Complete signed request example

The following fixed example uses public test key `A6EHv/POEL4dcN0Y50vAmWfk1jCbpQ1fHdyGZBJVMbg=`. Its corresponding test private key MUST NOT be used in production:

```http
POST /s2s/v1/feed-heads HTTP/1.1
Host: b.example
Content-Type: application/json
Date: Tue, 14 Nov 2023 22:13:20 GMT
S2S-Root-Key: A6EHv/POEL4dcN0Y50vAmWfk1jCbpQ1fHdyGZBJVMbg=
Content-Digest: sha-256=:S8Ej706iBje3HBAal9+2/jBmLwJdAzMgCxGP7f/jdUo=:
Signature-Input: sig1=("@method" "@path" "@query" "@authority" "date" "content-digest");created=1700000000;expires=1700000300;keyid="a.example/key-1";alg="ed25519"
Signature: sig1=:JH/NAUDHFdVtcmBlEVups5pEbphOT4w16AAnMh4s+BX0MSOMPMwpEVckwoIX23stovuU8ZBIwqRTgGygW9p+Bg==:

{"stateFeedEndId":"12","profileNamespaceFeedEndId":"7"}
```

The exact UTF-8 bytes of the final body line are used for both `Content-Digest` and the signature; the trailing newline shown by formatting is not part of the body. `Host` produces signature component `"@authority": b.example`. The request has no query, so its signature component is `"@query": ?`. The complete signature base and non-secret private test key are in [`schema/vectors/http-message-signature.json`](./schema/vectors/http-message-signature.json). [Federation v1 Peer Recognition, Section 10](./recognition.md#10-complete-http-construction-examples) contains complete certificates, requests, responses, and signature bases for Recognize and Health.

### 3.7 Sealed challenge construction

A sealed challenge proves that a server holds the private counterpart of a supplied public key, without requiring the key type to support signatures on that path and without server-side state. The construction is a sealed box over the X25519 form of the server's Ed25519 keys:

1. **Key conversion.** The responder's Ed25519 keys convert to X25519 form per the standard birational map (RFC 7748): the public key converts directly; the private key is the clamped SHA-512 of the Ed25519 seed, as used by the common `crypto_sign_ed25519_pk_to_curve25519` / `sk_to_curve25519` primitives. The same 32-byte key material is used; only the curve form changes.
2. **Sealing (caller side).** The caller generates a fresh ephemeral X25519 keypair, performs X25519 with the ephemeral private key and the converted recipient public key, derives the symmetric key and nonce through the standard sealed-box KDF, and encrypts the plaintext with XSalsa20-Poly1305. The sealed box is `ephemeral-public-key (32 bytes) || ciphertext || 16-byte tag`.
3. **Opening (responder side).** The responder converts the supplied public key's retained private counterpart to X25519, performs X25519 with the ephemeral public key from the box, derives the same symmetric key and nonce, and opens the box. Failure to open under the supplied key is a malformed challenge; success returns the recovered plaintext bytes using the answer encoding below.

The plaintext is opaque to the protocol: any bytes up to 4096 MAY be sealed; the responder MUST NOT interpret it. On the wire a sealed challenge is the box encoded as RFC 4648 padded base64 (`Base64SealedChallenge`). The JSON answer fields `value` (Verify) and `proof` (Profile) MUST encode the recovered plaintext bytes as canonical RFC 4648 standard base64, with required padding and zero pad bits (`Base64ChallengeAnswer`). Empty plaintext is encoded as the empty string. The caller MUST compare the decoded answer byte-for-byte with the original plaintext; equivalently, it MAY compare the answer string with the canonical base64 encoding of the original bytes. The answer MUST NOT be interpreted as UTF-8 plaintext. Ed25519 signature verification is unaffected: this construction is for possession proofs, while signatures continue to use Ed25519 directly.
