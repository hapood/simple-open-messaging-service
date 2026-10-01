use crate::{media_cache, ServerSessionState};
use serde::Serialize;
use std::{collections::HashMap, sync::Arc};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::{TcpListener, TcpStream};
use tokio::sync::{OnceCell, RwLock};

const MAX_HEADERS: usize = 16 * 1024;
const MAX_THUMBNAIL: usize = 512 * 1024;
static VIDEO_HUB: OnceCell<Arc<VideoHub>> = OnceCell::const_new();

struct VideoHub {
    port: u16,
    routes: Arc<RwLock<HashMap<String, String>>>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct NativeVideoStream {
    stream_url: String,
    thumbnail_upload_url: String,
    has_thumbnail: bool,
}

/** Register a capability on the process-wide loopback Range server backed by the authoritative Rust
 * media cache. The OS chooses one port once per app process; all videos and concurrent Range requests
 * share that listener. The unguessable route, rather than the port, is the security boundary. */
#[tauri::command]
pub(crate) async fn create_native_video_stream(
    app: tauri::AppHandle,
    proxy: tauri::State<'_, ServerSessionState>,
    path: String,
) -> Result<NativeVideoStream, String> {
    if !valid_source_path(&path) {
        return Err("native video requires a safe /uploads/* path".into());
    }
    let app_for_hub = app.clone();
    let proxy_for_hub = proxy.inner().clone();
    let hub = VIDEO_HUB
        .get_or_try_init(|| async move { start_hub(app_for_hub, proxy_for_hub).await })
        .await?;
    let mut capability = [0u8; 32];
    getrandom::getrandom(&mut capability)
        .map_err(|error| format!("create native video capability: {error}"))?;
    let capability = capability
        .iter()
        .map(|value| format!("{value:02x}"))
        .collect::<String>();
    let video_route = format!("/video/{capability}");
    let thumbnail_route = format!("/thumbnail/{capability}");
    hub.routes.write().await.insert(capability, path.clone());
    let proxy = proxy.inner().clone();
    let has_thumbnail = media_cache::get_video_thumbnail(&app, &proxy, &path)
        .await
        .is_ok();
    Ok(NativeVideoStream {
        stream_url: format!("http://localhost:{}{video_route}", hub.port),
        thumbnail_upload_url: format!("http://localhost:{}{thumbnail_route}", hub.port),
        has_thumbnail,
    })
}

async fn start_hub(app: tauri::AppHandle, proxy: ServerSessionState) -> Result<Arc<VideoHub>, String> {
    let listener = TcpListener::bind(("127.0.0.1", 0))
        .await
        .map_err(|error| format!("bind video loopback: {error}"))?;
    let port = listener
        .local_addr()
        .map_err(|error| format!("read video loopback address: {error}"))?
        .port();
    let routes = Arc::new(RwLock::new(HashMap::new()));
    let hub = Arc::new(VideoHub {
        port,
        routes: routes.clone(),
    });
    tauri::async_runtime::spawn(async move {
        while let Ok((socket, _)) = listener.accept().await {
            let app = app.clone();
            let proxy = proxy.clone();
            let routes = routes.clone();
            tauri::async_runtime::spawn(async move {
                let _ = serve(socket, app, proxy, routes).await;
            });
        }
    });
    Ok(hub)
}

fn valid_source_path(path: &str) -> bool {
    if path.contains("..") || path.contains('\\') || path.contains('#') || path.contains('?') {
        return false;
    }
    let Some(rest) = path.strip_prefix("/uploads/shards/") else {
        return false;
    };
    let parts = rest.split('/').collect::<Vec<_>>();
    if parts.len() != 3 {
        return false;
    }
    let Some((digest, extension)) = parts[2].split_once('.') else {
        return false;
    };
    let lower_hex = |value: &str| {
        value
            .bytes()
            .all(|byte| byte.is_ascii_hexdigit() && !byte.is_ascii_uppercase())
    };
    parts[0].len() == 2
        && parts[1].len() == 2
        && digest.len() == 64
        && !extension.is_empty()
        && extension.bytes().all(|byte| byte.is_ascii_alphanumeric())
        && lower_hex(parts[0])
        && lower_hex(parts[1])
        && lower_hex(digest)
        && digest.starts_with(parts[0])
        && digest[2..].starts_with(parts[1])
}

async fn serve(
    mut socket: TcpStream,
    app: tauri::AppHandle,
    proxy: ServerSessionState,
    routes: Arc<RwLock<HashMap<String, String>>>,
) -> Result<(), String> {
    let mut request = Vec::new();
    let header_end = loop {
        if request.len() >= MAX_HEADERS {
            return respond(&mut socket, 431, "text/plain", &[], &[]).await;
        }
        let mut chunk = [0u8; 2048];
        let read = socket
            .read(&mut chunk)
            .await
            .map_err(|error| format!("read native video request: {error}"))?;
        if read == 0 {
            return Ok(());
        }
        request.extend_from_slice(&chunk[..read]);
        if let Some(index) = request.windows(4).position(|value| value == b"\r\n\r\n") {
            break index + 4;
        }
    };
    let headers = std::str::from_utf8(&request[..header_end])
        .map_err(|_| "native video request headers are not UTF-8".to_string())?;
    let mut lines = headers.split("\r\n");
    let mut request_line = lines.next().unwrap_or("").split_whitespace();
    let method = request_line.next().unwrap_or("");
    let route = request_line.next().unwrap_or("");
    let route_parts = route.split('/').collect::<Vec<_>>();
    let capability = route_parts.get(2).copied().unwrap_or("");
    let source_path = routes.read().await.get(capability).cloned();

    if method == "OPTIONS" && route_parts.len() == 3 && source_path.is_some() {
        return respond(&mut socket, 204, "text/plain", &[], &[]).await;
    }

    if method == "GET" && route_parts.get(1) == Some(&"video") {
        let Some(source_path) = source_path else {
            return respond(&mut socket, 404, "text/plain", &[], &[]).await;
        };
        let range = lines.find_map(|line| {
            line.strip_prefix("Range: ")
                .or_else(|| line.strip_prefix("range: "))
        });
        if let Some(range) = range {
            let media = media_cache::get_or_fetch_range(&app, &proxy, &source_path, range)
                .await
                .map_err(|error| format!("stream cached video range: {error}"))?;
            let mut extra = Vec::new();
            if let Some(value) = media.content_range {
                extra.push(("Content-Range", value));
            }
            if let Some(value) = media.accept_ranges {
                extra.push(("Accept-Ranges", value));
            }
            return respond_owned(
                &mut socket,
                media.status,
                media.content_type.as_deref().unwrap_or("video/mp4"),
                media.bytes,
                extra,
            )
            .await;
        }
        let media = media_cache::get_or_fetch(&app, &proxy, &source_path)
            .await
            .map_err(|error| format!("stream cached video: {error}"))?;
        return respond(
            &mut socket,
            200,
            media.content_type.as_deref().unwrap_or("video/mp4"),
            &media.bytes,
            &[("Accept-Ranges", "bytes")],
        )
        .await;
    }

    if method == "POST" && route_parts.get(1) == Some(&"thumbnail") {
        let Some(source_path) = source_path else {
            return respond(&mut socket, 404, "text/plain", &[], &[]).await;
        };
        let length = headers
            .lines()
            .find_map(|line| {
                line.strip_prefix("Content-Length: ")
                    .or_else(|| line.strip_prefix("content-length: "))
            })
            .and_then(|value| value.trim().parse::<usize>().ok())
            .ok_or_else(|| "video thumbnail request has no content length".to_string())?;
        if length == 0 || length > MAX_THUMBNAIL {
            return respond(&mut socket, 413, "text/plain", &[], &[]).await;
        }
        let mut body = request[header_end..].to_vec();
        while body.len() < length {
            let remaining = length - body.len();
            let mut chunk = vec![0u8; remaining.min(16 * 1024)];
            let read = socket
                .read(&mut chunk)
                .await
                .map_err(|error| format!("read video thumbnail: {error}"))?;
            if read == 0 {
                return respond(&mut socket, 400, "text/plain", &[], &[]).await;
            }
            body.extend_from_slice(&chunk[..read]);
        }
        body.truncate(length);
        media_cache::put_video_thumbnail(&app, &proxy, &source_path, body).await?;
        return respond(&mut socket, 204, "text/plain", &[], &[]).await;
    }

    respond(&mut socket, 404, "text/plain", &[], &[]).await
}

async fn respond(
    socket: &mut TcpStream,
    status: u16,
    content_type: &str,
    body: &[u8],
    extra: &[(&str, &str)],
) -> Result<(), String> {
    let extra = extra
        .iter()
        .map(|(name, value)| format!("{name}: {value}\r\n"))
        .collect::<String>();
    let reason = match status {
        200 => "OK",
        204 => "No Content",
        206 => "Partial Content",
        400 => "Bad Request",
        404 => "Not Found",
        413 => "Payload Too Large",
        416 => "Range Not Satisfiable",
        431 => "Request Header Fields Too Large",
        _ => "Error",
    };
    let head = format!(
        "HTTP/1.1 {status} {reason}\r\nContent-Type: {content_type}\r\nContent-Length: {}\r\nCache-Control: no-store\r\nAccess-Control-Allow-Origin: *\r\nAccess-Control-Allow-Methods: GET, POST, OPTIONS\r\nAccess-Control-Allow-Headers: Content-Type, Range\r\nAccess-Control-Expose-Headers: Accept-Ranges, Content-Length, Content-Range\r\nConnection: close\r\n{extra}\r\n",
        body.len(),
    );
    socket
        .write_all(head.as_bytes())
        .await
        .map_err(|error| format!("write native video response headers: {error}"))?;
    socket
        .write_all(body)
        .await
        .map_err(|error| format!("write native video response body: {error}"))
}

async fn respond_owned(
    socket: &mut TcpStream,
    status: u16,
    content_type: &str,
    body: Vec<u8>,
    extra: Vec<(&'static str, String)>,
) -> Result<(), String> {
    let refs = extra
        .iter()
        .map(|(name, value)| (*name, value.as_str()))
        .collect::<Vec<_>>();
    respond(socket, status, content_type, &body, &refs).await
}

#[cfg(test)]
#[path = "tests/native_video_tests.rs"]
mod tests;
