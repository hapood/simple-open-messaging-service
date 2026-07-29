import {
  CANCEL_ENTER_PX,
  CANCEL_EXIT_PX,
  isVoiceRecordingTooShort,
  nextVoiceCancelState,
} from './voice-recording-state';

describe('voice recording state', () => {
  it('arms at 48px but stays armed until the finger returns to 32px', () => {
    expect(nextVoiceCancelState(false, CANCEL_ENTER_PX - 1)).toBeFalse();
    expect(nextVoiceCancelState(false, CANCEL_ENTER_PX)).toBeTrue();
    expect(nextVoiceCancelState(true, CANCEL_ENTER_PX - 1)).toBeTrue();
    expect(nextVoiceCancelState(true, CANCEL_EXIT_PX + 1)).toBeTrue();
    expect(nextVoiceCancelState(true, CANCEL_EXIT_PX)).toBeFalse();
  });

  it('classifies only recordings shorter than 500ms as too short', () => {
    expect(isVoiceRecordingTooShort(499)).toBeTrue();
    expect(isVoiceRecordingTooShort(500)).toBeFalse();
  });
});
