/** Federated media localize status — the stable wire format shared by the message DTOs, the
 *  attachMediaStatus query field, the MEDIA_STATUS SSE frame, and the localize push. Centralized as a
 *  const object so every reference is `MEDIA_STATUS.READY` (typed + refactor-safe), not a bare literal
 *  scattered across services. Mirrors the frontend's web/src/app/services/model.ts MEDIA_STATUS (same
 *  strings — the wire contract).
 *
 *  - 'ready'       bytes local + authz written → the URL serves 200.
 *  - 'failed'      localize failed / never succeeded → the URL returns 4xx (retryable). A persistent
 *                  backend state (stored in the message's digests + pushed).
 *  - 'downloading' localize in flight. Carried only on a freshly-pulled NEW_MESSAGE frame; the backend
 *                  stores/pushes only the 'ready'|'failed' terminals. The client infers 'downloading'
 *                  optimistically on arrival / manual retry. */
export const MEDIA_STATUS = {
  READY: 'ready',
  DOWNLOADING: 'downloading',
  FAILED: 'failed',
} as const;
export type MediaStatus = (typeof MEDIA_STATUS)[keyof typeof MEDIA_STATUS];
