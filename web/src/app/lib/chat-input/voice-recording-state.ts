/** Entering cancel needs a deliberate 48px slide; leaving it needs a larger return to 32px.
 *  The hysteresis prevents small finger tremors around one threshold from flipping the outcome. */
export const CANCEL_ENTER_PX = 48;
export const CANCEL_EXIT_PX = 32;
export const MIN_VOICE_RECORD_MS = 500;

export function nextVoiceCancelState(
  currentlyCancelled: boolean,
  upwardDistancePx: number,
): boolean {
  return currentlyCancelled
    ? upwardDistancePx > CANCEL_EXIT_PX
    : upwardDistancePx >= CANCEL_ENTER_PX;
}

export function isVoiceRecordingTooShort(durationMs: number): boolean {
  return durationMs < MIN_VOICE_RECORD_MS;
}
