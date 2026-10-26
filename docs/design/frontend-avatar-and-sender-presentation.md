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
  adapts explicit display data (including lookup results) and local editing previews. An absent image is
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

## Source classification at feature boundaries

Rendering from explicit interface data and rendering from a profile demand are
separate contracts, not fallback stages of one contract. A lookup result may
supply display data directly without authorizing a new profile demand. Conversely,
identity/revision facts and empty display placeholders are not a display snapshot.

| Feature surface | Presentation source |
| --- | --- |
| Known contact identity and its invitation dialog | Pinned profile reference through demand rendering |
| Identity lookup results that provide display data | Explicit endpoint display data, without an inferred demand |
| Group invitation search results | Public lookup snapshots; exact addresses and fuzzy searches follow separate query paths |
| Previously sent personal requests and group invitations | Retained send-time request snapshot, never the current profile |
| Incoming request author | The request's author-profile reference, subject to its evidence policy |
| Unsaved cropped avatar | Locally owned object URL; the upload response is a write coordinate only |
| Contact card and its quoted preview | Frozen card content, not the subject's current profile |
| Forwarded sender | Bundle snapshot and carrier-authorized assets |

Group invitation search results retain the public lookup's display snapshot.
Client-side friendship and pending-invitation hints compare the returned account
and receiver-local namespace; they never authorize a write. The server validates
the submitted invitation independently and reports business refusals. A group
roster member's namespace is instead scoped to the group's publisher; it cannot
be substituted for a receiver-local namespace.

Freezing an outgoing request or crossing a native API that requires image bytes
may serialize an avatar. This is an explicit output boundary; live Angular
identity rendering keeps the profile reference instead of converting it into a
mutable avatar-string model. Contact-picker previews use materialized display
text, while the server freezes authoritative contact-card content at send time.

Component request composition and cancellation may use RxJS. The profile-demand
scheduler, cache transactions, shared work ownership, and commit/wake semantics
remain separate concerns; unsubscribing one presentation is not permission to
roll back a committed cache write or cancel another consumer's shared demand.

## Mention candidates

Mention search and presentation are separate stages. Search reads the local
roster joined to the exact selected profile snapshot and matches account or
cached profile name, without authorizing a profile request. The browser uses
IndexedDB; PC WebViews use `native_db_query_group_members`; Android reaches the
same Rust query through JNI. Matching uses locale-independent Unicode lowercase
substring comparison. Departed members and the namespace-qualified self identity
are excluded before limiting the page. Pages sort by namespace and then the
account's Unicode scalar order, matching SQLite BINARY ordering rather than
host-dependent locale collation.

A page contains at most five rows. If the viewer may mention everyone and the
localized audience label matches the query, that row comes first and leaves four
member slots. Otherwise there are five member slots. Empty queries match the
label. Conversation aliases never enter search or group-member presentation.

Each result pins its complete profile reference for the lifetime of that page.
The page does not follow later Group Meta revision selections. Cached names and
avatars, or fallback presentation, appear first; each item's demand can then
update its name and avatar independently. A pending or unavailable member cannot
hold back the other rows. Only another search chooses another set of references.

Web and PC use the common avatar presentation service and paint helpers. Android
uses a Rust-owned page and shared demand subscriptions; Kotlin reports query and
lifecycle facts, decodes image bytes, and paints the delivered results. Rust's
foreground demands and Group Meta prefetch share transport and protocol
validation while retaining their respective commit policies. Native notifications
and mention pages share digest-deduplicated binary avatar assembly. Native avatar
bytes do not travel through WebView object URLs or base64 media messages.

Replacing or closing a page releases its consumers. Shared native demands survive
another consumer's release and stop when their last consumer leaves. Captured
login/cache lifetime fences remain authoritative, and native UI callbacks also
reject stale composer contexts and request IDs. PC profile IPC consumers use the
existing UUID-based HTTP cancellation registry: a registration acknowledgement
prevents cancel-before-registration races, and the last RxJS consumer's
AbortSignal releases only its own Rust subscription. Rust owns PENDING waits for
these native consumers. No separate profile cancellation registry, legacy
whole-page resolution barrier, or WebView-mediated Android mention lookup remains.

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
