use super::model::*;
use serde_json::{json, Value};

const CALL: &str = "00000000-0000-4000-8000-000000000001";
const OTHER: &str = "00000000-0000-4000-8000-000000000002";
const SIGNAL: &str = "00000000-0000-4000-8000-000000000003";
fn start(caller: bool) -> Machine {
    let mut machine = Machine::default();
    let (accepted, _) = machine.command(
        json!({"type":if caller {"initiate"} else {"incoming"},"callSid":CALL,"threadId":1}),
        100,
    );
    assert!(accepted);
    machine
}
fn ready() -> (Machine, String) {
    let mut machine = start(true);
    machine.response(
        "initiate",
        Response {
            ok: true,
            code: 0,
            data: json!({"threadId":1}),
        },
    );
    let (_, effects) = machine.command(json!({"type":"peer-ready","peer":machine.peer}), 100);
    let id = platform(&effects, "create-offer")["id"]
        .as_str()
        .unwrap()
        .to_string();
    (machine, id)
}
fn platform<'a>(effects: &'a [Effect], kind: &str) -> &'a Value {
    effects
        .iter()
        .find_map(|effect| match effect {
            Effect::Platform(value) if value["command"] == kind => Some(value),
            _ => None,
        })
        .unwrap()
}
fn frame(machine: &mut Machine, event: &str, data: Value) -> Vec<Effect> {
    machine
        .command(json!({"type":"frame","event":event,"data":data}), 200)
        .1
}
#[test]
fn canonical_signal_ids_match_the_wire_contract() {
    assert!(canonical_id(CALL));
    assert!(!canonical_id(""));
    assert!(!canonical_id(" 00000000-0000-4000-8000-000000000001"));
    for version in 1..=8 {
        for variant in ["8", "9", "a", "b"] {
            assert!(canonical_id(&format!(
                "00000000-0000-{version}000-{variant}000-000000000000"
            )));
        }
    }
    for invalid in [
        "00000000-0000-0000-0000-000000000000",
        "00000000-0000-9000-8000-000000000000",
        "00000000-0000-4000-7000-000000000000",
    ] {
        assert!(!canonical_id(invalid));
    }
}
#[test]
fn terminal_releases_locally_before_scheduling_remote_report_and_never_ends_another_call() {
    let mut machine = start(true);
    assert!(!machine.command(json!({"type":"end","callSid":OTHER}), 0).0);
    let (_, effects) =
        machine.command(json!({"type":"end","callSid":CALL,"reason":"completed"}), 0);
    assert_eq!(machine.snapshot.phase, "idle");
    let report = effects
        .iter()
        .position(|effect| matches!(effect, Effect::Http { terminal: true, .. }))
        .unwrap();
    let release = effects
        .iter()
        .position(
            |effect| matches!(effect,Effect::Platform(value) if value["command"] == "release"),
        )
        .unwrap();
    assert!(release < report);
    assert!(effects[..report].iter().any(
        |effect| matches!(effect,Effect::Platform(value) if value["snapshot"]["phase"] == "idle")
    ));
    assert!(
        machine
            .command(json!({"type":"initiate","callSid":OTHER,"threadId":1}), 0)
            .0
    );
}
#[test]
fn duplicate_push_and_delayed_push_after_hangup_do_not_ring_again() {
    let mut machine = start(false);
    assert!(
        !machine
            .command(json!({"type":"incoming","callSid":CALL,"threadId":1}), 0)
            .0
    );
    machine.command(json!({"type":"decline","callSid":CALL}), 0);
    assert!(
        !machine
            .command(json!({"type":"incoming","callSid":CALL,"threadId":1}), 0)
            .0
    );
}
#[test]
fn only_the_locally_accepting_device_keeps_the_call_on_account_wide_accept() {
    let mut sibling = start(false);
    frame(
        &mut sibling,
        "CALL_EVENT",
        json!({"callSid":CALL,"type":"accepted"}),
    );
    assert_eq!(sibling.snapshot.phase, "idle");
    let mut callee = start(false);
    callee.command(json!({"type":"accept","callSid":CALL}), 0);
    frame(
        &mut callee,
        "CALL_EVENT",
        json!({"callSid":CALL,"type":"accepted"}),
    );
    assert_eq!(callee.snapshot.phase, "incoming");
    let mut caller = start(true);
    caller.response(
        "initiate",
        Response {
            ok: true,
            code: 0,
            data: json!({}),
        },
    );
    frame(
        &mut caller,
        "CALL_EVENT",
        json!({"callSid":CALL,"type":"accepted"}),
    );
    assert_eq!(caller.snapshot.phase, "connecting");
}
#[test]
fn reconnect_policy_restarts_the_caller_once_and_allows_the_callee_more_time() {
    assert!(CALLEE_RECONNECT_MS > RECONNECT_MS + RECONNECT_RETRY_MS);
    let (mut machine, _) = ready();
    machine.command(json!({"type":"connection","state":"connected"}), 100);
    machine.command(json!({"type":"connection","state":"disconnected"}), 200);
    let effects = machine.timer("reconnect");
    assert!(effects
        .iter()
        .any(|effect| matches!(effect, Effect::Arm("reconnect", RECONNECT_RETRY_MS))));
    machine.timer("reconnect");
    assert_eq!(machine.snapshot.phase, "idle");
    let mut callee = start(false);
    callee.snapshot.phase = "reconnecting".into();
    callee.timer("reconnect");
    assert_eq!(callee.snapshot.phase, "idle");
}
#[test]
fn offer_lane_waits_for_sdp_completion_and_ignores_completed_round_answers() {
    let (mut machine, id) = ready();
    let answer = json!({"callSid":CALL,"kind":"answer","id":SIGNAL,"inReplyTo":id,"payload":"opaque-answer"});
    let effects = frame(&mut machine, "CALL_SIGNAL", answer);
    assert_eq!(platform(&effects, "apply-answer")["id"], id);
    let duplicate = frame(
        &mut machine,
        "CALL_SIGNAL",
        json!({"callSid":CALL,"kind":"answer","id":OTHER,"inReplyTo":id,"payload":"opaque-answer"}),
    );
    assert!(duplicate.is_empty());
    machine.command(json!({"type":"camera-ready","enabled":true,"ok":true}), 0);
    machine.command(
        json!({"type":"answer-applied","id":id,"videoNegotiated":false}),
        0,
    );
    let old = frame(
        &mut machine,
        "CALL_SIGNAL",
        json!({"callSid":CALL,"kind":"answer","id":CALL,"inReplyTo":id,"payload":"opaque-answer"}),
    );
    assert!(old.is_empty());
    assert!(machine.live());
    machine.response(&format!("signal:offer:{id}"), Response::default());
    assert!(
        machine.live(),
        "an old HTTP failure must not end a successor negotiation"
    );
}
#[test]
fn answer_reference_is_required_and_other_signals_reject_even_an_explicit_null_reference() {
    let (mut machine, id) = ready();
    for reference in [Value::Null, json!(""), json!("bad")] {
        assert!(frame(&mut machine,"CALL_SIGNAL",json!({"callSid":CALL,"kind":"answer","id":SIGNAL,"inReplyTo":reference,"payload":"answer"})).is_empty());
    }
    assert!(frame(
        &mut machine,
        "CALL_SIGNAL",
        json!({"callSid":CALL,"kind":"ice","id":SIGNAL,"inReplyTo":null,"payload":"ice"})
    )
    .is_empty());
    assert_eq!(
        platform(
            &frame(
                &mut machine,
                "CALL_SIGNAL",
                json!({"callSid":CALL,"kind":"answer","id":SIGNAL,"inReplyTo":id,"payload":"answer"})
            ),
            "apply-answer"
        )["id"],
        id
    );
}
#[test]
fn callee_buffers_the_original_offer_until_media_is_ready() {
    let mut machine = start(false);
    frame(
        &mut machine,
        "CALL_SIGNAL",
        json!({"callSid":CALL,"kind":"offer","id":SIGNAL,"payload":"opaque-offer"}),
    );
    machine.command(json!({"type":"accept","callSid":CALL}), 0);
    machine.response(
        "accept",
        Response {
            ok: true,
            code: 0,
            data: Value::Null,
        },
    );
    let (_, effects) = machine.command(json!({"type":"peer-ready","peer":machine.peer}), 0);
    assert_eq!(platform(&effects, "apply-offer")["payload"], "opaque-offer");
    assert_eq!(platform(&effects, "apply-offer")["id"], SIGNAL);
}
#[test]
fn stale_peer_callbacks_are_rejected_and_failed_accept_media_can_be_retried_without_another_accept_post(
) {
    let mut machine = start(false);
    machine.command(json!({"type":"accept","callSid":CALL}), 0);
    machine.response(
        "accept",
        Response {
            ok: true,
            code: 0,
            data: Value::Null,
        },
    );
    let old_peer = machine.peer;
    machine.command(
        json!({"type":"media-error","stage":"create-peer","peer":old_peer}),
        0,
    );
    let (_, effects) = machine.command(json!({"type":"accept","callSid":CALL}), 0);
    assert!(!effects
        .iter()
        .any(|effect| matches!(effect,Effect::Http {tag,..} if tag == "accept")));
    assert!(
        !machine
            .command(json!({"type":"peer-ready","peer":old_peer}), 0)
            .0
    );
}
#[test]
fn authoritative_connected_timestamp_replaces_the_media_provisional_time() {
    let (mut machine, _) = ready();
    machine.command(json!({"type":"connection","state":"connected"}), 100);
    frame(
        &mut machine,
        "CALL_EVENT",
        json!({"callSid":CALL,"type":"connected","startedAt":50}),
    );
    assert_eq!(machine.snapshot.started_at, 50);
}
#[test]
fn upgrading_waits_for_verified_sdp_then_commits_the_existing_endpoint() {
    let (mut machine, id) = ready();
    frame(
        &mut machine,
        "CALL_SIGNAL",
        json!({"callSid":CALL,"kind":"answer","id":SIGNAL,"inReplyTo":id,"payload":"answer"}),
    );
    machine.command(json!({"type":"answer-applied","id":id}), 0);
    let (_, effects) = machine.command(json!({"type":"camera-ready","enabled":true,"ok":true}), 0);
    let round = platform(&effects, "create-offer")["id"]
        .as_str()
        .unwrap()
        .to_string();
    frame(
        &mut machine,
        "CALL_SIGNAL",
        json!({"callSid":CALL,"kind":"answer","id":OTHER,"inReplyTo":round,"payload":"answer"}),
    );
    let (_, effects) = machine.command(
        json!({"type":"answer-applied","id":round,"videoNegotiated":true}),
        0,
    );
    assert!(effects.iter().any(
        |effect| matches!(effect,Effect::Http {path,..} if path == "/api/v1/calls/upgrade-video")
    ));
    assert_eq!(machine.snapshot.call_type, "AUDIO");
    machine.response(
        "upgrade",
        Response {
            ok: true,
            code: 0,
            data: Value::Null,
        },
    );
    assert_eq!(machine.snapshot.call_type, "VIDEO");
}
