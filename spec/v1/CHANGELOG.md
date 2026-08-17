# Simple Open Chat Federation Protocol v1 Changelog

## v1.0.0-rc.0

Status: `RELEASE CANDIDATE`

Initial release candidate of the Simple Open Chat Federation Protocol (SOCFP).

- The discovery path is `/.well-known/socfp` and the DNS SRV owner is `_socfp._tcp`.
- JSON Schema IDs use `urn:socfp:v1:*`.
- Signing certificates use `socfp-http-message-signature`.
- Message-entity URIs use the `socfp://` scheme.
- `UserAccount` permits 1–30 characters; a one-character account is a valid wire identity.

The initial message wire format has these constraints:

- A CALL record requires `callSid` in its own content.
- `BlobDescriptor.bytes` is the sole declared media-resource length.
- LINK requires string fields `url`, `title`, `description`, and `siteName`; the last three may be empty strings. LINK artwork is generated locally and is not federated.

RC.0 includes a controlled, non-core extension mechanism:

- `/s2s/v1/discover` publishes `extensions[]` as unilateral receive capabilities; Health reports the subset currently enabled for the peer.
- `/s2s/v1/discover` both returns the receiver's capabilities and delivers an asynchronous, coalescible reverse capability-refresh hint.
- `PROFILE`, `MEMBER_PROFILE`, and `feed-heads` may carry a bounded `extensions` object; core objects remain closed.
- Extension messages use a namespaced `contentType`. A receiver does not persist an unknown type, download its assets, or generate a receipt, but it may advance the message-query cursor.
- The protocol reserves `socfp.*`. Third-party IDs use a reverse-domain prefix, and an incompatible change requires a new `.vN` ID.
