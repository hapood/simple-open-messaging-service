use super::model::canonical_id;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

/// Transport decoding ends here. Each source has a different identity contract; a server
/// fact never borrows the renderer's current media lease.
pub enum Command {
    NewCall {
        incoming: bool,
        data: Value,
    },
    Server {
        call_sid: String,
        data: Value,
    },
    User {
        lease: u64,
        call_sid: String,
        data: Value,
    },
    Media {
        lease: u64,
        peer: u64,
        data: Value,
    },
}

#[derive(Deserialize, Serialize)]
#[serde(tag = "type", rename_all = "kebab-case")]
enum NewCall {
    Initiate(CallIdentity),
    Incoming(CallIdentity),
}

#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct CallIdentity {
    call_sid: String,
    thread_id: i64,
    #[serde(default)]
    peer_user_id: i64,
    #[serde(default)]
    peer_account: String,
    #[serde(default = "unknown_namespace")]
    peer_namespace_id: i64,
    #[serde(default)]
    peer_name: String,
    #[serde(default)]
    peer_avatar: String,
    #[serde(default)]
    call_type: String,
    #[serde(default)]
    source: String,
}
fn unknown_namespace() -> i64 {
    -1
}

#[derive(Deserialize, Serialize)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
enum ServerEventKind {
    CallEvent,
    CallSignal,
}

#[derive(Deserialize)]
#[serde(tag = "type", rename_all = "kebab-case")]
enum ServerFrame {
    Frame { event: ServerEventKind, data: Value },
}

#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct UserInput {
    call_sid: String,
    #[serde(flatten)]
    action: UserAction,
}

#[derive(Deserialize, Serialize)]
#[serde(tag = "type", rename_all = "kebab-case")]
enum UserAction {
    Accept,
    Decline,
    Cancel,
    End { reason: Option<String> },
    Destroy,
    Mute { enabled: bool },
    Speaker { enabled: bool },
    Camera { enabled: bool },
    Upgrade,
    PermissionDenied,
    Signal { kind: String, payload: String },
}

#[derive(Deserialize, Serialize)]
struct MediaInput {
    peer: u64,
    #[serde(flatten)]
    event: MediaEvent,
}

#[derive(Deserialize, Serialize)]
#[serde(
    tag = "type",
    rename_all = "kebab-case",
    rename_all_fields = "camelCase"
)]
enum MediaEvent {
    PeerReady {
        camera_enabled: bool,
    },
    OfferReady {
        id: String,
        payload: String,
    },
    AnswerReady {
        id: String,
        payload: String,
    },
    AnswerApplied {
        id: String,
        video_negotiated: bool,
    },
    LocalIce {
        payload: String,
    },
    Connection {
        state: String,
    },
    MediaError {
        #[serde(default)]
        stage: String,
    },
    CameraReady {
        enabled: bool,
        ok: bool,
        #[serde(default)]
        track_created: bool,
    },
}

#[derive(Deserialize)]
#[serde(untagged)]
enum WireCommand {
    NewCall(NewCall),
    Server(ServerFrame),
    User(UserInput),
    Media(MediaInput),
}

impl Command {
    pub fn decode(lease: u64, value: Value) -> Result<Self, String> {
        let wire: WireCommand = serde_json::from_value(value)
            .map_err(|error| format!("invalid call input: {error}"))?;
        let command = match wire {
            WireCommand::NewCall(call) => {
                let incoming = matches!(call, NewCall::Incoming(_));
                let identity = match &call {
                    NewCall::Initiate(identity) | NewCall::Incoming(identity) => identity,
                };
                if !canonical_id(&identity.call_sid) || identity.thread_id <= 0 {
                    return Err("invalid call identity".into());
                }
                Self::NewCall {
                    incoming,
                    data: serde_json::to_value(call).unwrap(),
                }
            }
            WireCommand::Server(ServerFrame::Frame { event, data }) => {
                let sid = data["callSid"]
                    .as_str()
                    .filter(|sid| canonical_id(sid))
                    .ok_or("invalid server call identity")?
                    .to_owned();
                if matches!(event, ServerEventKind::CallEvent) && data["type"] == "incoming" {
                    return Self::decode(
                        0,
                        json!({"type":"incoming","callSid":sid,
                        "threadId":data["threadId"],"peerUserId":data["callerUserId"].as_i64().unwrap_or(0),
                        "peerAccount":data["callerAccount"].as_str().unwrap_or(""),
                        "peerNamespaceId":data["callerNamespaceId"].as_i64().unwrap_or(-1),
                        "peerName":data["callerName"].as_str().unwrap_or(""),
                        "peerAvatar":data["callerAvatar"].as_str().unwrap_or(""),
                        "callType":data["callType"].as_str().unwrap_or("AUDIO")}),
                    );
                }
                Self::Server {
                    call_sid: sid,
                    data: json!({"type":"frame","event":event,"data":data}),
                }
            }
            WireCommand::User(input) => {
                if !canonical_id(&input.call_sid) {
                    return Err("invalid user call identity".into());
                }
                Self::User {
                    lease,
                    call_sid: input.call_sid.clone(),
                    data: serde_json::to_value(input).unwrap(),
                }
            }
            WireCommand::Media(input) => Self::Media {
                lease,
                peer: input.peer,
                data: serde_json::to_value(input).unwrap(),
            },
        };
        Ok(command)
    }

    pub fn into_data(self) -> Value {
        match self {
            Self::NewCall { data, .. }
            | Self::Server { data, .. }
            | Self::User { data, .. }
            | Self::Media { data, .. } => data,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    const SID: &str = "00000000-0000-4000-8000-000000000001";

    #[test]
    fn each_source_requires_its_own_identity() {
        assert!(Command::decode(1, json!({"type":"mute","enabled":true})).is_err());
        assert!(Command::decode(1, json!({"type":"peer-ready","cameraEnabled":false})).is_err());
        assert!(Command::decode(
            1,
            json!({"type":"frame","event":"UNKNOWN","data":{"callSid":SID}})
        )
        .is_err());
        assert!(
            Command::decode(1, json!({"type":"frame","event":"CALL_EVENT","data":{}})).is_err()
        );
        assert!(matches!(
            Command::decode(
                0,
                json!({"type":"frame","event":"CALL_EVENT","data":{"callSid":SID,"type":"ended"}})
            )
            .unwrap(),
            Command::Server { .. }
        ));
        assert!(matches!(
            Command::decode(2, json!({"type":"connection","peer":3,"state":"connected"})).unwrap(),
            Command::Media {
                lease: 2,
                peer: 3,
                ..
            }
        ));
    }
}
