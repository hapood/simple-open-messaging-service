/** Local admission retention; each server starts its own window on admission. */
export const CALL_ADMISSION_RETENTION_MS = 300_000;

/** Local suppression of late delivery and cancellation races. */
export const CALL_REPLAY_RETENTION_MS = 360_000;
