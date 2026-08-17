import { provideZonelessChangeDetection } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { IDLE_CALL } from '../app/services/call-adapter';
import {
  PlaygroundCallAdapter,
  PlaygroundCallState,
  readPlaygroundCallMode,
} from './playground-call.mock';

describe('playground call mock', () => {
  afterEach(() => TestBed.resetTestingModule());

  it('selects only the explicit call preview query values', () => {
    expect(readPlaygroundCallMode('?mock=call')).toBe('audio');
    expect(readPlaygroundCallMode('?mock=video-call')).toBe('video');
    expect(readPlaygroundCallMode('?mock=messages')).toBeNull();
  });

  it('rings before the configured peer accepts and returns to idle when ended', async () => {
    TestBed.configureTestingModule({
      providers: [provideZonelessChangeDetection()],
    });
    const state = TestBed.inject(PlaygroundCallState);
    const adapter = TestBed.inject(PlaygroundCallAdapter);

    adapter.initiate(2, 'call-from-header', 'AUDIO', 'Alice', '');
    adapter.setMuted(true);

    expect(state.callState().callSid).toBe('call-from-header');
    expect(state.callState().muted).toBeTrue();
    expect(state.callState().phase).toBe('ringing');
    await waitForResponse();
    expect(state.callState().phase).toBe('connected');

    adapter.end();

    expect(state.callState()).toEqual({ ...IDLE_CALL });
  });

  it('simulates a declined or busy peer without connecting media', async () => {
    TestBed.configureTestingModule({
      providers: [provideZonelessChangeDetection()],
    });
    const state = TestBed.inject(PlaygroundCallState);
    const adapter = TestBed.inject(PlaygroundCallAdapter);

    for (const response of ['decline', 'busy'] as const) {
      state.opponentResponse.set(response);
      adapter.initiate(2, `call-${response}`, 'AUDIO', 'Alice', '');
      expect(state.callState().phase).toBe('ringing');
      await waitForResponse();
      expect(state.callState()).toEqual({ ...IDLE_CALL });
    }
  });

  it('shows mock video posters and swaps them without camera media', () => {
    TestBed.configureTestingModule({
      providers: [provideZonelessChangeDetection()],
    });
    const state = TestBed.inject(PlaygroundCallState);
    const adapter = TestBed.inject(PlaygroundCallAdapter);
    const remote = document.createElement('video');
    const self = document.createElement('video');

    state.upgradeToVideo();
    adapter.setVideoElements(remote, self);
    const initialRemotePoster = remote.poster;
    const initialSelfPoster = self.poster;

    adapter.swapVideo();

    expect(state.callState().swapped).toBeTrue();
    expect(remote.poster).toBe(initialSelfPoster);
    expect(self.poster).toBe(initialRemotePoster);
  });
});

function waitForResponse(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 850));
}
