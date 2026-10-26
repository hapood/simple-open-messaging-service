use crate::login_connection::LoginConnection;
use crate::proxy::{
    is_network_failure, race_origin_candidates, read_body_with_inactivity_timeout,
};
use crate::{ServerSessionState, API_BODY_INACTIVITY_TIMEOUT, API_HEADERS_TIMEOUT};
use std::sync::Arc;

/// A network intent carries its login, credential, clients and endpoint candidates through every
/// await and retry. No request can resolve successor credentials or publish global origin changes.
#[derive(Clone)]
pub(crate) struct LoginRequest {
    owner: Arc<LoginConnection>,
    credential: String,
    active: (String, reqwest::Client),
    primary: (String, reqwest::Client),
    secondary: Option<(String, reqwest::Client)>,
}

/// A stream and its receipts use the same captured route and client, never a global pool lookup.
#[derive(Clone)]
pub(crate) struct LoginEndpoint {
    pub origin: String,
    pub credential: String,
    pub client: reqwest::Client,
}

pub(crate) struct LoginRequestResult {
    pub(crate) status: u16,
    pub(crate) headers: std::collections::HashMap<String, String>,
    pub(crate) body: String,
}

impl LoginRequest {
    pub(crate) fn endpoint(&self) -> Result<LoginEndpoint, String> {
        self.owner.assert_active().map_err(|e| e.to_string())?;
        Ok(LoginEndpoint {
            origin: self.active.0.clone(),
            credential: self.credential.clone(),
            client: self.active.1.clone(),
        })
    }

    pub(crate) fn endpoint_mode(&self) -> crate::OriginMode {
        if self
            .secondary
            .as_ref()
            .is_some_and(|route| route.0 == self.active.0)
        {
            crate::OriginMode::Secondary
        } else {
            crate::OriginMode::Primary
        }
    }

    pub(crate) fn at_endpoint(&self, endpoint: &LoginEndpoint) -> Self {
        let mut request = self.clone();
        request.active = (endpoint.origin.clone(), endpoint.client.clone());
        request
    }

    /// Selection is private to the captured intent; neither probes nor the winner mutate globals.
    pub(crate) async fn select_endpoint(&self) -> Option<(LoginEndpoint, crate::OriginMode)> {
        self.owner.assert_active().ok()?;
        let secondary = self.secondary.as_ref()?;
        let (origin, mode) = race_origin_candidates(&self.primary.0, &secondary.0).await?;
        self.owner.assert_active().ok()?;
        let client = if origin == self.primary.0 {
            &self.primary.1
        } else {
            &secondary.1
        };
        Some((
            LoginEndpoint {
                origin,
                credential: self.credential.clone(),
                client: client.clone(),
            },
            mode,
        ))
    }

    pub(crate) fn capture(
        proxy: &ServerSessionState,
        owner: Arc<LoginConnection>,
    ) -> Result<Self, String> {
        let credential = owner.credential().map_err(|e| e.to_string())?;
        let active = proxy
            .api_origin
            .lock()
            .map_err(|_| "origin lock poisoned")?
            .clone();
        let primary = proxy
            .api_origin_primary
            .lock()
            .map_err(|_| "primary lock poisoned")?
            .clone();
        let secondary = proxy
            .api_origin_secondary
            .lock()
            .map_err(|_| "secondary lock poisoned")?
            .clone();
        let route = |origin: String| {
            let client = proxy.api_client(&origin);
            (origin, client)
        };
        let request = Self {
            owner,
            credential,
            active: route(active),
            primary: route(primary),
            secondary: secondary.map(route),
        };
        request.owner.assert_active().map_err(|e| e.to_string())?;
        Ok(request)
    }

    /// UUID equality is insufficient: a restarted process may restore a different physical owner.
    pub(crate) fn assert_owner(&self, owner: &Arc<LoginConnection>) -> Result<(), String> {
        if !Arc::ptr_eq(&self.owner, owner) {
            return Err("native request owner mismatch".into());
        }
        self.owner.assert_active().map_err(|e| e.to_string())
    }

    pub(crate) async fn get(&mut self, path: String) -> Result<LoginRequestResult, String> {
        self.send(reqwest::Method::GET, path, None).await
    }

    /// Read-only JSON queries may use POST because their filters do not fit URL parameters.
    /// These must be replay-safe queries, never mutation commands.
    pub(crate) async fn post_query(
        &mut self,
        path: String,
        body: Vec<u8>,
    ) -> Result<LoginRequestResult, String> {
        self.send(reqwest::Method::POST, path, Some(body)).await
    }

    /// Match ordinary API deadlines and one reachability replay while keeping failover local.
    async fn send(
        &mut self,
        method: reqwest::Method,
        path: String,
        body: Option<Vec<u8>>,
    ) -> Result<LoginRequestResult, String> {
        self.owner.assert_active().map_err(|e| e.to_string())?;
        let cancellation = self.owner.cancellation();
        let result = tokio::select! {
            biased;
            _ = cancellation.cancelled() => Err("native login superseded".into()),
            response = self.send_inner(method, path, body) => response,
        };
        self.owner.assert_active().map_err(|e| e.to_string())?;
        result
    }

    async fn send_inner(
        &mut self,
        method: reqwest::Method,
        path: String,
        body: Option<Vec<u8>>,
    ) -> Result<LoginRequestResult, String> {
        for attempt in 0..=1 {
            let mut request = self
                .active
                .1
                .request(method.clone(), format!("{}{}", self.active.0, path))
                .bearer_auth(&self.credential);
            if let Some(body) = &body {
                request = request
                    .header("content-type", "application/json")
                    .header("accept", "application/json")
                    .body(body.clone());
            }
            let response = tokio::time::timeout(API_HEADERS_TIMEOUT, request.send()).await;
            let upstream = match response {
                Ok(Ok(response)) => response,
                failure => {
                    let reachability_failure = match &failure {
                        Err(_) => true,
                        Ok(Err(error)) => is_network_failure(error),
                        Ok(Ok(_)) => unreachable!(),
                    };
                    if reachability_failure && attempt == 0 {
                        if let Some(secondary) = &self.secondary {
                            if let Some((origin, _)) =
                                race_origin_candidates(&self.primary.0, &secondary.0).await
                            {
                                self.active = if origin == self.primary.0 {
                                    self.primary.clone()
                                } else {
                                    secondary.clone()
                                };
                                continue;
                            }
                        }
                    }
                    return match failure {
                        Err(_) => Ok(LoginRequestResult {
                            status: 504,
                            headers: Default::default(),
                            body: "Gateway Timeout".into(),
                        }),
                        Ok(Err(error)) => Err(format!("api_request send: {error}")),
                        Ok(Ok(_)) => unreachable!(),
                    };
                }
            };
            let status = upstream.status().as_u16();
            let headers = upstream
                .headers()
                .iter()
                .filter_map(|(name, value)| {
                    if matches!(
                        name.as_str(),
                        "transfer-encoding"
                            | "connection"
                            | "keep-alive"
                            | "content-encoding"
                            | "content-length"
                    ) {
                        return None;
                    }
                    value
                        .to_str()
                        .ok()
                        .map(|value| (name.to_string(), value.to_string()))
                })
                .collect();
            let bytes = read_body_with_inactivity_timeout(
                upstream.bytes_stream(),
                API_BODY_INACTIVITY_TIMEOUT,
                None,
            )
            .await?;
            return Ok(LoginRequestResult {
                status,
                headers,
                body: String::from_utf8_lossy(&bytes).into_owned(),
            });
        }
        unreachable!()
    }
}

#[cfg(test)]
#[path = "tests/login_request_tests.rs"]
mod tests;
