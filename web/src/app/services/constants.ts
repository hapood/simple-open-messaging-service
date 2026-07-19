import { computed } from '@angular/core';
import { apiOrigin, isTauri } from './runtime';

// API base + SSE endpoint, derived from the live `apiOrigin` signal so they follow a backend swap with
// no reload. Each is read fresh at call time (a computed signal), so `setApiOrigin` repoints every
// HttpClient call, the (browser) SSE worker, and every raw fetch the instant the signal updates.
//
// Under the Tauri shell these point at the LOCAL `api://localhost` URI-scheme proxy
// (src-tauri/src/lib.rs `proxy_api`), which forwards the full request to `${apiOrigin}` with the Bearer
// — so the webview never crosses origins (no CORS, no `tauri-plugin-http`). The prefix is fixed under
// Tauri (the proxy reads the live origin itself on every request), independent of the `apiOrigin` signal.
// In the browser `apiOrigin` is '' → these are same-origin relative paths (dev proxy /api → :3000; prod
// same-origin path-prefix). The desktop SSE stream itself is owned by the Rust `sse_*` supervisor and is
// NOT fetched through this URL (sseUrl is only consumed by the browser worker today).
export const apiPrefix = computed(() =>
  isTauri() ? 'api://localhost/api/v1' : `${apiOrigin()}/api/v1`,
);
// SSE downlink endpoint (GET /api/v1/events).
export const sseUrl = computed(() => `${apiPrefix()}/events`);
