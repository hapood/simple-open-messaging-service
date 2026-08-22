# Simple Open Chat Federation Protocol v1

Status: `RELEASE CANDIDATE`

Release: `v1.0.0-rc.0`

This directory contains the Simple Open Chat Federation Protocol v1.0.0-rc.0 candidate package. The protocol model and mandatory features are closed. The normative text specifies only the observable wire contract, state transitions, and security boundaries between independent implementations. Database tables, workers, queues, user interfaces, deployment parameters, and local product limits are outside the protocol unless the text explicitly constrains a local behavior because it changes a peer-observable result.

This English text is the authoritative working text for v1.0.0-rc.0.

The key words `MUST`, `MUST NOT`, `SHOULD`, `SHOULD NOT`, and `MAY` are to be interpreted as described in RFC 2119 and RFC 8174. Wire fields, enum values, HTTP headers, standard names, and stable error codes retain their original spelling and appear in code formatting. Examples, diagrams, TypeScript notation, and artifacts under `schema/` explain or validate the normative text but do not independently create protocol requirements.

## Reading order

See [CHANGELOG](./CHANGELOG.md) for release history, [CONFORMANCE](./CONFORMANCE.md) for the complete conformance scope and module dependencies, and [`RELEASE.json`](../RELEASE.json) for release metadata.

1. [Core Protocol](./protocol.md): roles, versioning, HTTP surface, shared types, responses, durable state, and evolution rules.
2. [Transport and Security](./transport-security.md): well-known discovery, root and signing keys, SRV, TLS, logical authority, digests, and HTTP Message Signatures.
3. [Peer Recognition](./recognition.md): bidirectional Recognize, root public-key pinning, Healthy availability queries, degraded state, timing, and failure handling.
4. [State Feed](./state-feed.md): snapshot-based compacted feed, four state types, relationship matching, member-reference ordering, and projection omission.
5. [Message Feed and Query](./message-feed.md): index-based compacted feed and thread-content query.
6. [Message Tombstone Feed and Query](./message-tombstone-feed.md): tombstone index, permanent deletion facts, and race convergence.
7. [Message](./message.md): message identity, content types, resource references, replies, and forward closure.
8. [Resources](./resources.md): parameters, responses, authorization, and errors for profiles, media bytes, and forward closure.
9. [Audio and Video Calls](./calls.md): the standard WebRTC stack, S2S frames, state machine, and AUDIO-to-VIDEO upgrade.
10. [Stable Error Registry](./errors.md): stable error codes, HTTP status, retry behavior, and identity actions.
11. [Machine-readable Release Package](./schema/README.md): JSON Schema, HTTP manifest, positive and negative vectors, and the Conformance CLI.

The Core Protocol defines shared rules. Transport and Security defines the discovery, TLS, and signature profile shared by all operations. Each remaining operation document defines only its body, authorization, state, and idempotency semantics. Together these documents form one versioned release package, whose status applies to the whole package rather than ordinary chapters.

An operation document may tighten a shared rule but cannot weaken transport or identity security. A conflict between normative documents is a specification defect and must be handled according to the precedence rules in the Core Protocol; JSON Schema, examples, and existing implementations must not be used to infer an alternative meaning.

JSON Schema, the HTTP manifest, positive and negative vectors, and the Conformance CLI ship with the normative text as non-normative validation resources. They are not part of runtime negotiation and cannot alter the normative text. Cross-major discovery selects a common major only through `protocolVersions`.

## Authoring and terminology rules

- One term has one meaning. `publisher` publishes a feed or query; `source` identifies its source node; `consumer` consumes it; and `peer` means the remote peer node.
- `recognition` means the bidirectional server-recognition process defined by this protocol, not generalized `trust`. `authorization` means permission for a specific operation and cannot be inferred from recognition alone.
- Normative requirements use complete sentences containing an RFC 2119/RFC 8174 keyword. Explanatory sentences without a keyword do not imply additional requirements.
- Avoid unverifiable conditions such as “appropriate,” “normal,” “as soon as possible,” or “when necessary.” When unavoidable, the same paragraph defines the trigger, observable result, or implementation choice.
- Pronouns must have an unambiguous antecedent. When two servers are involved, use `A`, `B`, or role names.
- Wire fields, enums, HTTP methods, paths, headers, media types, and stable error codes retain their exact spelling.
- Examples and implementation notes must not introduce rules absent from normative text. If translation reveals ambiguity, first resolve and record the semantic decision; translation must not silently choose one interpretation.
