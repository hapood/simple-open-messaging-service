import { apiOrigin } from './runtime';

// HTTP base: same-origin relative path in the browser (dev proxy /api → :3000; prod same-origin
// path-prefix). Under Tauri, the shell injects the absolute backend origin (window.__SOMS_API_ORIGIN__)
// so the bundled webview reaches the API cross-origin. See runtime.ts.
export const apiPrefix = `${apiOrigin}/api/v1`
// SSE downlink endpoint (GET /api/v1/events, Bearer header auth).
export const sseUrl = `${apiPrefix}/events`
