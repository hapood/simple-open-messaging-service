import {
  CANCEL_ENTER_PX,
  CANCEL_EXIT_PX,
  isVoiceRecordingTooShort,
  nextVoiceCancelState,
} from './voice-recording-state';

describe('voice recording state', () => {
  it('arms at 48px but stays armed until the finger returns to 32px', () => {
    expect(nextVoiceCancelState(false, CANCEL_ENTER_PX - 1)).toBe(false);
    expect(nextVoiceCancelState(false, CANCEL_ENTER_PX)).toBe(true);
    expect(nextVoiceCancelState(true, CANCEL_ENTER_PX - 1)).toBe(true);
    expect(nextVoiceCancelState(true, CANCEL_EXIT_PX + 1)).toBe(true);
    expect(nextVoiceCancelState(true, CANCEL_EXIT_PX)).toBe(false);
  });

  it('classifies only recordings shorter than 500ms as too short', () => {
    expect(isVoiceRecordingTooShort(499)).toBe(true);
    expect(isVoiceRecordingTooShort(500)).toBe(false);
  });
});
