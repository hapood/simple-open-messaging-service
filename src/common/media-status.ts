/** Federated media localize status — the stable wire format shared by message DTOs and the
 *  attachMediaStatus query field. Centralized as a const object so every reference is
 *  `MEDIA_STATUS.READY` (typed + refactor-safe), not a bare literal scattered across services.
 *  Mirrors the frontend's web/src/app/services/model.ts MEDIA_STATUS (same strings — the wire contract).
 *
 *  - 'ready'       bytes local + authz written → the URL serves 200.
 *  - 'pending'     a durable inbound job exists but has not started transferring.
 *  - 'failed'      local materialization failed; the visible FAILED placeholder is retryable.
 *  - 'downloading' local materialization is in progress; the visible STUB owns its final seq. */
export const MEDIA_STATUS = {
  READY: 'ready',
  PENDING: 'pending',
  DOWNLOADING: 'downloading',
  FAILED: 'failed',
} as const;
export type MediaStatus = (typeof MEDIA_STATUS)[keyof typeof MEDIA_STATUS];
