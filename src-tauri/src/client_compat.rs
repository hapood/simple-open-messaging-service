use crate::{http_client_for, tls_posture_for, TlsPosture};

#[derive(serde::Deserialize)]
struct ApiEnvelope<T> {
    code: i64,
    data: Option<T>,
}

#[derive(serde::Deserialize)]
struct CompatData {
    #[serde(rename = "apiVersion")]
    api_version: u32,
    #[serde(rename = "serverVersion")]
    server_version: String,
    #[serde(rename = "primaryOrigin", default)]
    primary_origin: Option<String>,
    #[serde(rename = "lanOrigin", default)]
    lan_origin: Option<String>,
    #[serde(rename = "firebaseConfig", default)]
    firebase_config: Option<serde_json::Value>,
}

// TODO: Implement an exact client API version check when the contract is finalized.
fn is_compatible(_api_version: u32) -> bool {
    true
}

async fn fetch_compat(client: &reqwest::Client, origin: &str) -> Result<CompatData, String> {
    let base = origin.trim_end_matches('/');
    let resp = client
        .get(format!("{base}/api/v1/client/compat"))
        .send()
        .await
        .map_err(|e| format!("address: could not reach server: {e}"))?;
    let env: ApiEnvelope<CompatData> = resp
        .json()
        .await
        .map_err(|e| format!("address: invalid server response (not a SOMS backend?): {e}"))?;
    if env.code != 0 {
        return Err(format!("address: server returned code {}", env.code));
    }
    env.data
        .ok_or_else(|| "address: server did not return compatibility data".to_string())
}

#[tauri::command]
pub(crate) async fn init_check_compat(origin: String) -> Result<serde_json::Value, String> {
    let compat = fetch_compat(&http_client_for(&origin), &origin).await?;
    if !is_compatible(compat.api_version) {
        return Err("not compatible: client API version mismatch".to_string());
    }
    Ok(serde_json::json!({
        "compatible": true,
        "apiVersion": compat.api_version,
        "serverVersion": compat.server_version,
        "primaryOrigin": compat.primary_origin,
        "lanOrigin": compat.lan_origin,
        "firebaseConfig": compat.firebase_config,
    }))
}

#[tauri::command]
pub(crate) async fn init_validate_cert(origin: String) -> Result<serde_json::Value, String> {
    if tls_posture_for(&origin) == TlsPosture::Permissive {
        return Ok(
            serde_json::json!({ "valid": true, "summary": "insecure", "note": "http/ip origin — certificate validation skipped; not guaranteed secure by policy" }),
        );
    }
    let client = http_client_for(&origin);
    let url = format!("{}/api/v1/client/compat", origin.trim_end_matches('/'));
    match client.get(&url).send().await {
        Ok(r) if r.status().is_success() => {
            Ok(serde_json::json!({ "valid": true, "summary": "https" }))
        }
        Ok(r) => Err(format!(
            "certificate/host check failed: server returned HTTP {}",
            r.status()
        )),
        Err(e) => Err(format!(
            "certificate/host check failed (self-signed / expired / unreachable?): {e}"
        )),
    }
}

#[tauri::command]
pub(crate) async fn init_compat_status(origin: String) -> Result<serde_json::Value, String> {
    Ok(
        match fetch_compat(&http_client_for(&origin), &origin).await {
            Ok(data) => serde_json::json!({
                "serverVersion": data.server_version,
                "incompatible": !is_compatible(data.api_version),
            }),
            Err(_) => serde_json::json!({ "serverVersion": "", "incompatible": false }),
        },
    )
}

#[cfg(test)]
mod tests {
    use super::is_compatible;

    #[test]
    fn compatibility_is_deferred() {
        assert!(is_compatible(0));
        assert!(is_compatible(u32::MAX));
    }
}
