# SOMFP v1 Conformance

An implementation may claim `SOMFP v1 conformant` and publish `1` in discovery `protocolVersions` only if it fully supports every mandatory behavior in this release package. v1 defines neither partial conformance nor per-chapter negotiation.

## Mandatory specification modules

| Module                  | Dependencies                  | v1 requirement                                            |
| ----------------------- | ----------------------------- | --------------------------------------------------------- |
| Core Protocol           | None                          | Mandatory                                                 |
| Transport and Security  | Core                          | Mandatory                                                 |
| Peer Recognition        | Core, Transport               | Mandatory                                                 |
| State Feed              | Core, Recognition             | Mandatory                                                 |
| Group Meta Feed         | Core, Recognition, State Feed | Mandatory canonical group-origin roster                   |
| Authorized Profile      | Core, Group Meta, Message     | Mandatory account/revision profile lookup                 |
| Group Member Profile    | Core, Group Meta              | Mandatory asymmetric exact-member lookup                  |
| Message Author Profile  | Core, Group Meta, Message     | Mandatory exact-message profile lookup                    |
| Message Query           | Core, Recognition             | Mandatory                                                 |
| Message Tombstone Query | Core, Message                 | Mandatory                                                 |
| Message                 | Core                          | Mandatory, including every v1 content type                |
| Resources               | Core, Message                 | Mandatory                                                 |
| Call Profile            | Core, Transport, Message      | Mandatory S2S signaling and endpoint WebRTC/JSEP behavior |
| Stable Error Registry   | Every operation               | Mandatory                                                 |

JSON Schema, the HTTP manifest, and test vectors are non-normative validation artifacts, but a formal release must not ship with a known conflict between those artifacts and the normative text. Passing these artifacts does not by itself prove compliance with the timing, security, authorization, and durable-state requirements in the normative text.

Call is not a negotiated capability or optional v1 module. Call Profile
conformance is evaluated over the Federation node together with every endpoint
subsystem type for which that deployment supports calling. The local
server-to-endpoint API is outside the SOMFP wire surface, but a node MUST NOT
publish `1` in `protocolVersions` unless those endpoints satisfy all mandatory
WebRTC/JSEP behavior in `calls.md`.

## Recognition lifecycle checks

A conformant recognition state machine must satisfy all of these independently
observable requirements:

- Before sending Recognize, the sender has durably pinned and locally
  recognized the peer and prepared its receive path. It is `establishing`
  while peer acceptance is unknown; proven acceptance preserves `available`
  or `degraded` according to reachability.
- Before returning the first Recognize `OK`, the receiver atomically pins and
  recognizes the signer, accepts the signer's explicit recognition assertion,
  and prepares its receive path. The
  authenticated request supplies reachability, so it becomes `available`.
- Reverse Recognize is optional and, when sent, starts only after the first
  response. Its successful delivery is not a separate ordinary-data gate.
- Every request authenticated from a pinned, locally recognized peer with a
  prepared receive path refreshes reachability before later shape or business
  authorization. This general reachability update does not itself create
  peer-acceptance evidence; positive Health has its separately specified
  acceptance effect.
- A valid Health `available` or `degraded` response is accepted by the requester
  as confirmation that the responder recognizes it and has prepared its receive
  path. This is the same acceptance evidence as valid Recognize `OK`;
  `unavailable` supplies no new acceptance evidence.
- An ordinary recognized-data sender validates local recognition, peer
  acceptance, current reachability, and operation authorization. The receiver
  validates its local recognition and the signer's identity, but does not
  require an earlier Recognize notification.
- Retryable Recognize or transport failure retains pins, receive readiness,
  and proven acceptance. The peer remains `establishing` if acceptance is
  unknown or becomes `degraded` if acceptance is known but reachability fails.
- Health projects the responder's receive readiness and reachability at
  request admission, not necessarily its bilateral lifecycle. A valid request
  may therefore return `degraded` even as it refreshes reachability.

## Independent validation

Run this command from the repository root:

```bash
npm run federation:conformance
```

Validate third-party JSON with:

```bash
npm run federation:conformance -- \
  --schema urn:somfp:v1:call \
  --file ./call.json
```

The CLI reads only the `spec/v1` release package and does not import the SOMS implementation under `src/`. Each implementation maintains its own route, business-code, and state-machine tests; those tests cannot replace independent validation of this release package.
