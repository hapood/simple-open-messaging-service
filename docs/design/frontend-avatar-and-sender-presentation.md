# Avatar and message-sender presentation

## Boundaries

The frontend separates source selection, asynchronous resolution, display policy,
and painting. Author identity and message grouping are not derived from display
names, images, or presentation colors.

- [AvatarComponent](../../web/src/app/components/user-avatar/avatar.component.ts)
  paints an `AvatarView`: final name, image URL, appearance, opaque color key,
  loading state, and an optional federation badge. It has no session, profile,
  namespace, conversation, or HTTP dependency. Image errors fall back to initials.
- [DemandAvatarComponent](../../web/src/app/components/user-avatar/demand-avatar.component.ts)
  selects an explicit pinned profile or the committed session profile for a self
  avatar. An unresolved or unavailable image does not fall back to an arbitrary
  mutable image URL.
- [SnapshotAvatarComponent](../../web/src/app/components/user-avatar/snapshot-avatar.component.ts)
  adapts fixed display data and local editing previews. An absent image is
  authoritative; snapshots never create profile demands. Request-specific snapshot
  types are adapted by their owning request UI rather than imported by the avatar.
- [The forward adapter](../../web/src/app/components/forward-detail/forward-avatar-source.ts)
  validates an avatar digest against the bundle manifest and binds its URL to the
  carrier's authorization context. Its result has no author identity or inferred
  federation badge. It does not need another rendering component: forwarded rows
  already use the shared message renderer.

The mutually exclusive source variants are defined in
[avatar-source.ts](../../web/src/app/components/user-avatar/avatar-source.ts).
[AvatarPresentationService](../../web/src/app/components/user-avatar/avatar-presentation.service.ts)
resolves them to the same paint model. Namespace-badge resolution does not delay
profile presentation. Source changes synchronously select a fresh initial view;
late asynchronous results cannot paint as another selected source.

## Message sender data and policy

[MessageSenderService](../../web/src/app/components/message-cards/message-sender.service.ts)
produces one live presentation for a mounted message. P2P aliases apply only to a
matching account and namespace in the selected direct thread. They do not override
group authors or snapshot authors. The sender label and avatar initials consume
the same final name.

[message-sender.ts](../../web/src/app/components/message-cards/message-sender.ts)
contains the content-independent layout policy:

| Context | Incoming sender label | Natural avatar |
| ------- | --------------------- | -------------- |
| Direct  | Hidden                | Group head     |
| Group   | Group head            | Group head     |
| Forward | Group head            | Group head     |

Self sender labels are hidden. The existing self-avatar appearance preference
continues to control self-avatar visibility in CSS. Conversation business facts
remain separate from sender display context. Message bodies do not reimplement
the policy for each content type.

Forward snapshots use independent bundle-local message keys for grouping. Equal
names or images are not evidence of a shared author, so each snapshot remains an
independent head.

## Ownership and cleanup

[The virtualized row factory](../../web/src/app/components/message-cards/create-item.ts)
owns one sender subscription per mounted row. Natural, pre-mounted tail, and
sticky avatars consume its same live presentation signal. Sticky geometry selects
placement only; it neither resolves profiles nor serializes profile evidence into
DOM attributes. A weak association connects each mounted host to its presentation.

Content, delivery-status, and layout updates do not restart an unchanged sender
subscription. Replacing the sender clears old presentation immediately and
unsubscribes the old source. Destroying the row releases its subscription.

Profile avatar object URLs are reference-counted by digest. They remain valid
while a mounted presentation leases them and are revoked when their last lease is
released. Completing a cached profile lookup does not prematurely release an image
still on screen. Preview and forward resource URLs remain owned by their sources.

The avatar capability introduces no account epoch or HTTP-session interception.
Existing application session, transport, and database lifecycle mechanisms are
outside this rendering boundary.

The existing integer-height virtual-scroll contract is preserved: avatar hosts
fill their sized slots, row geometry still uses `offsetHeight`, and no new row
shell or measurement-dependent wrapper is introduced.
