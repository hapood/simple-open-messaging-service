# Simple Open Chat Federation Protocol v1 Changelog

## v1.0.0-rc.0

Status: `RELEASE CANDIDATE`

Initial release candidate of the Simple Open Chat Federation Protocol (SOCFP).

- State relationships use one account-generic `RELATIONSHIP_INTENT`. User/user
  and user/group pairs share directional authorization and reverse matching;
  group/group pairs are invalid.
- State items expose no implementation-only subject fields.
  `RELATIONSHIP_INTENT.localAccount` identifies the consumer-hosted endpoint;
  its domain comes from the receiving authority.
- An effective `REQUESTED` immediately authorizes the target peer to query its
  publisher's new thread, while the reverse query remains independently gated.
- Crossed requests and a valid peer `ACCEPTED` both upgrade a matching local
  `REQUESTED` to a newly published `ACCEPTED`; an already accepted direction
  publishes no echo in response to another `ACCEPTED`. A new effective peer
  `REQUESTED` re-indexes an unchanged local `ACCEPTED`. After every acceptance,
  the publisher repairs any missing or stale profile/group dependency while
  reusing effective snapshots already at the current business revision.
- Initiating or accepting creates a local placeholder account and thread;
  received one-sided requests remain address-only until local action.
- State publication after acceptance is ordered as `ACCEPTED`, `PROFILE`,
  `GROUP_META`, then the complete `MEMBER_PROFILE` closure.
- Profile, group-meta, and member-profile keys are removed after their last
  visibility source disappears. Expired requests and retained revocations may
  be compacted as historical cleanup.
- Thread message and deletion sequences stop at `SafeInteger - 1`, reserving
  `SafeInteger` as the maximum exclusive reverse-query cursor.
- Thread addresses no longer repeat a `type` discriminator or peer domains.
  Account grammar selects P2P versus GROUP: P2P carries the source-hosted
  `account` and target-hosted `localAccount`, while GROUP carries only its
  globally unique `!` account and remains scoped to the target peer.
- State-feed validation resources enforce the normative 30-code-point display
  name, 120-code-point biography, and 255-code-point relationship-note limits.

- The discovery path is `/.well-known/socfp` and the DNS SRV owner is `_socfp._tcp`.
- JSON Schema IDs use `urn:socfp:v1:*`.
- Signing certificates use `socfp-http-message-signature`.
- Message-entity URIs use the `socfp://` scheme.
- `UserAccount` permits 1–30 characters; a one-character account is a valid wire identity.

The initial message wire format has these constraints:

- Group invitations are state-feed membership intents and are never timeline messages.
- A CALL record requires `callSid` in its own content.
- `BlobDescriptor.bytes` is the sole declared media-resource length.
- LINK requires string fields `url`, `title`, `description`, and `siteName`; the last three may be empty strings. LINK artwork is generated locally and is not federated.

RC.0 defines a fixed wire surface. All protocol objects and enum sets are closed;
unknown fields and types are malformed, and incompatible wire changes require a
new integer protocol major.
