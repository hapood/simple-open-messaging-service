# Simple Open Messaging Federation Protocol v1

Status: `RELEASE CANDIDATE`

Release: `v1.0.0-rc.0`

This directory contains the Simple Open Messaging Federation Protocol v1.0.0-rc.0 candidate package. The protocol model and mandatory features are closed. The normative text specifies only the observable wire contract, state transitions, and security boundaries between independent implementations. Database tables, workers, queues, user interfaces, deployment parameters, and local product limits are outside the protocol unless the text explicitly constrains a local behavior because it changes a peer-observable result.

This English text is the authoritative working text for v1.0.0-rc.0.

The key words `MUST`, `MUST NOT`, `SHOULD`, `SHOULD NOT`, and `MAY` are to be interpreted as described in RFC 2119 and RFC 8174. Wire fields, enum values, HTTP headers, standard names, and stable error codes retain their original spelling and appear in code formatting. Examples, diagrams, TypeScript notation, and artifacts under `schema/` explain or validate the normative text but do not independently create protocol requirements.

## Reading order

See [CONFORMANCE](./CONFORMANCE.md) for the complete conformance scope and module dependencies, and [`RELEASE.json`](../RELEASE.json) for release metadata.

1. [Core Protocol](./protocol.md): roles, versioning, HTTP surface, shared types, responses, durable state, and evolution rules.
2. [Transport and Security](./transport-security.md): well-known discovery, root and signing keys, SRV, TLS, logical authority, digests, and HTTP Message Signatures.
3. [Peer Recognition](./recognition.md): bidirectional Recognize, root public-key pinning, the peer-assigned namespace disclosure, domain re-binding and root rotation arrivals, sealed-challenge verification and namespace identity disclosure, Health availability queries, degraded state, timing, and failure handling.
4. [State Feed](./state-feed.md): compacted relationship/profile-reference, Group Meta feed-head, and thread-content snapshots.
5. [Group Meta Feed](./group-meta.md): the group-origin canonical full and delta member-role, compacted group-profile-reference, and current-announcement feed.
6. [Profiles](./profiles.md): public current profile lookup and exact profile lookup authorized by messages, Group Meta, or Relationship Intent.
7. [Message Query](./message-feed.md): per-thread message query and skip-mode boundaries.
8. [Message Tombstone Query](./message-tombstone-feed.md): permanent deletion facts, authoritative query, and race convergence.
9. [Message Provenance](./message-provenance.md): batched origin attestation of a published message's content digest at a `(thread, seq)` coordinate.
10. [Message](./message.md): message identity, content types, resource references, replies, and forward closure.
11. [Resources](./resources.md): parameters, responses, authorization, and errors for media bytes and forward closure.
12. [Audio and Video Calls](./calls.md): the mandatory end-to-end Call Profile, including S2S frames, endpoint WebRTC/JSEP behavior, lifecycle state, and AUDIO-to-VIDEO upgrade on the same connection.
13. [Stable Error Registry](./errors.md): stable error codes, HTTP status, retry behavior, and identity actions.
14. [Machine-readable Release Package](./schema/README.md): JSON Schema, HTTP manifest, positive and negative vectors, and the Conformance CLI.

The Core Protocol defines shared rules. Transport and Security defines the discovery, TLS, and signature profile shared by all operations. Each remaining operation document defines only its body, authorization, state, and idempotency semantics. Together these documents form one versioned release package, whose status applies to the whole package rather than ordinary chapters.

An operation document may tighten a shared rule only within the scope delegated
by the Core Protocol and cannot weaken transport, identity, envelope, or
evolution rules. The Core Protocol defines document ownership and precedence. A
remaining conflict between normative documents is a release defect that must be
corrected; JSON Schema, examples, and existing implementations must not be used
to select an alternative meaning.

JSON Schema, the HTTP manifest, positive and negative vectors, and the Conformance CLI ship with the normative text as non-normative validation resources. They are not part of runtime negotiation and cannot alter the normative text. Cross-major discovery selects a common major only through `protocolVersions`.

## Authoring and terminology rules

- One term has one meaning. `publisher` publishes a feed or query; `source` identifies its source node; `consumer` consumes it; and `peer` means the remote peer node.
- `recognition` means the bidirectional server-recognition process defined by this protocol, not generalized `trust`. `authorization` means permission for a specific operation and cannot be inferred from recognition alone.
- Normative requirements use complete sentences containing an RFC 2119/RFC 8174 keyword. Explanatory sentences without a keyword do not imply additional requirements.
- Avoid unverifiable conditions such as “appropriate,” “normal,” “as soon as possible,” or “when necessary.” When unavoidable, the same paragraph defines the trigger, observable result, or implementation choice.
- Pronouns must have an unambiguous antecedent. When two servers are involved, use `A`, `B`, or role names.
- Wire fields, enums, HTTP methods, paths, headers, media types, and stable error codes retain their exact spelling.
- Examples and implementation notes must not introduce rules absent from normative text. If translation reveals ambiguity, first resolve and record the semantic decision; translation must not silently choose one interpretation.
