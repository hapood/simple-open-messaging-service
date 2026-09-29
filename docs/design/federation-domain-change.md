# Domain re-binding

## Motivation

Identity is the namespace, not the domain. Once every stored fact, authorization, cursor, and
profile reference is keyed by namespace coordinates, a server may legitimately rename its public
domain: it keeps its root key, its namespaces, and all relationships, and only its routing name
changes. The wire contract for the arrival is defined normatively in
`spec/v1/recognition.md` Section 4.4; this document records the server design.

The arrival reuses `POST /s2s/v1/recognize`. A separate endpoint would need its own
authentication context whose only difference is "resolve the signer by root key instead of by
domain". Reusing recognize also gives the recipient a natural polling surface: while validation or
review is incomplete it returns `pending`, after approval it returns `recognized`, and after a
recorded rejection it returns `failed` with the stable rejection code.

## Wire flow

Peer B moved from `b.example` to `c.example`. B still holds its root key and its database.

1. B signs `POST /s2s/v1/recognize` from `c.example`, with body `{"namespaceId": N}` where `N` is
   the namespace B's local store assigned to A (the sender-assigned local namespace B disclosed in a
   prior epoch), or `{}` if B holds none.
2. A accepts the attempt into an in-memory single-flight verifier and immediately returns
   `{"ok":true,"status":"pending","message":"verification in progress"}`. This response is only a
   receipt: it discloses no namespace and gives B no acceptance evidence.
3. The verifier fetches the well-known document from `c.example` (hostname-verified) and validates
   the signature. This fetch proves B controls the new domain.
4. A matches the presented root key byte-for-byte against its unretired namespaces. The partial
   unique index on `rootKeyFingerprint` (`retiredAt IS NULL`) guarantees at most one match.
5. The match `N_A` is bound to `b.example`, not `c.example`: a domain re-binding arrival.
   - If the `namespaceId` member is present it must equal the
     `peerAssignedLocalNamespaceId` recorded on `N_A` — the sender-assigned
     local namespace B allocated for A; a conflict is
     `FEDERATION_IDENTITY_MISMATCH` (fail closed: key possession plus a wrong
     relationship coordinate is contradictory evidence).
   - If `c.example` is bound to another peer or under review on one: `FEDERATION_DOMAIN_CONFLICT`.
6. A records an `IdentityNamespace` for `c.example` with `trustLevel = 'pending'` and the verified root evidence.
   Ordinary data-plane admission remains closed and no namespace is disclosed.
7. Repeated Recognize attempts from B return `pending` until an administrator decides.
8. The administrator approves by calling the existing namespace activation endpoint,
   `setActive(c.example, namespaceId)`. Approval promotes `pending` to `degraded` and sends a reverse
   Recognize from A to B. The next Recognize/Health convergence can then make the peer `available`.
9. If local administration rejects the arrival, later Recognize attempts return
   `{"ok":false,"status":"failed","code":50028,"message":"domain re-binding rejected"}`.

The old binding stays functional while the re-binding is pending if B still serves the old domain.
Pending review does not change old recognition facts, cursors, mirrors, or authorizations. A newer
arrival from a different domain may replace local review state according to local policy.

## Recipient-side identity resolution order

The recognize verifier resolves an accepted attempt as follows:

```text
accept attempt -> return pending
  -> fetch signer-domain well-known and verify signature
  -> fingerprint match against unretired IdentityNamespace rows
       no match   : signer domain unknown -> ordinary first recognition candidate
                    signer domain pinned with another root -> FEDERATION_IDENTITY_MISMATCH
       match N    : N bound to signer domain -> ordinary recognition candidate
                    N bound to another domain -> domain re-binding candidate
```

A final ordinary recognition candidate may return `recognized` after commit. A domain re-binding
candidate remains `pending` until administrator approval. The `at most one live namespace per root
key` constraint makes the match deterministic; two live rows with the same fingerprint must be
impossible by schema, not by discipline.

## Storage

No pending namespace column is used. Pending review is represented by an ordinary peer row whose
lifecycle is `pending`:

```ts
IdentityNamespace: {
  domain: 'c.example',
  id: N_A,
  active: true,
  trustLevel: 'pending',
  recognizesPeer: true,
  localServiceAvailable: true,
  peerAcceptanceConfirmed: false,
  remoteServiceReachable: false,
}
```

`IdentityNamespace` stores the verified root evidence and the namespace coordinate. The admin peer
list shows `trustLevel = 'pending'`; the namespace list shows the candidate namespace and whether it
is active for that peer.

In-memory single-flight prevents duplicated verifier work for the same signer domain during one
process lifetime. It is not durable scheduling: after restart, a repeated Recognize attempt starts a
new verifier. Durable `pending` rows survive restart and continue to appear in the admin list.

## Administrator surface

Under the existing admin federation controller:

```text
POST admin/federation/peers                 (pending peers surface in the peer list)
POST admin/federation/peers/:domain/namespaces
POST admin/federation/peers/:domain/namespaces/active
```

`setActive(domain, namespaceId)` is the approval action. It runs one transaction:

1. `FOR NO KEY UPDATE` the pending peer row and candidate namespace.
2. Verify the peer is still `pending`, the namespace belongs to the peer, is unretired, and carries
   complete pinned root evidence.
3. Set the selected namespace `active = true` and the previous namespace `active = false`.
4. Promote `trustLevel` to `degraded`.
5. Keep `peerAcceptanceConfirmed = false` and `remoteServiceReachable = false` until reverse
   recognition or Health proves reciprocal acceptance and reachability.
6. Insert the peer-state pull cursor for the namespace.
7. Write the admin audit row.
8. After commit, send reverse Recognize to the peer domain.

There is no dedicated approve/reject endpoint. Rejection is local administration over the pending
peer state and event log; after rejection, later Recognize attempts return the `failed` result with
`FEDERATION_DOMAIN_CHANGE_REJECTED`.

## Required schema adjustments

Domain mutability is what makes these changes necessary (they are part of this redesign, not a
follow-up):

- Foreign keys from peer-owned state reference `IdentityNamespace.id` only; every composite
  `(domain, id)` foreign key is removed. Historical rows keep their original domain values: they are
  provenance, and mixing pre- and post-rebinding domains under one namespace is expected.
- `IdentityNamespace` has the partial unique index on `rootKeyFingerprint` for live rows, and the
  `peerAssignedLocalNamespaceId` column.
- `IdentityNamespace.trustLevel` includes `pending`.
- Retired namespaces keep their historical domain: that identity was verified under that name at
  that time. Only the live namespace follows the peer when activation requires it.

## Outbound side: this server renames itself

When the local configured domain changes, the server must announce itself to every peer that holds
its recognition:

1. After startup with the new domain, enumerate peers with an active namespace and accepted
   recognition.
2. Call each peer's `recognize` from the new domain, carrying the
   `IdentityNamespace.id` the local store allocated for that peer (the
   sender-assigned local namespace; peer rows are keyed by the peer's domain,
   so they survive the local domain change).
3. Interpret `pending` as "delivered, not yet recognized": keep retrying Recognize with backoff,
   keep the data plane closed toward that peer, and surface the list of unacknowledged peers to the
   local administrator. The optional `message` is for human display only and has no protocol
   branching semantics.
4. Interpret `recognized` as acceptance and update the retained peer-assigned namespace from the
   response.
5. Interpret `failed` by its stable `code`; `FEDERATION_DOMAIN_CHANGE_REJECTED` is a hard rejection
   that requires local administrative handling.

## Security analysis

The final `recognized` result proves, in one exchange:

- possession of the root-authorized signing key pinned for the matched namespace (signature
  verification against the well-known fetched from the new domain);
- control of the new domain's discovery endpoint (the hostname-verified fetch itself);
- retention of the sender-assigned local namespace, when the `namespaceId` member is present
  and equal.

The initial `pending` result proves none of those facts. It is a receipt that prevents a long
blocking request while keeping namespace disclosure and data-plane admission closed.

An attacker holding only the key cannot serve well-known at the new domain; an attacker controlling
only the domain cannot match the pinned root; an attacker with both but a stolen-or-stale database
fails the sender-assigned local namespace check. Rebinding never inherits anything automatically: activation is an administrator
decision, recorded as an audit event, and reversible only by another administrative action.

DoS bounds: in-memory single-flight coalesces duplicate verifier work per signer domain; durable
review has one pending lifecycle row per candidate domain; arrivals are idempotent;
`FEDERATION_DOMAIN_CONFLICT` short-circuits contested targets; the recognize rate limits still apply.
