# Call signaling correlation — review proposal

Status: IMPLEMENTED (2026-10-14). The approved answer correlation, generation-bound ICE and coordinated pre-freeze v1 revision are implemented in the normative Call Profile/schema, backend, Web and Android source. Backend and Web builds/full unit suites, Android compilation/JUnit, 57 call schema vectors and local/federated callee-first browser regressions pass. Android APK/device calling and real network-switch recovery remain NOT VERIFIED. Full federation conformance is blocked by an unrelated existing forward vector. This proposal records the approved design, not a substitute for normative protocol text.

## Scope

Extend the mandatory Call Profile with explicit answer-to-offer correlation and deterministic endpoint handling of ICE generations. Preserve caller-only offer ownership, one incomplete negotiation per call, existing lifecycle operations and opaque SDP/ICE relay.

This proposal complements, rather than replaces, Sections 8–9 of [the current Call Profile](../../spec/v1/calls.md). The current profile already requires serial negotiation and successful remote-answer application before another offer. The implementation must begin honoring that rule through one negotiation coordinator.

## 1. New answer field

Split the offer/answer union. Require an answer-only `inReplyTo` field equal to the original offer's `signalId`:

```ts
type CallSignalPayload =
  | { signalId: CanonicalUuid; signalType: 'offer'; data: SdpText }
  | {
      signalId: CanonicalUuid;
      signalType: 'answer';
      inReplyTo: CanonicalUuid;
      data: SdpText;
    }
  | {
      signalId: CanonicalUuid;
      signalType: 'ice';
      data: JsonText<GenerationBoundIceCandidate>;
    }
  | {
      signalId: CanonicalUuid;
      signalType: 'video-state';
      data: JsonText<VideoState>;
    };
```

- `inReplyTo` is REQUIRED for answer and FORBIDDEN for every other signal type.
- Use the existing canonical lowercase UUID rules; no separate negotiation UUID or sequence counter.
- The offer producer assigns its signal ID before async send. Every relay/retry preserves that ID.
- The answer producer retains the incoming offer identity through buffering, media-permission retries and SDP application; answer creation captures that identity.
- Correlation is scoped to the existing authenticated call binding and roles, not a globally searchable signal ID.
- SDP text remains opaque and byte-preserved. No custom SDP attribute is introduced.

Example (UUIDs abbreviated only here for readability):

```text
caller → callee: offer(signalId=A)
callee → caller: answer(signalId=B, inReplyTo=A)
caller → callee: offer(signalId=C)  // only after answer B applied and stable
callee → caller: answer(signalId=D, inReplyTo=C)
```

## 2. Server acceptance and endpoint application

Preserve the existing Section 11 verification order: authentication and closed-shape validation, binding/tombstone lookup, accepted-ID replay handling, then constraints for a NEW signal.

For a NEW answer, the server verifies its role, permitted lifecycle stage, and reference to the latest admitted caller offer in that call. Permit one logical answer per offer. Unknown/cross-call/superseded offer references, or a second answer with a new ID for an already-answered offer, fail with the existing HTTP 400 `FEDERATION_MALFORMED`; the local API uses its appropriate call-transition error. No new business code is proposed.

An accepted signal ID replay retains existing HTTP 200/code 0 no-op semantics, including replay after a newer negotiation. A missing/invalid field still fails closed-shape validation first. An invalid new answer does not enter deduplication or overwrite staged signaling.

Keep offer identity/answer association separate from staged bodies: clearing initial setup when media connects must not erase the metadata needed for later negotiation. Preserve accepted replay information under the existing live-call/tombstone rules. Server admission of an answer does NOT prove endpoint SDP application succeeded or that the endpoint is stable.

Endpoints apply an answer only when `inReplyTo` equals the active local offer ID, the same call/PC generation is still alive, and JSEP permits the application. They must never apply an unrelated answer as the current one. Known old/duplicate completions have no effect; unexplained conflicting signaling follows the existing failed-negotiation convergence policy. A mismatched answer must not release the current negotiation lock or complete video upgrade.

This does not introduce speculative offer replacement after timeout. While an answer is outstanding, requests queue/coalesce. If a negotiation cannot safely complete, use bounded failure/termination rather than clearing the lock and starting another offer in an ambiguous JSEP state.

## 3. ICE generation — strengthen an existing inner field

Do NOT use offer ID as ICE generation identity: ordinary renegotiation may reuse ICE credentials, whereas ICE restart changes them.

Require `usernameFragment` to be a nonempty ICE username fragment in every endpoint-produced ICE candidate payload. It is currently optional/null in the profile. The endpoint must obtain the candidate's actual local ICE generation and carry it unchanged; it must not substitute whichever generation happens to be current at delivery time. Android must explicitly retain/generate this value even though its native IceCandidate constructor does not accept it.

Endpoint processing binds candidates to the appropriate remote SDP ICE credentials and media section. Candidates that precede their corresponding SDP can be buffered within bounded limits. Known obsolete generations are ignored; candidates must not be fed into the current generation merely because they arrived during it. Ordinary video renegotiation with unchanged credentials continues to accept that generation's candidates. End-of-candidates indications, if emitted, are generation-bound too.

This changes the endpoint profile's inner ICE requirement, not federation payload parsing. Federation servers MUST NOT parse SDP/ICE or reject candidates based on their generation; they validate the outer signal and relay unchanged. Other RTCIceCandidateInit fields and their meaning remain governed by WebRTC/JSEP. No new outer ICE field is proposed.

No missing-usernameFragment fallback is proposed. This is an application interoperability requirement, not a claim that WebRTC itself makes that field mandatory.

## 4. Forwarding, staged retrieval and local contract

Carry `inReplyTo` unchanged through:

- signed federation signal payload;
- local send-signal DTO (answer-only);
- CALL_SIGNAL endpoint delivery;
- staged answer retrieval (`{ id, payload, inReplyTo }`);
- Web and Android pending-offer/answer handling.

Staged offers retain their existing ID. Endpoints must not buffer an offer as SDP text alone. Signal IDs, reference metadata and ICE generation data survive retries unchanged. HTTP success remains server acceptance only.

## 5. Video completion and ICE restart

No new lifecycle operation, generic renegotiation request, or callee ICE-restart request is introduced. Existing caller-owned offer policy remains in force.

The caller may commit the existing `video-upgraded` only after applying the matching answer AND confirming negotiated video capability required by the requested direction. Receiving an arbitrary answer or merely acquiring a camera is insufficient. Caller camera off/callee camera on is supported without prompting for the caller camera.

Do not gate SDP completion or business-type persistence on decoded frame arrival. Render readiness stays independent. ICE restart produces no business upgrade by itself and runs through the same serial negotiation lane with bounded recovery policy.

## 6. Compatibility and publication decision

This is a breaking closed-contract revision: old answers lack the required field, and old endpoints may omit ICE usernameFragment. There is no dual-format compatibility path and no automatic legacy fallback.

Recommended for the current RELEASE CANDIDATE: revise the unreleased v1 Call Profile and schema together and coordinate deployment of servers/Web/Android on all lab nodes. Update release-candidate publication metadata consistently when publishing this revision. `/s2s/v1/call` remains unchanged ONLY under this explicitly pre-release revision policy.

If interoperability with already-published external v1 implementations must be retained, publish a new federation major instead. Do not silently replace a released v1 contract, or merely add a per-call version field while the rest of discovery still advertises indistinguishable v1 support.

## 7. Approved decisions

1. Answer-only `inReplyTo = offer.signalId`, with mandatory closed validation.
2. Generation-bound ICE using mandatory existing `usernameFragment`, no new outer ICE field and no fallback.
3. New-reference validation versus existing accepted-ID replay semantics as specified above.
4. Apply as a coordinated unreleased-v1 RC revision, or choose a new federation major if external released-v1 compatibility is required.

Normative protocol text/schema, backend contracts/relay/staging, Web and Android source were updated together. Deterministic tests cover correlation/replay, serial/coalesced negotiation, ICE generations, preaccept media retry, callee-first video and teardown. Local and federated browser runs confirm callee-first video without caller camera capture, later caller camera enable and normal hangup; prior permission/device retry and camera-resume regressions remain green. Real network-switch recovery and Android device calling still require platform verification on a freshly installed matching APK.
