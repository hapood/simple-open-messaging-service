# Federation quote coordinates

The wire contract is defined in [the message envelope](../../spec/v1/message/envelope.md#7-reference-coordinates).
This document describes the local implementation, not additional protocol rules.

## Durable references

`Message.content.quote` stores `{ seq, namespaceId }`. Namespace zero selects
`Message(threadId, seq)`; a positive namespace selects
`Message(threadId, publisherNamespaceId, originSeq)`. The namespace belongs to the
reference, independently of the containing message. In particular, receipt
backfill must not change a reference's meaning.

On receipt, wire `{ seq: n }` becomes `{ seq: n, namespaceId: capturedPeerNamespace }`;
wire `{ originSeq: n }` becomes `{ seq: n, namespaceId: 0 }`. No target existence
check or numeric remapping is performed. Namespace IDs are never transmitted.
Client-authored replies select a visible local target and store namespace zero.

Existing `{ seq }` rows mean local coordinates. Legacy `{ seq: 0, sourceSeq }`
rows remain readable using the containing message's publisher namespace. These
compatibility rules do not allow legacy `targetSeq` on the wire. No relational
schema change or data rewrite is needed; new writes explicitly bind the namespace.

## Publication and reads

`findStoredQuoteTargets` performs namespace-scoped batch resolution, including
withdrawn targets and retained receipt aliases. The group authority publishes its
local target sequence. A mirror or P2P endpoint publishes local sequence for its
own authors and the receiver's origin sequence for other targets. A known
coordinate is preserved without requiring the target body to exist. Absence is
normal and does not warn or reject inbound messages.

The wire has no null or zero-valued variant: both `seq` and `originSeq` MUST be
positive thread sequences. Neither `{ seq: 0 }` nor `{ originSeq: 0 }` is valid.
Omission of `quoteTarget` and `quoteDigest` denotes an ordinary message rather
than an unresolved reply. This implementation retains known positive coordinates
while their bodies are missing; target existence is not a prerequisite for
accepting a valid reply. Once published, the wire reference remains immutable.
An authority's lost peer-to-local coordinate mapping is a local invariant
violation, not permission to fabricate or silently omit a quote.

Read projection translates references into client-local navigation coordinates
without rewriting durable content. History gaps and progress are selected using
the reference's namespace, not the containing message's namespace. Unpulled
history is PENDING; scanned absent or withdrawn targets are NOT_FOUND. The
existing client mount-triggered resolution dispatcher and SSE delivery remain
the retry and notification mechanism.

Forward bundles use the read-projected target for bundle-local `quoteTargetId`
links. The source `content.quote`, including its namespace, is removed from
snapshot text. A selected target maps to its new bundle-local message ID; an unselected or
absent target maps to zero, following the protocol SHOULD. Import also accepts
positive bundle references without a matching entry. Ordinary text omits `quoteTargetId`. Bundle snapshots
use the same representation before and after federation.
The lab oracle compares resolved message identities, never raw numeric references
across nodes, and reads the reference namespace independently from message origin.
