# Recognize Error Unification Review

Status: proposal for operator review. No F03 wire or lifecycle change is approved
by this document. Implementation observations are not normative requirements.

## Scope

Unify Recognize response shapes, HTTP/code classification, asynchronous failure
reporting, and peer lifecycle consequences. Keep a binding-change refusal
distinct from termination of an existing recognized relationship.

## Confirmed conflicts and implementation observations

1. [Recognition Sections 5 and 8](../../spec/v1/recognition.md) define
   `200 {ok:false,status:"failed",code,message}`. The
   [error registry](../../spec/v1/errors.md#error-envelope) requires the common
   error envelope for every non-zero JSON result, except Health and raw media.
   The identity schema currently validates the special `failed` shape.
2. Recognition Section 8.1 gives both `200 failed` and HTTP error envelopes as
   failure paths without an unambiguous mapping for the same failure detected
   synchronously versus asynchronously. Section 8.2 classifies `200 failed` by
   code while the general hard-stop rule requires HTTP `409` plus a fatal code.
3. The error registry lists domain-change rejection (`50028`) as fatal, but its
   hard-stop summary omits that code. Root-change rejection (`50029`) is explicitly
   operation-scoped. Recognition's hard-stop prose also disagrees with its own
   table about blocked peers and unsupported versions.
4. `submitInboundRecognize` in
   [the recognition service](../../src/federation/federation-recognition.service.ts)
   returns bare `failed` for rejected reviews. Its asynchronous verifier catches
   failures, formats them for logging, and removes the in-flight entry; it does
   not retain a general terminal attempt result for a later request. Review and
   namespace state retain some outcomes, but not every signature/discovery/
   admission failure. Repeated requests can therefore keep seeing `pending`.
5. `runRecognize` parses `200 failed` and throws a local `BusinessException`
   with HTTP status `409`, but does not call the peer-halt path. Assigning an
   exception status is not equivalent to receiving a peer's HTTP `409` response.
6. `handleRecognizeHttpFailure` and
   [the shared peer lifecycle helper](../../src/federation/federation-peer-lifecycle.ts)
   halt on exactly `50009`, `50015`, and `50020` with HTTP `409`. Neither includes
   domain-change rejection. This matches neither all Recognition prose nor the
   domain-rejection row in the registry.
7. [The exception filter](../../src/common/exception.filter.ts) maps those three
   fatal codes to `409`, malformed requests to `400`, authentication failures to
   `401`, and temporary failures to `503`. Domain conflict and both review
   rejection codes fall through to `200` if thrown on an S2S route, unlike their
   registry rows, which currently say `409`.
8. [The peer error parser](../../src/federation/federation-errors.ts) accepts
   numeric `code` fields without requiring a safe non-zero integer or a closed
   envelope. Consequently an invalid envelope with extra members can reach fatal
   classification, contrary to the registry's malformed-body rule. A shared
   strict classifier is needed; merely changing the producer shape is insufficient.

## Recommended response contract

Keep the existing successful Recognize result shapes. Remove the extra `failed`
union: every unsuccessful result uses the common error envelope. Its HTTP/code
mapping is identical whether the failure is discovered before the first reply
or reported on a subsequent request after asynchronous work.

| Situation | Proposed HTTP/body | Peer effect | Retry scope |
| --- | --- | --- | --- |
| Verification or administrator review incomplete | `200 {ok:true,status:"pending",message?}` | No new acceptance or namespace disclosure; preserve existing relationship | Bounded retry of the recognition attempt |
| Recognition committed and receive path prepared | `200 {ok:true,status:"recognized",peerAssignedLocalNamespaceId}` | Acceptance and reachability evidence under the normal gates | Idempotent repeats allowed |
| Malformed JSON, headers, or request shape | `400` common error, `FEDERATION_MALFORMED` | Reject this request; no new identity facts | Fix request; do not retry identical invalid bytes |
| Invalid signature, certificate, or binding | `401` common error with the registered code | No pin replacement or peer halt based on authentication failure alone | Correct credentials/request; reconstruct the signed request |
| Temporary discovery, service, or commit failure; rate limiting | `503` common error with `INTERNAL`, `RATE_LIMITED`, or the registered unavailable-identity code | Preserve pin and acceptance; affect reachability, not identity | Bounded backoff; no sticky permanent rejection |
| Proposed domain conflicts with another identity (`50027`) | `200` non-zero common error | Do not activate the proposed binding; preserve existing identity and relationship | Stop that binding attempt until corrected |
| Domain change rejected (`50028`) | `200` non-zero common error | Preserve existing binding, namespace, and acceptance; do not use the rejected domain | Stop automatic retries of that rejected proposal; administrator action required |
| Root change rejected (`50029`) | `200` non-zero common error | Preserve existing pin, namespace, and acceptance; successor traffic remains unauthorized | Stop automatic retries of that rejected proposal; administrator action required |
| Explicit peer block (`50009`), independently established identity contradiction (`50015`), or no common version (`50020`) | `409` common error | Enter `halted`, retain pin and evidence, stop automatic communication | Local administrator action required |
| Unknown code, malformed body, or status/code contradiction | No additional semantics beyond the permitted HTTP class | No acceptance, pin replacement, or inferred fatal action | Diagnose; avoid tight retries |

For `50027` through `50029`, changing the registry's current `409` to `200` is an
intentional draft-contract proposal, not a statement that its current wording
already says this. It makes HTTP `409` exclusively fatal and puts operation-level
refusals alongside other HTTP `200` application failures.

An alternative is to retain nonfatal `409` conflict responses and explicitly
standardize a status-plus-code classifier. That can work, but preserves the
exception that some `409` responses stop one proposal while others halt the
whole relationship. The recommendation above removes that ambiguity.

## Security and lifecycle boundaries

- HTTP `409` alone never authorizes halting. Require the registered fatal code,
  a valid closed error envelope, and provenance from the intended peer over the
  required TLS authority. A locally verified hard conflict remains a separate
  source of halt evidence.
- A fatal-looking code inside HTTP `200`, or inside an invalid envelope, must not
  be promoted into authenticated HTTP `409` evidence by throwing a local error.
- Rejecting a new binding does not prove that the original peer is hostile or
  has revoked acceptance. Keeping acceptance does not authorize traffic under
  an unapproved root/domain, or permit fallback to credentials the peer revoked.
- A pending result must not erase earlier acceptance. Its lack of evidence means
  it cannot create new acceptance, not that it retracts prior evidence.
- Malformed, failed, and pending results must never disclose a newly allocated
  namespace, commit business effects, or advance synchronization cursors.

## Asynchronous outcomes

Returning `pending` is compatible with the recommended contract. A later request
must be able to obtain the completed result rather than starting the same failed
work forever. Results must apply to the actual proposed identity and binding,
not merely to a domain name; a stale rejected proposal cannot poison a corrected
request or an existing predecessor relationship.

Temporary failures must not become permanent negative records. Conversely,
rejected proposals must not be retried automatically forever. The identity and
idempotency details overlap F09 and require an explicit scoping decision.

Implementation work will need to trace result retention, concurrent attempts,
expiry/cancellation, and how later requests consume the outcome. These mechanics
belong in development documentation and code, not in the independent protocol.

## Decisions requested

1. Use only `pending` and `recognized` as successful Recognize results; represent
   every failure with the common error envelope rather than a special `failed`
   body.
2. Put operation-scoped domain conflicts and root/domain review refusals on HTTP
   `200`; reserve registered fatal conflicts for HTTP `409`.
3. Treat both root and domain review refusals as proposal-scoped, preserving the
   existing relationship while refusing the new binding. This changes the current
   normative fatal treatment of domain-change rejection.

No implementation or normative changes should proceed until these decisions
are confirmed. Following confirmation, synchronize Recognition, Errors, Core,
Transport references, identity schema/manifest/examples, producers, consumers,
and strict-classification tests. Include PostgreSQL-backed asynchronous,
retry, stale-result, and concurrent-outcome verification where persistence or
lifecycle changes are involved.
