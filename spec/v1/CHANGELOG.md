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

- Group invitations are state-feed membership intents and are never timeline messages.
- A CALL record requires `callSid` in its own content.
- `BlobDescriptor.bytes` is the sole declared media-resource length.
- LINK requires string fields `url`, `title`, `description`, and `siteName`; the last three may be empty strings. LINK artwork is generated locally and is not federated.

RC.0 defines a fixed wire surface. All protocol objects and enum sets are closed;
unknown fields and types are malformed, and incompatible wire changes require a
new integer protocol major.
