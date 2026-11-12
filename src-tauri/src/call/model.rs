use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::collections::{HashSet, VecDeque};

pub const RECONNECT_MS: u64 = 15_000;
pub const RECONNECT_RETRY_MS: u64 = 10_000;
pub const CALLEE_RECONNECT_MS: u64 = 30_000;
pub const ANSWER_FETCH_MS: u64 = 3_000;
pub const NEGOTIATION_MS: u64 = 60_000;

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum TerminalReason {
    Busy,
    Unreachable,
    Failed,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct Snapshot {
    pub phase: String,
    pub call_sid: Option<String>,
    pub thread_id: i64,
    pub peer_user_id: i64,
    pub peer_name: String,
    pub peer_avatar: String,
    pub peer_account: String,
    pub peer_namespace_id: i64,
    pub call_type: String,
    pub is_caller: bool,
    pub media_state: String,
    pub step: String,
    pub started_at: i64,
    pub muted: bool,
    pub speaker_enabled: bool,
    pub camera_enabled: bool,
    pub remote_camera_enabled: bool,
    pub video_upgrade_state: String,
    pub terminal_reason: Option<TerminalReason>,
}

impl Default for Snapshot {
    fn default() -> Self {
        Self {
            phase: "idle".into(),
            call_sid: None,
            thread_id: 0,
            peer_user_id: 0,
            peer_name: String::new(),
            peer_avatar: String::new(),
            peer_account: String::new(),
            peer_namespace_id: -1,
            call_type: "AUDIO".into(),
            is_caller: false,
            media_state: "new".into(),
            step: String::new(),
            started_at: 0,
            muted: false,
            speaker_enabled: false,
            camera_enabled: false,
            remote_camera_enabled: false,
            video_upgrade_state: "idle".into(),
            terminal_reason: None,
        }
    }
}

#[derive(Clone, Debug)]
pub enum Effect {
    Platform(Value),
    Http {
        tag: String,
        path: String,
        body: Option<Value>,
        terminal: bool,
    },
    Arm(&'static str, u64),
    Cancel(&'static str),
    Retire,
}

#[derive(Clone, Debug, Default)]
pub struct Response {
    pub ok: bool,
    pub code: i64,
    pub data: Value,
}

struct Offer {
    id: String,
    applying: bool,
    video: bool,
    sending: bool,
    receiving: bool,
}

/// The sole call policy owner. Effects contain explicit media/OS commands; the host reports facts.
/// A reducer never performs I/O, making terminal ordering and stale media callbacks deterministic.
#[derive(Default)]
pub struct Machine {
    pub snapshot: Snapshot,
    pub lease: u64,
    pub peer: u64,
    media_ready: bool,
    media_creating: bool,
    accepting: bool,
    accepted: bool,
    restart_tried: bool,
    local_offer: Option<Offer>,
    remote_offer: Option<(String, String)>,
    pending_offer: Option<Value>,
    pending_ice: Vec<String>,
    completed_offers: HashSet<String>,
    seen_signals: HashSet<String>,
    queued_video: bool,
    queued_restart: bool,
    retired: VecDeque<String>,
    last_answer_sent: Option<String>,
}

pub fn canonical_id(id: &str) -> bool {
    uuid::Uuid::parse_str(id).is_ok_and(|uuid| {
        uuid.to_string() == id
            && (1..=8).contains(&uuid.get_version_num())
            && uuid.get_variant() == uuid::Variant::RFC4122
    })
}

impl Machine {
    pub fn accepts_identity(&self, data: &Value) -> bool {
        let sid = string(data, "callSid");
        canonical_id(sid)
            && number(data, "threadId") > 0
            && !self.retired.iter().any(|retired| retired == sid)
    }
    pub fn live(&self) -> bool {
        self.snapshot.call_sid.is_some() && self.snapshot.phase != "idle"
    }
    pub fn can_ring(&self) -> bool {
        self.snapshot.phase == "incoming" && !self.accepting
    }
    fn publish(&self, out: &mut Vec<Effect>) {
        out.push(Effect::Platform(
            json!({"command":"snapshot", "snapshot":self.snapshot}),
        ));
    }
    fn platform(&self, out: &mut Vec<Effect>, mut command: Value) {
        command["peer"] = json!(self.peer);
        out.push(Effect::Platform(command));
    }
    fn http(
        &self,
        out: &mut Vec<Effect>,
        tag: &str,
        endpoint: &str,
        mut body: Value,
        terminal: bool,
    ) {
        body["callSid"] = json!(self.snapshot.call_sid);
        out.push(Effect::Http {
            tag: tag.into(),
            path: format!("/api/v1/calls/{endpoint}"),
            body: Some(body),
            terminal,
        });
    }
    fn signaling(&self, out: &mut Vec<Effect>) {
        if let Some(sid) = &self.snapshot.call_sid {
            out.push(Effect::Http {
                tag: "staged".into(),
                path: format!("/api/v1/calls/{sid}/signaling"),
                body: None,
                terminal: false,
            });
        }
    }
    fn signal(
        &self,
        out: &mut Vec<Effect>,
        kind: &str,
        payload: &str,
        id: Option<&str>,
        reply: Option<&str>,
    ) {
        let mut body = json!({"id":id.map(str::to_owned).unwrap_or_else(|| uuid::Uuid::new_v4().to_string()),
            "kind":kind,"payload":payload});
        if let Some(reply) = reply {
            body["inReplyTo"] = json!(reply);
        }
        let tag = match kind {
            "offer" => format!("signal:offer:{}", id.unwrap_or_default()),
            "answer" => format!("signal:answer:{}", reply.unwrap_or_default()),
            _ => format!("signal:{kind}"),
        };
        self.http(out, &tag, "signal", body, false);
    }
    fn reset(&mut self, out: &mut Vec<Effect>, terminal: Option<(&str, Option<&str>)>) {
        if !self.live() {
            return;
        }
        self.snapshot.phase = "ended".into();
        self.snapshot.step.clear();
        self.publish(out);
        self.platform(
            out,
            json!({"command":"release", "callSid":self.snapshot.call_sid}),
        );
        let report = terminal.map(|(endpoint, reason)| {
            let mut body = json!({"callSid":self.snapshot.call_sid});
            if let Some(reason) = reason {
                body["endReason"] = json!(reason);
            }
            Effect::Http {
                tag: "terminal".into(),
                path: format!("/api/v1/calls/{endpoint}"),
                body: Some(body),
                terminal: true,
            }
        });
        let lease = self.lease;
        let peer = self.peer;
        let mut retired = std::mem::take(&mut self.retired);
        if let Some(sid) = &self.snapshot.call_sid {
            retired.push_back(sid.clone());
        }
        while retired.len() > 128 {
            retired.pop_front();
        }
        *self = Self {
            lease,
            peer,
            retired,
            ..Self::default()
        };
        self.publish(out);
        // Return to idle before even scheduling the remote report: hanging HTTP never keeps us busy.
        if let Some(report) = report {
            out.push(report);
        }
        out.push(Effect::Retire);
    }
    fn fail(&mut self, out: &mut Vec<Effect>) {
        if self.snapshot.is_caller
            && matches!(
                self.snapshot.phase.as_str(),
                "starting" | "calling" | "ringing"
            )
        {
            self.reset(out, Some(("cancel", None)));
        } else {
            self.reset(out, Some(("end", Some("failed"))));
        }
    }
    fn seed(&mut self, data: &Value, caller: bool, out: &mut Vec<Effect>) {
        self.lease += 1;
        self.peer += 1;
        self.snapshot = Snapshot {
            phase: if caller { "starting" } else { "incoming" }.into(),
            call_sid: Some(string(data, "callSid").into()),
            thread_id: number(data, "threadId"),
            peer_user_id: number(data, "peerUserId"),
            peer_name: string(data, "peerName").into(),
            peer_avatar: string(data, "peerAvatar").into(),
            peer_account: string(data, "peerAccount").into(),
            peer_namespace_id: data["peerNamespaceId"].as_i64().unwrap_or(-1),
            call_type: if data["callType"] == "VIDEO" {
                "VIDEO"
            } else {
                "AUDIO"
            }
            .into(),
            is_caller: caller,
            remote_camera_enabled: data["callType"] == "VIDEO",
            ..Snapshot::default()
        };
        self.publish(out);
    }
    fn create_peer(&mut self, out: &mut Vec<Effect>) {
        self.peer += 1;
        self.media_ready = false;
        self.media_creating = true;
        out.push(Effect::Http {
            tag: "ice-servers".into(),
            path: "/api/v1/calls/ice-servers".into(),
            body: None,
            terminal: false,
        });
    }
    fn offer(&mut self, out: &mut Vec<Effect>, video: bool, restart: bool) {
        if !self.media_ready || !self.snapshot.is_caller || self.local_offer.is_some() {
            return;
        }
        let id = uuid::Uuid::new_v4().to_string();
        self.local_offer = Some(Offer {
            id: id.clone(),
            applying: false,
            video,
            sending: self.snapshot.camera_enabled,
            receiving: self.snapshot.remote_camera_enabled,
        });
        self.platform(out, json!({"command":"create-offer","id":id,"video":video || self.snapshot.call_type == "VIDEO", "restart":restart}));
        out.push(Effect::Arm("negotiation", NEGOTIATION_MS));
    }
    fn drain(&mut self, out: &mut Vec<Effect>) {
        if self.local_offer.is_some() || !self.media_ready || !self.snapshot.is_caller {
            return;
        }
        let restart = std::mem::take(&mut self.queued_restart);
        let video = std::mem::take(&mut self.queued_video);
        if restart || video {
            self.offer(out, video, restart);
        }
    }

    pub fn command(&mut self, data: Value, now: i64) -> (bool, Vec<Effect>) {
        let mut out = Vec::new();
        let kind = string(&data, "type");
        if matches!(kind, "initiate" | "incoming") {
            if !self.accepts_identity(&data) {
                return (false, out);
            }
            if self.live() {
                if kind != "incoming" || self.snapshot.phase != "starting" {
                    return (false, out);
                }
                self.reset(&mut out, Some(("cancel", None)));
            }
            self.seed(&data, kind == "initiate", &mut out);
            if kind == "initiate" {
                self.http(
                    &mut out,
                    "initiate",
                    "initiate",
                    json!({"threadId":self.snapshot.thread_id,"callType":self.snapshot.call_type}),
                    false,
                );
                self.platform(&mut out, json!({"command":"start-outgoing"}));
            } else {
                self.http(&mut out, "ringing", "ringing", json!({}), false);
                self.platform(&mut out, json!({"command":"ring","snapshot":self.snapshot}));
            }
            return (true, out);
        }
        if !self.live() {
            return (false, out);
        }
        if let Some(sid) = data["callSid"].as_str() {
            if Some(sid) != self.snapshot.call_sid.as_deref() {
                return (false, out);
            }
        }
        if let Some(peer) = data["peer"].as_u64() {
            if peer != self.peer {
                return (false, out);
            }
        }
        match kind {
            "accept" => {
                if self.snapshot.is_caller
                    || self.accepting && !self.accepted
                    || self.media_ready
                    || self.media_creating
                {
                    return (false, out);
                }
                self.accepting = true;
                self.publish(&mut out);
                self.platform(&mut out, json!({"command":"stop-ring"}));
                if self.accepted {
                    self.create_peer(&mut out);
                } else {
                    self.http(&mut out, "accept", "accept", json!({}), false);
                }
            }
            "decline" | "cancel" => self.reset(&mut out, Some((kind, None))),
            "end" => self.reset(&mut out, Some(("end", data["reason"].as_str()))),
            "destroy" | "detach" => self.reset(&mut out, None),
            "frame" => {
                if data["event"] == "CALL_SIGNAL" {
                    self.receive_signal(&data["data"], &mut out);
                } else {
                    self.lifecycle(&data["data"], now, &mut out);
                }
            }
            "peer-ready" => {
                if self.media_ready {
                    return (false, out);
                }
                self.media_ready = true;
                self.media_creating = false;
                self.snapshot.camera_enabled = data["cameraEnabled"] == true;
                if self.snapshot.is_caller {
                    self.offer(&mut out, false, false);
                } else {
                    self.snapshot.phase = "connecting".into();
                    if let Some(offer) = self.pending_offer.take() {
                        self.apply_offer(&offer, &mut out);
                    } else {
                        self.signaling(&mut out);
                    }
                    for payload in self.pending_ice.drain(..).collect::<Vec<_>>() {
                        self.platform(&mut out, json!({"command":"ice","payload":payload}));
                    }
                }
                self.publish(&mut out);
            }
            "offer-ready" => {
                if self
                    .local_offer
                    .as_ref()
                    .is_some_and(|offer| offer.id == string(&data, "id"))
                {
                    self.signal(
                        &mut out,
                        "offer",
                        string(&data, "payload"),
                        data["id"].as_str(),
                        None,
                    );
                    self.snapshot.step = "offer-sent".into();
                    self.publish(&mut out);
                    out.push(Effect::Arm("answer", ANSWER_FETCH_MS));
                }
            }
            "answer-ready" => {
                if self
                    .remote_offer
                    .as_ref()
                    .is_some_and(|offer| offer.0 == string(&data, "id"))
                {
                    self.signal(
                        &mut out,
                        "answer",
                        string(&data, "payload"),
                        None,
                        data["id"].as_str(),
                    );
                    self.snapshot.step = "answer-sent".into();
                    self.publish(&mut out);
                    self.last_answer_sent = Some(string(&data, "id").into());
                    self.remote_offer = None;
                    out.push(Effect::Cancel("negotiation"));
                }
            }
            "answer-applied" => {
                if self
                    .local_offer
                    .as_ref()
                    .is_some_and(|offer| offer.id == string(&data, "id") && offer.applying)
                {
                    let offer = self.local_offer.take().unwrap();
                    self.completed_offers.insert(offer.id);
                    out.push(Effect::Cancel("negotiation"));
                    out.push(Effect::Cancel("answer"));
                    if offer.video {
                        if data["videoNegotiated"] == true {
                            self.http(&mut out, "upgrade", "upgrade-video", json!({}), false);
                        } else {
                            self.snapshot.video_upgrade_state = "failed".into();
                        }
                    }
                    if matches!(self.snapshot.phase.as_str(), "calling" | "ringing") {
                        self.snapshot.phase = "connecting".into();
                        self.snapshot.step = "answer-received".into();
                    }
                    self.publish(&mut out);
                    self.drain(&mut out);
                }
            }
            "local-ice" => self.signal(&mut out, "ice", string(&data, "payload"), None, None),
            "connection" => {
                self.snapshot.media_state = string(&data, "state").into();
                match string(&data, "state") {
                    "connected" => {
                        out.push(Effect::Cancel("reconnect"));
                        if self.local_offer.is_none() {
                            out.push(Effect::Cancel("answer"));
                        }
                        if self.snapshot.phase != "connected" {
                            self.snapshot.phase = "connected".into();
                            self.snapshot.started_at = now;
                            self.snapshot.step.clear();
                        }
                        if !self.snapshot.is_caller {
                            self.http(&mut out, "connected", "connected", json!({}), false);
                        }
                        self.publish(&mut out);
                    }
                    "disconnected" => {
                        if self.snapshot.phase == "connected" {
                            self.snapshot.phase = "reconnecting".into();
                        }
                        self.publish(&mut out);
                        out.push(Effect::Arm(
                            "reconnect",
                            if self.snapshot.is_caller {
                                RECONNECT_MS
                            } else {
                                CALLEE_RECONNECT_MS
                            },
                        ));
                    }
                    "failed" => self.fail(&mut out),
                    _ => self.publish(&mut out),
                }
            }
            "media-error" => {
                if data["stage"] == "create-peer"
                    && !self.snapshot.is_caller
                    && self.remote_offer.is_none()
                {
                    self.media_ready = false;
                    self.media_creating = false;
                    self.platform(&mut out, json!({"command":"dispose-peer"}));
                    self.snapshot.video_upgrade_state = if self.snapshot.call_type == "VIDEO" {
                        "failed"
                    } else {
                        "idle"
                    }
                    .into();
                    self.publish(&mut out);
                } else {
                    self.fail(&mut out);
                }
            }
            "mute" | "speaker" => {
                let enabled = data["enabled"] == true;
                if kind == "mute" {
                    self.snapshot.muted = enabled;
                } else {
                    self.snapshot.speaker_enabled = enabled;
                }
                self.platform(&mut out, json!({"command":kind,"enabled":enabled}));
                self.publish(&mut out);
            }
            "camera" | "upgrade" => {
                if kind == "upgrade"
                    && !matches!(self.snapshot.phase.as_str(), "connected" | "reconnecting")
                {
                    return (false, out);
                }
                let enabled = kind == "upgrade" || data["enabled"] == true;
                if enabled {
                    self.snapshot.video_upgrade_state = "upgrading".into();
                    self.publish(&mut out);
                }
                self.platform(&mut out, json!({"command":"camera","enabled":enabled}));
            }
            "camera-ready" => {
                let enabled = data["enabled"] == true;
                self.snapshot.camera_enabled = enabled;
                if data["ok"] == false {
                    self.snapshot.video_upgrade_state = "failed".into();
                } else {
                    self.signal(
                        &mut out,
                        "video-state",
                        &json!({"enabled":enabled}).to_string(),
                        None,
                        None,
                    );
                    self.snapshot.video_upgrade_state =
                        if enabled && self.snapshot.call_type == "AUDIO" {
                            "upgrading"
                        } else {
                            "idle"
                        }
                        .into();
                    if enabled
                        && self.snapshot.is_caller
                        && (data["trackCreated"] == true || self.snapshot.call_type == "AUDIO")
                    {
                        self.queued_video = true;
                        self.drain(&mut out);
                    }
                }
                self.publish(&mut out);
            }
            "permission-denied" => {
                self.snapshot.video_upgrade_state = "failed".into();
                self.publish(&mut out);
            }
            "signal" if data["kind"] == "video-state" => self.signal(
                &mut out,
                "video-state",
                string(&data, "payload"),
                None,
                None,
            ),
            _ => return (false, out),
        }
        (true, out)
    }

    fn lifecycle(&mut self, data: &Value, now: i64, out: &mut Vec<Effect>) {
        if data["callSid"].as_str() != self.snapshot.call_sid.as_deref() {
            return;
        }
        match string(data, "type") {
            "ringing" if self.snapshot.is_caller && self.snapshot.phase == "calling" => {
                self.snapshot.phase = "ringing".into();
                self.snapshot.step.clear();
                self.publish(out);
            }
            "accepted" => {
                if !self.snapshot.is_caller && !self.accepting {
                    self.reset(out, None);
                } else if self.snapshot.is_caller
                    && matches!(self.snapshot.phase.as_str(), "calling" | "ringing")
                {
                    self.snapshot.phase = "connecting".into();
                    self.publish(out);
                    out.push(Effect::Arm("answer", ANSWER_FETCH_MS));
                }
            }
            "connected" => {
                self.snapshot.phase = "connected".into();
                self.snapshot.step.clear();
                let started = number(data, "startedAt");
                if started > 0 {
                    self.snapshot.started_at = started;
                } else if self.snapshot.started_at == 0 {
                    self.snapshot.started_at = now;
                }
                self.publish(out);
            }
            "video-upgraded" => {
                self.snapshot.call_type = "VIDEO".into();
                self.snapshot.video_upgrade_state = "idle".into();
                self.snapshot.step.clear();
                self.publish(out);
            }
            "declined" | "cancelled" | "missed" | "ended" => self.reset(out, None),
            _ => {}
        }
    }
    fn apply_offer(&mut self, data: &Value, out: &mut Vec<Effect>) {
        let id = string(data, "id");
        let sdp = string(data, "payload");
        if self.snapshot.is_caller {
            return;
        }
        if self.remote_offer.is_some() {
            self.fail(out);
            return;
        }
        self.last_answer_sent = None;
        self.remote_offer = Some((id.into(), sdp.into()));
        self.platform(out,json!({"command":"apply-offer","id":id,"payload":sdp,"video":self.snapshot.call_type == "VIDEO" || self.snapshot.camera_enabled || self.snapshot.remote_camera_enabled}));
        out.push(Effect::Arm("negotiation", NEGOTIATION_MS));
    }
    fn receive_signal(&mut self, data: &Value, out: &mut Vec<Effect>) {
        if data["callSid"].as_str() != self.snapshot.call_sid.as_deref() {
            return;
        }
        let id = string(data, "id");
        let kind = string(data, "kind");
        let payload = string(data, "payload");
        if !canonical_id(id) || payload.is_empty() || self.seen_signals.len() >= 4096 {
            return;
        }
        let reply = data.get("inReplyTo");
        if (kind == "answer" && !reply.and_then(Value::as_str).is_some_and(canonical_id))
            || (kind != "answer" && reply.is_some())
        {
            return;
        }
        if !self.seen_signals.insert(id.into()) {
            return;
        }
        match kind {
            "video-state" => {
                let Ok(state) = serde_json::from_str::<Value>(payload) else {
                    return;
                };
                if state
                    .as_object()
                    .map(|object| object.len() != 1)
                    .unwrap_or(true)
                {
                    return;
                }
                let Some(enabled) = state["enabled"].as_bool() else {
                    return;
                };
                self.snapshot.remote_camera_enabled = enabled;
                if enabled && self.snapshot.call_type == "AUDIO" {
                    self.snapshot.video_upgrade_state = "upgrading".into();
                }
                if enabled && self.snapshot.is_caller && self.media_ready {
                    self.queued_video = true;
                    self.drain(out);
                }
                self.publish(out);
            }
            "offer" => {
                if self.snapshot.is_caller {
                    return;
                }
                if !self.media_ready {
                    if self
                        .pending_offer
                        .as_ref()
                        .is_some_and(|offer| offer["id"] != id)
                    {
                        self.fail(out);
                        return;
                    }
                    self.pending_offer = Some(data.clone());
                    self.snapshot.step = "offer-received".into();
                    self.publish(out);
                } else {
                    self.apply_offer(data, out);
                }
            }
            "answer" if self.snapshot.is_caller => {
                let reply = reply.and_then(Value::as_str).unwrap_or_default();
                if self.completed_offers.contains(reply) {
                    return;
                }
                let Some(offer) = self.local_offer.as_mut() else {
                    self.fail(out);
                    return;
                };
                if offer.id != reply {
                    self.fail(out);
                    return;
                }
                if offer.applying {
                    return;
                }
                offer.applying = true;
                let sending = offer.sending;
                let receiving = offer.receiving;
                self.platform(out,json!({"command":"apply-answer","id":reply,"payload":payload,"sending":sending,"receiving":receiving}));
            }
            "ice" => {
                if self.media_ready {
                    self.platform(out, json!({"command":"ice","payload":payload}));
                } else if payload.len() <= 16_384 && self.pending_ice.len() < 256 {
                    self.pending_ice.push(payload.into());
                }
            }
            _ => {}
        }
    }
    pub fn timer(&mut self, kind: &str) -> Vec<Effect> {
        let mut out = Vec::new();
        if !self.live() {
            return out;
        }
        match kind {
            "reconnect" if self.snapshot.phase == "reconnecting" => {
                if self.snapshot.is_caller && !self.restart_tried && self.media_ready {
                    self.restart_tried = true;
                    self.queued_restart = true;
                    self.drain(&mut out);
                    out.push(Effect::Arm("reconnect", RECONNECT_RETRY_MS));
                } else {
                    self.fail(&mut out);
                }
            }
            "answer"
                if self
                    .local_offer
                    .as_ref()
                    .is_some_and(|offer| !offer.applying) =>
            {
                self.signaling(&mut out)
            }
            "negotiation" if self.local_offer.is_some() || self.remote_offer.is_some() => {
                self.fail(&mut out)
            }
            _ => {}
        }
        out
    }
    pub fn response(&mut self, tag: &str, response: Response) -> Vec<Effect> {
        let mut out = Vec::new();
        if !self.live() {
            return out;
        }
        match tag {
            "initiate" if self.snapshot.phase == "starting" => {
                if !response.ok {
                    self.snapshot.terminal_reason = Some(match response.code {
                        70004 => TerminalReason::Busy,
                        70006 => TerminalReason::Unreachable,
                        _ => TerminalReason::Failed,
                    });
                    self.reset(&mut out,Some(("cancel",None)));
                } else {
                    self.snapshot.thread_id = response.data["threadId"].as_i64().unwrap_or(self.snapshot.thread_id);
                    self.snapshot.phase = "calling".into(); self.publish(&mut out); self.create_peer(&mut out);
                }
            }
            "accept" => {
                if !response.ok { self.reset(&mut out,None); }
                else {
                    self.accepted = true;
                    self.platform(&mut out,json!({"command":"accepted"})); self.create_peer(&mut out);
                }
            }
            "ice-servers" => self.platform(&mut out,json!({"command":"create-peer","video":self.snapshot.call_type == "VIDEO", "iceServers":response.data["iceServers"].as_array().cloned().unwrap_or_default()})),
            "staged" if response.ok => {
                let half = if self.snapshot.is_caller {"answer"} else {"offer"};
                if let Some(mut signal) = response.data[half].as_object().cloned().map(Value::Object) {
                    signal["callSid"] = json!(self.snapshot.call_sid); signal["kind"] = json!(half);
                    self.receive_signal(&signal,&mut out);
                }
                if let Some(ice) = response.data["ice"].as_array() {
                    for signal in ice {
                        let Some(object) = signal.as_object() else { continue; };
                        let mut signal = Value::Object(object.clone()); signal["callSid"] = json!(self.snapshot.call_sid); signal["kind"] = json!("ice");
                        self.receive_signal(&signal,&mut out);
                    }
                }
            }
            "upgrade" => {
                if response.ok { self.snapshot.call_type = "VIDEO".into(); self.snapshot.video_upgrade_state = "idle".into(); }
                else { self.snapshot.video_upgrade_state = "failed".into(); }
                self.publish(&mut out);
            }
            tag if !response.ok && tag.starts_with("signal:offer:") => {
                if self.local_offer.as_ref().is_some_and(|offer| tag.strip_prefix("signal:offer:") == Some(offer.id.as_str())) { self.fail(&mut out); }
            }
            tag if !response.ok && tag.starts_with("signal:answer:") => {
                if tag.strip_prefix("signal:answer:") == self.last_answer_sent.as_deref() { self.fail(&mut out); }
            }
            _ => {},
        }
        out
    }
}

fn string<'a>(value: &'a Value, key: &str) -> &'a str {
    value[key].as_str().unwrap_or_default()
}
fn number(value: &Value, key: &str) -> i64 {
    value[key].as_i64().unwrap_or_default()
}
