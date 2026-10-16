# Group member profile contract audit

Status: clarifications received; fix implemented and covered by unit and
PostgreSQL tests. Retained-lab browser re-verification pending;
business code not committed.

## Resolved clarifications

1. Confirmed coordinates: `publisherNamespaceId` is this server's local
   IdentityNamespace ID for the accepting publisher; `profileNamespaceId` is
   the publisher-scoped subject namespace ID. The publisher is **not**
   required to be the group's authoritative server, so a remote member's
   message stored as `(publisher=peer, subject=0)` is correct as-is; the
   member's local identity must be resolved at the roster/relationship
   layer (publisher-home subject → publisher namespace; third-home subject →
   pinned root-key binding), never by rewriting message coordinates.
2. Confirmed admission boundary: a validated media `STUB` already commits
   selection evidence; only `FAILED` placeholders are excluded. Profile
   snapshot bytes and media bytes are both independent cache concerns.

## Confirmed operator requirements

- Group profile publisher is always the authoritative group server. Subject
  namespace IDs are interpreted in that authority's namespace space.
- Committed message evidence selects a member profile revision by message seq,
  not by revision magnitude.
- Profile fetching/materialization is a separate cache concern; it must not
  gate member Meta revision selection.
- Earlier membership incarnations cannot update a rejoined member reference.
- Clients consume member Meta; restoring the removed client message-anchor
  mechanism is not the chosen repair.

## Observed code paths

### Local message creation

`src/message/message.service.ts:361-593` inserts a local message without
explicit publisher/subject fields, so both default to 0. This path also serves
local submissions in a mirrored group. After commit,
`publishCommittedProfileWork()` forwards the row's publisher and
`creator.namespaceId` into the collector. `stripMessageId():175-182` derives
that creator namespace directly from the stored subject field.

A local origin member at (0,0) is consistent with authority-scoped references.
A local submission on a mirror is not sufficient evidence of the final
accepted reference contract; pending versus confirmed semantics need an
explicit decision rather than an assumed exception.

### Remote submission and replication landing

`src/federation/federation-inbound-message-route.service.ts:107-114` recognizes
a receiver-local author from the peer-assigned namespace and rewrites its
namespace to 0. The same resolved value is returned as the profile namespace
at line 294.

`src/federation/federation-inbound-message-page.service.ts:427-499` passes the
resolved subject and the authenticated source peer's namespace to storage,
then to both profile demand and evidence selection.

`src/federation/federation-inbound-message-store.service.ts:402-407,484-489`
stores publisher = source peer and subject = resolved creator namespace.
Thus the receiving group origin currently stores a member-home submission
as source peer / subject 0. These are current assignments, not validated
canonical group-profile coordinates.

### Outbound publication and receipts

`src/federation/federation-message-feed.service.ts:385-397` preserves an
origin-coordinate returning group copy, but otherwise publishes subject =
stored publisher when the stored subject is 0. The outgoing author namespace
can therefore differ from the stored/raw-client author namespace.

`src/federation/federation-inbound-message-store.service.ts:161-177` also
contains an origin-side receipt comparison that derives an author namespace
from the stored publisher when stored subject is 0. Receipt application at
lines 263-283 writes origin seq/time; it does not rewrite the stored profile
publisher/subject into an authority-scoped pair.

### Source coordinates and profile references currently share a field

`src/database/schema.ts:986-987` defines Message.publisherNamespaceId as the
accepted stream's namespace; `Message_threadId_source_originSeq_key` at
1042-1046 uses it with originSeq for source deduplication. Inbound media and
tombstones also use this source coordinate.

The raw-client projection and committed profile-work collector reuse this
same field as the profile publisher. An audit cannot simply overwrite it
without deciding how source identity remains represented.

### Member selection and cache

`src/profile-resolution/profile-evidence-projection.service.ts:32-37` drops
subject 0 and revision 0. Its only member writer call passes the candidate's
publisher/subject unchanged.

`src/group/meta/publish-member-message-profile-in-tx.ts:106-113` requires a
positive revision's exact Profile snapshot. This is incompatible with the
confirmed cache-independent selection requirement.

The same writer restricts updates to origin groups, validates active member
relationships, checks a join boundary, and allocates a new member Meta feed
coordinate. Those responsibilities must survive the repair.

The newest-message guard at lines 96-104 only looks for newer messages carrying
the same revision. Contract tests must cover delayed different-revision work
as well; passing the stored source-seq check alone is not proof against every
out-of-order completion.

### Ordinary inbound work is not the local-message event path

`src/federation/federation-inbound-message-effects.service.ts:69-86` starts
profile cache resolution and evidence projection independently after landing.
Ordinary inbound message evidence does not depend on the
MESSAGE_PROFILE_WORK_COMMITTED dispatcher used by local messages. An earlier
investigation confused the mirror Meta system-message event with this path.
Both real entry paths must be covered by subsequent contract tests.

### Media admission boundary is unresolved

`src/federation/federation-inbound-message-store.service.ts:398-408` stores
media as STUB. The inbound page's pending branch returns without profile work.
`src/federation/federation-pending-media-promoter.ts:143-152` promotes it to
READY. This audit has not established an equivalent member-evidence emission
on that promotion path. Whether selection belongs at validated STUB admission
or at READY requires business confirmation; profile-cache independence alone
does not decide content-readiness policy.

## Contract-derived acceptance cases (covered)

- Origin-local, remote-member, and third-server messages all expose the
  authority-scoped profile pair. Choose distinct numeric IDs on every server
  so equal fixture numbers cannot conceal a coordinate leak.
- Both origin and two mirrors resolve the same member through the authority's
  subject namespace, including an author whose home is the receiving mirror.
- A missing, delayed, or failed profile cache lookup does not prevent member
  Meta advancement. Subsequent cache insertion changes presentation only,
  not the selected reference or Meta feed ID.
- The actual local commit entry and actual inbound-effects entry both cause
  origin Meta publication; mirrors do not invent their own member Meta facts.
- Revision 0 is a valid selected reference and requires no snapshot.
- Older/equal message seq cannot overwrite newer selection; revision numbers
  may increase or decrease. Include a newer unchanged-revision message and
  delayed older different-revision evidence.
- Leave/kick/rejoin fences old-incarnation work; same-account members from
  different namespaces cannot cross-match.
- Source deduplication, processing receipts, tombstones and media dependencies
  remain correct after any coordinate representation correction.
- Media selection follows the explicit STUB/READY decision above.

## Documentation conflict

`docs/design/profile-version-resolution.md:96-104,211,236,465-467` describes
snapshot-gated member publication. That is not authority for implementation
because it conflicts with the operator's cache-independent selection contract.
A subsequent implementation must update the conflicting design text together
with contract-derived tests, rather than silently preserving that dependency.
