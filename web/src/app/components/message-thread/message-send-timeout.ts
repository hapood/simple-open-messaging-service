/** Client-side deadline for a small, non-media message request. A timeout means the write
 * outcome is unknown; retries must keep the original clientMessageId. */
export const MESSAGE_SEND_TIMEOUT_MS = 45_000;

/** Media staging has the same small-request deadline. File transfer itself is progress-bound. */
export const MEDIA_STAGE_TIMEOUT_MS = 45_000;
