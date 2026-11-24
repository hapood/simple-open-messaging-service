/** Transport-only frames never carry domain state or advance synchronization cursors. */
export const SSE_HEARTBEAT_EVENT = 'heartbeat';
export const SSE_HEARTBEAT_MS = 10_000;
export const SSE_IDLE_TIMEOUT_MS = 30_000;
export const SSE_OPEN_TIMEOUT_MS = 15_000;
/** Maximum wire-text length of one frame, in UTF-16 code units. */
export const SSE_MAX_FRAME_CHARS = 1_048_576;
