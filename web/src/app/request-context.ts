import { HttpContextToken } from '@angular/common/http';

/**
 * Marks a write request as safe for the native transport to replay once after an origin race.
 *
 * Angular keeps HttpContext client-side, so the browser FetchBackend never sends this metadata to the
 * server. TauriHttpBackend alone reads it and passes it to Rust over IPC. Reads are replay-safe by HTTP
 * method automatically; write calls must opt in only when their server operation has a stable
 * idempotency key or is otherwise explicitly idempotent.
 */
export const REPLAY_SAFE = new HttpContextToken<boolean>(() => false);

/** Suppress the global degraded-network toast for requests whose caller owns a persistent, visible error
 * state. Polling endpoints in particular must not enqueue one snackbar per failed attempt during an outage. */
export const SUPPRESS_HTTP_ERROR_TOAST = new HttpContextToken<boolean>(
  () => false,
);
