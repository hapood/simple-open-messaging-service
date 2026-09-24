# Federated Relationship Discovery

## Identity resolution

`GET /user/resolve-federated-stream` resolves one exact Address and returns a
temporary user card. The result contains no relationship state. Resolving a
remote Address must not create a local account stub or write a request.

## Relationship state in clients

After resolving an Address, Web reads its synchronized local projections. An
active P2P thread means `FRIEND`. Otherwise, an unexpired `REQUESTED` friend
request projection means `OUTGOING_PENDING` or `INCOMING_PENDING` according to
its direction. If neither exists, the state is `NONE`. Exact Address matching
is required for transient federated cards, whose user ID is zero.

The client request projection folds the two directed intent facts and terminal
request effects. A rejection may leave a historical record of the original
`REQUESTED` fact, but that record is not the current effective direction. The
later rejection changes the synchronized request projection to `REJECTED`.
Under the federation State Feed rules, receiving a peer-authored `REVOKED`
also revokes the receiver's own still-effective positive direction; retaining
history does not preserve its authorization. A new authored request supersedes
the earlier terminal effect. Search and invitation controls therefore follow
the client projection, not a retained historical intent record.

All signed-in devices receive the same relationship-intent feed and rebuild
their own local projections. The federation test harness observes incoming
requests through that feed rather than treating identity resolution as a
relationship query.
