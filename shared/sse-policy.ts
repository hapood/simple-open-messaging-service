/** Transport-only frames never carry domain state or advance synchronization cursors. */
export const SSE_HEARTBEAT_EVENT = 'heartbeat';
export const SSE_HEARTBEAT_MS = 10_000;
export const SSE_IDLE_TIMEOUT_MS = 30_000;
export const SSE_OPEN_TIMEOUT_MS = 15_000;
