# Simple Open Chat Federation Protocol v1 Transport and Security

Status: `RELEASE CANDIDATE` (`v1.0.0-rc.0`)

This document defines the Federation v1 discovery document, root identity, signing-key certificates, network discovery, TLS, HTTP request targets, Content-Digest, and HTTP Message Signature profile. It is a normative component explicitly referenced by the [Simple Open Chat Federation Protocol v1](./protocol.md). An operation document cannot weaken its identity, transport, or signature-security requirements.

The key words `MUST`, `MUST NOT`, `SHOULD`, `SHOULD NOT`, and `MAY` are to be interpreted as described in RFC 2119 and RFC 8174.

## 1. Well-known discovery and signing keys

### 1.1 Public discovery mode

`GET /.well-known/socfp` without a query is a public discovery request and does not use an HTTP Message Signature. A successful response MUST use `Content-Type: application/json` and return this bare JSON object:

```ts
interface DiscoveryDocumentV1View {
  software?: string;
  protocolVersions: number[];
  rootKey: {
    ed25519: Base64Ed25519Key;
  };
  keys: SigningKeyCertificate[];
}
```

The interface above is the view that MUST be validated after selecting v1; it does not restrict a cross-version well-known object to those fields. A node publishing `[1, 2]`, for example, MAY retain all shared v1 fields and add v2 fields. A v1 consumer ignores the additions, while a v2 consumer validates their presence and meaning under v2.

`software` is an optional, untrusted opaque diagnostic string. If present, its UTF-8 encoding MUST be 1–128 bytes and MUST NOT contain a Unicode control character. A consumer MUST NOT parse or depend on its format and MUST NOT use it for version negotiation, capability decisions, authentication, authorization, or implementation-specific behavior.

`protocolVersions` MUST follow [Core Protocol, Section 2](./protocol.md). `rootKey` is the server-identity anchor object: a container whose actual Ed25519 root public-key value is `rootKey.ed25519`.

`keys` MUST be a non-empty array and may contain old, current, and not-yet-active signing-key certificates simultaneously. `keyId` values MUST NOT repeat within one document, and at least one certificate MUST be valid when the response is generated. Root keys and HTTP signing keys have distinct roles; equality of their public-key values MUST NOT be a protocol requirement.

| JSON key | Required | Role and example |
| --- | --- | --- |
| `software` | No | Untrusted diagnostic text such as `example-server/1.4.2`; never used for protocol decisions. |
| `protocolVersions` | Yes | The complete set of fully supported majors, such as `[1, 2]`. |
| `rootKey` | Yes | The long-lived server-identity anchor object; a container rather than a standalone public-key value. |
| `rootKey.ed25519` | Yes | The Ed25519 root public key, such as `A6EHv/POEL4dcN0Y50vAmWfk1jCbpQ1fHdyGZBJVMbg=`; it does not directly sign ordinary HTTP requests. |
| `keys` | Yes | Root-authorized signing-key certificates, permitting rotation overlap. |
| `keys[].keyId` | Yes | A domain-bound certificate name such as `a.example/key-1`; neither a public key nor a secret. |
| `keys[].ed25519` | Yes | The online HTTP/claim signing public key, such as `Kay64UG8yvCyLhqU000LxzYeUm0L/hLIl5S8kyKWbdc=`. |
| `keys[].notBefore` / `notAfter` | Yes | The half-open validity interval `[notBefore, notAfter)` in Unix epoch milliseconds. |
| `keys[].authorizationSignature` | Yes | An Ed25519 signature by the root private key over the Section 1.3 certificate statement. See [Peer Recognition, Section 10](./recognition.md#10-complete-http-construction-examples) for a complete verifiable example. |

A consumer selecting v1 MUST ignore well-known fields undefined by v1 and MUST NOT create v1 surface, authorization, or security branches from them. v1 does not publish runtime limits through well-known. Each operation's deterministic responses govern page, body, media, quota, group-capacity, and retention limits.

### 1.2 Root-key validation and pinning

A root public key cannot establish first trust through a self-signature. First trust comes from hostname-validated HTTPS. A root signature binds a rotatable signing key to that root, and an HTTP Message Signature proves possession of the signing private key. These purposes MUST NOT be conflated.

[Federation v1 Peer Recognition, Section 4](./recognition.md#4-identity-verification-recognition-and-pinning) defines strict base64 handling, byte-for-byte root pinning, the first-Recognize validation order, domain binding, and the pin transaction. Successfully reading well-known alone MUST NOT establish recognition.

Subsequent validation of an established peer MUST use the local pinned root rather than treating a newly fetched root as a new trust anchor. On a well-known refresh, the root public key MUST exactly equal the pin byte for byte. A mismatch is an identity contradiction: the peer MUST enter `halted`, record the identity-mismatch reason, and reject ordinary S2S operations. v1 does not rotate a root key within an existing recognition relationship. Adopting a new root requires a destructive reset and fresh bidirectional Recognize.

### 1.3 Root-authorized signing-key certificate

```ts
interface SigningKeyCertificate {
  keyId: KeyId;
  ed25519: Base64Ed25519Key;
  notBefore: EpochMilliseconds;
  notAfter: EpochMilliseconds;
  authorizationSignature: Base64Ed25519Signature;
}
```

The domain in `keyId` MUST equal the publisher's server domain, and `notBefore < notAfter`. The certificate statement therefore does not repeat a `domain` field; its complete canonical `keyId` provides domain binding. Once published under one root identity, a `keyId` is permanently bound to the same `ed25519`. The publisher MUST NOT reuse it for another public key.

`authorizationSignature` is an Ed25519 signature by the root private key over this canonical certificate statement. The statement is UTF-8 JSON with fixed field order and no extra whitespace. `notBefore` and `notAfter` use the JSON integer literals from the certificate:

```text
{"keyId":"<key-id>","ed25519":"<base64-key>","usage":"socfp-http-message-signature","notBefore":<epoch-ms>,"notAfter":<epoch-ms>}
```

The statement above is the exact signed input used by v1 to validate `authorizationSignature`. A later major MAY reuse this shared certificate core or add its own certificate fields, but MUST NOT change existing fields or the v1 meaning of `authorizationSignature`. If an added field affects key authorization, the new major MUST define a new independently verifiable signature field or structure. Well-known needs no separate `certificateVersion`; the selected Federation major determines the applicable requirements.

A consumer MUST validate `authorizationSignature` with the discovery document's root public key, or the pinned root public key for an established peer. A certificate may generate or validate an HTTP Message Signature only while `notBefore <= now < notAfter`. An expired or not-yet-active certificate MUST NOT be used to accept a request, although a consumer MAY cache one before activation.

### 1.4 Signing-key rotation and on-demand discovery

For a rotation, a publisher SHOULD first publish the new certificate in `keys`, set its `notBefore` earlier than the old key's `notAfter`, and retain both certificates during the overlap. The publisher MUST NOT remove a certificate from well-known before its `notAfter` and MUST NOT send a request with a key before `notBefore` or at or after `notAfter`.

A consumer MAY cache a certificate validated by the pinned root until `notAfter`. On receiving an uncached `keyid`, it SHOULD immediately refetch well-known subject to a per-domain rate limit, validate the pinned root, certificate, and validity interval, and then validate the original HTTP request. Temporary well-known unavailability is a retryable key-fetch failure, not identity loss. A receiver MUST reject a request using a `keyid` that is unpublished, invalidly authorized by the root, or not currently valid.

Addition, activation, expiration, and removal of a signing key correctly authorized by the pinned root are normal rotation and MUST NOT change peer identity, initial-recognition confirmation time, cursors, mirrors, or existing authorization. A root public key differing byte for byte from the pin remains an identity contradiction and MUST be handled fail closed.

## 2. Network discovery, transport, and signature security

A Federation peer is a server-configured and recognized domain identity, not an arbitrary client-facing URL resource.

### 2.1 Mandatory SRV resolution

Given canonical peer `Domain` value `D`, an implementation MUST query the DNS SRV RRset at the exact owner name `_socfp._tcp.D`. Publishing a valid SRV record is mandatory for a server enabling Federation. v1 does not permit bypassing SRV to resolve `D` directly and defines no alternative discovery path such as default port `443` or local direct-connect configuration:

1. For a non-empty, syntactically valid SRV RRset, apply RFC 2782: lowest `priority` first and weighted random selection among records of equal priority. `priority` and `weight` MUST be in `0..65535`. For a target other than `.`, `port` MUST be in `1..65535`, and the target MUST be a DNS hostname normalizable as the `Domain` in [Core Protocol, Section 6.2](./protocol.md). A target MUST NOT be an IPv4 or IPv6 address literal; bracketed IPv6, decimal IPv4, and every other direct IP representation are invalid. A target MAY be outside `D` but MUST NOT be a CNAME alias under RFC 2782.
2. Resolve A/AAAA for a selected target and connect to its selected port. Each connectable target MUST resolve to at least one usable A or AAAA record; supporting both IPv4 and IPv6 is not required. v1 does not prescribe address-family or same-family address priority. A caller MAY select, interleave, or race connection attempts according to local routing, historical success, connection latency, and current network conditions. After a failed connection, it SHOULD continue with untried addresses and SRV records while preserving SRV priority and weight semantics. An A/AAAA result is only a substitute connection address for the hostname, not an SRV target, peer identity, TLS name, or HTTP authority. A target without a usable A/AAAA result is not connectable; its text MUST NOT be interpreted as another IP notation.
3. A publisher MUST ensure that every A/AAAA address for one SRV target, and every target in the same SRV RRset serving the same logical peer domain, provides the same Federation identity, protocol versions, and consistent durable state and shares the operation-defined idempotency keys, recognition state, and cursor state. Switching between IPv4, IPv6, or targets MUST NOT cause one conformant retry to produce a second business side effect.
4. Address-level racing means racing connection establishment only. Unless the operation explicitly makes the request safely retryable under the same idempotency key, a caller MUST NOT send the same side-effecting HTTP request concurrently merely because multiple addresses are reachable. A retry after an uncertain connection result remains subject to [Core Protocol, Section 7.4](./protocol.md) and the operation's idempotency rules.
5. A definitive `NXDOMAIN` or `NODATA` SRV answer means `D` does not currently publish Federation service. The caller MUST NOT issue a Federation request or try `D:443` or another guessed location. It may query again only after the negative DNS TTL expires or an administrator explicitly triggers it.
6. DNS timeout, `SERVFAIL`, `REFUSED`, or another temporary resolution failure is a retryable discovery failure. The caller MUST back off and retain existing pins, cursors, and mirrors. It MUST NOT interpret the failure as an unpublished service or identity loss.
7. A sole SRV target `.` explicitly states that the domain provides no SOCFP service. This special record SHOULD use port `0`, and no connection MUST be attempted. Mixing `.` with another target, using an IP literal or invalid hostname or port, or returning an RRset without one unambiguous interpretation is a configuration error.
8. If every usable target in a valid RRset fails to connect, the operation ends with connection failure. The caller MUST NOT fall back to resolving `D` directly, try a bare IP or another common port, or infer an alternative location from well-known or an HTTP redirect.

Positive and negative SRV/A/AAAA caching MUST NOT exceed the effective TTL supplied by the DNS resolver. Resolution after TTL expiry MAY change the connection location but MUST NOT change peer identity. v1 does not require DNSSEC because DNS and SRV provide only untrusted routing input. An implementation MAY use DNSSEC, a fixed resolver, IP or egress policy, or other local hardening, but MUST NOT use a DNS result to skip HTTPS, root-pin, or request-signature validation.

Minimal valid publication example:

```dns
_socfp._tcp.chat.example. 3600 IN SRV 0 0 443 chat.example.
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

For example, if `_socfp._tcp.chat.example` returns target `edge.provider.example` and port `8443`, the client connects to `edge.provider.example:8443` but sends TLS SNI `chat.example`, validates `chat.example` in the certificate, sends `Host: chat.example:8443`, and signs `"@authority": chat.example:8443`.

DNS and SRV results determine only connection location and MUST NOT change a pinned root identity or bidirectional recognition fact. An identity contradiction after a DNS change MUST be handled fail closed; the current domain controller cannot automatically be treated as the original peer.

### 2.3 Identity recovery and transport requirements

After an identity contradiction, automatic processing MUST remain `halted` and MUST NOT recover merely because DNS changes again. After DNS is repaired, an administrator MAY initiate nondestructive recovery of the original identity. Recovery MUST resolve the connection location again and retrieve discovery over hostname-validated HTTPS. The original recognition relationship may resume only if the discovered root public key equals the pre-contradiction pin byte for byte and that root correctly validates a current signing-key certificate. The signing key or certificate set may differ through normal rotation and need not equal the old cache entry by entry. Recovery MUST preserve bidirectional recognition facts, initial-confirmation time, cursors, mirrors, and existing authorization. A different root identity MUST remain fail closed. Adopting a new root requires destructive reset under [Core Protocol, Section 10](./protocol.md); Federation v1 does not define its administrative workflow.

Identity continuity requires no additional public proof endpoint. For an inbound request, the HTTP Message Signature proves possession of the current signing private key, and the pinned root's certificate signature binds that key to the original Federation identity. For an outbound connection and response, hostname-validated HTTPS authenticates the current domain endpoint, and the well-known root MUST equal the local pin. Failure of any check MUST NOT open ordinary S2S operations.

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

Except for public well-known discovery, every v1 request, including `recognize` and `healthy`, MUST use this fixed HTTP Message Signature profile. The authentication contexts in [Core Protocol, Section 3](./protocol.md) change only key resolution and recognition or authorization gates, not this wire format.

| Header | Requirement |
| --- | --- |
| `Content-Type` | MUST be `application/json` with a JSON body; MUST NOT be sent without a body. |
| `Accept` | MAY be sent as `application/json`; not signed and does not change the v1 response shape. |
| `Date` | MUST be sent as IMF-fixdate representing the same whole second as `created`. |
| `Content-Digest` | MUST be sent; calculated over final body bytes under Section 3.2, or over the empty byte string without a body. |
| `Signature-Input` | MUST be sent with exactly one label, `sig1`. |
| `Signature` | MUST be sent with exactly one label, `sig1`. |
| `Range` | MAY be sent only by the media operation; a single bytes range, not covered by the v1 request signature. |

Header names are case-insensitive, but signature component names use the lower-case forms in the table. A receiver MUST reject a request if `Date`, `Content-Digest`, `Signature-Input`, or `Signature` appears in multiple field lines, has multiple dictionary members, or has a combined value that cannot be parsed unambiguously. `Content-Length`, `User-Agent`, and hop-by-hop headers are not covered by the v1 signature.

### 3.4 HTTP Message Signature construction

| Item | Federation v1 fixed value or rule |
| --- | --- |
| Signature standard | RFC 9421 wire format with the single label `sig1`. |
| Algorithm | `ed25519`. |
| Covered components | `"@method" "@path" "@query" "@authority" "date" "content-digest"` in this fixed order. |
| `keyid` | A signing-key ID published by the signer in well-known and valid for the authentication context; the substring before the first `/` is the canonical signer domain. |
| `created` | A safe integer in Unix epoch seconds. |
| `expires` | A safe integer in Unix epoch seconds satisfying `created <= expires <= created + 300`. |
| `alg` | Fixed to `"ed25519"`. |

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
2. Parse `Signature-Input` and `Signature`; check the single label, fixed component order, parameter set, and `alg`.
3. Extract the canonical signer domain from `keyid`, apply the recognition or authorization gate for the authentication context in [Core Protocol, Section 3](./protocol.md), and select the key. `recognized signed` MUST NOT treat transport-only `degraded` as an authorization failure.
4. Check `created <= expires <= created + 300` and that `Date`, parsed as Unix epoch seconds, equals `created` exactly. Reject `created < now - 300`, `created > now + 60`, or `expires < now`.
5. Validate `Content-Digest` over the received raw body bytes. Its Structured Fields dictionary MUST contain exactly one parameterless `sha-256` byte sequence.
6. Validate the Ed25519 signature using the received method, raw path, raw query, authority, and header values.
7. Parse JSON and validate the operation shape, shared Federation types, signer/body/resource binding, and business authorization.
8. Perform operation side effects only after every preceding check succeeds.

If an operation body contains `origin` or a `from` of the form `{ account, domain }`, that domain MUST equal the signer domain. An operation without those fields uses the signer domain directly as the sending server identity.

A header or profile parsing error, digest mismatch, or signature mismatch MUST NOT be downgraded to a business rejection. The Stable Error Registry defines the exact HTTP status, stable code, and caller action.

`healthy` is a status-query operation. An unparseable request line, JSON value, or signature structure MAY receive a generic malformed error. Once the structure is parseable, an unknown peer, an identity that cannot be verified through an existing pin, a binding or permission failure, or local state that cannot safely be disclosed is a normal query result. Under recognition.md, it MUST return HTTP `200` with `unavailable` and MUST NOT cause a side effect.

Federation v1 does not add an HTTP Message Signature to an ordinary JSON response; hostname-validated TLS provides response origin and integrity. This does not alter response-digest rules separately defined by the media operation.

### 3.6 Complete signed request example

The following fixed example uses public test key `A6EHv/POEL4dcN0Y50vAmWfk1jCbpQ1fHdyGZBJVMbg=`. Its corresponding test private key MUST NOT be used in production:

```http
POST /s2s/v1/feed-heads HTTP/1.1
Host: b.example
Content-Type: application/json
Date: Tue, 14 Nov 2023 22:13:20 GMT
Content-Digest: sha-256=:jyei18yIj1UN70jxngwvAzEHm+S2VRlxbpRtAv4Wp3k=:
Signature-Input: sig1=("@method" "@path" "@query" "@authority" "date" "content-digest");created=1700000000;expires=1700000300;keyid="a.example/key-1";alg="ed25519"
Signature: sig1=:YB4YJhZ8Gx8fq4WI2wOszIppKsOZzrmiFMTcPoQqcS0Y9A/x0jPmwO4JrO+gAf17L01xosGsj4ppscoHdHPRAw==:

{"origin":"a.example","stateFeedEndId":"12","messageFeedEndId":"34","tombstoneFeedEndId":"9"}
```

The exact UTF-8 bytes of the final body line are used for both `Content-Digest` and the signature; the trailing newline shown by formatting is not part of the body. `Host` produces signature component `"@authority": b.example`. The request has no query, so its signature component is `"@query": ?`. The complete signature base and non-secret private test key are in [`schema/vectors/http-message-signature.json`](./schema/vectors/http-message-signature.json). [Federation v1 Peer Recognition, Section 10](./recognition.md#10-complete-http-construction-examples) contains complete certificates, requests, responses, and signature bases for Recognize and Healthy.
