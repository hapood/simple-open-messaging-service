# v1.0.0-rc.0 candidate corrections

This non-normative change record identifies candidate corrections before the
v1 wire contract is frozen. The operation specifications define the requirements.

- Relationship confirmation now explicitly requires an initialization
  `THREAD_CONTENT_HEAD` ordered after the authored `ACCEPTED` acknowledgement,
  even when passive access or unchanged sequence bounds already exist. An
  effective one-way intent still permits history queries before that head.
- Member homes may publish both `USER_RETRACTION` and `MODERATION_REMOVAL` to
  the group origin for messages authored by their own accounts. This expands
  the previously stated member-home publication scope. Receivers apply valid
  tombstones from a publisher authoritative for the target; rejection of an
  invalid or out-of-scope fact requires no notification to its publisher.
- Message envelopes distinguish the GET request signer from the response
  publisher, and specify receipts returned to the direct publisher, including
  third-party-authored group messages returned by a mirror to the group origin.
  Group origins may include those receipts in forward and reverse queries with
  `includeSelf=true`; the former mandatory submission-only filter is removed.
  P2P forward-asset requests reconstruct the author from
  `authorRef` rather than requiring an absent `author` field.
- Group Meta retrieval does not block State Feed cursor progress. Its target
  remains pending, and dependent content remains unexposed until it is covered.
- Positive Relationship Intent vectors include both required sequence bounds;
  State Feed cursor vectors use decimal strings, and Group Meta vectors use
  JSON integer coordinates. Cursor-unavailable errors distinguish State Feed
  strings from Group Meta and thread-query integers without overlapping schema
  alternatives. Negative timestamp vectors include the otherwise required
  fields so they exercise the intended timestamp rule.
