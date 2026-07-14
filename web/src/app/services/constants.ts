import { computed } from '@angular/core';
import { apiOrigin } from './runtime';

// HTTP base + SSE endpoint, both DERIVED from the live `apiOrigin` signal so they follow a backend
// swap with no reload. In the browser apiOrigin is '' → these are same-origin relative paths
// (dev proxy /api → :3000; prod same-origin path-prefix). Under Tauri the shell injects the absolute
// backend origin via window.__SOMS_API_ORIGIN__ (see runtime.ts) → these are absolute cross-origin
// URLs. Each is read fresh at call time (a computed signal), so `setApiOrigin` repoints every
// HttpClient call, the SSE worker, and every raw fetch the instant the signal updates.
export const apiPrefix = computed(() => `${apiOrigin()}/api/v1`);
// SSE downlink endpoint (GET /api/v1/events, Bearer header auth).
export const sseUrl = computed(() => `${apiPrefix()}/events`);
