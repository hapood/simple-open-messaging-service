import { computed } from '@angular/core';

// API base + SSE endpoint. `/api/v1` is a same-origin RELATIVE path in the browser (the dev proxy maps
// /api → :3000; prod serves it same-origin) AND the path prefix the `TauriHttpBackend` matches under the
// Tauri shell to route the request through the Rust `api_request` IPC command (Rust holds the backend
// origin itself, so the prefix is origin-independent there). Each is read fresh at call time (a computed
// signal). The desktop SSE stream is owned by the Rust `sse_*` supervisor (NOT fetched through this URL);
// `sseUrl` is consumed only by the browser SSE worker today.
export const apiPrefix = computed(() => '/api/v1');

// SSE downlink endpoint (GET /api/v1/events).
export const sseUrl = computed(() => `${apiPrefix()}/events`);
