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

  it('rings before the configured peer accepts and previews local hang-up feedback', async () => {
    TestBed.configureTestingModule({
      providers: [provideZonelessChangeDetection()],
    });
    const state = TestBed.inject(PlaygroundCallState);
    const adapter = TestBed.inject(PlaygroundCallAdapter);

    // The mock's peer response is a PEER_RESPONSE_DELAY_MS setTimeout — advance the fake clock
    // instead of sleeping real time (mirrors the decline/busy test below).
    vi.useFakeTimers();
    try {
      adapter.initiate(2, 'call-from-header', 'AUDIO', 'Alice', '');
      adapter.setMuted(true);

      expect(state.callState().callSid).toBe('call-from-header');
      expect(state.callState().muted).toBe(true);
      expect(state.callState().phase).toBe('ringing');
      await vi.advanceTimersByTimeAsync(850);
      expect(state.callState().phase).toBe('connected');

      adapter.end();

      expect(state.callState().phase).toBe('ended');
      expect(state.callState().terminalReason).toBe('completed');
      vi.advanceTimersByTime(1400);
      expect(state.callState()).toEqual({ ...IDLE_CALL });
    } finally {
      vi.useRealTimers();
    }
  });

  it('shows a declined or busy peer before dismissing the call', () => {
    vi.useFakeTimers();
    TestBed.configureTestingModule({
      providers: [provideZonelessChangeDetection()],
    });
    const state = TestBed.inject(PlaygroundCallState);
    const adapter = TestBed.inject(PlaygroundCallAdapter);

    for (const response of ['decline', 'busy'] as const) {
      state.opponentResponse.set(response);
      adapter.initiate(2, `call-${response}`, 'AUDIO', 'Alice', '');
      expect(state.callState().phase).toBe('ringing');
      vi.advanceTimersByTime(800);
      expect(state.callState().phase).toBe('ended');
      expect(state.callState().terminalReason).toBe(
        response === 'decline' ? 'declined' : 'busy',
      );
      vi.advanceTimersByTime(response === 'busy' ? 1800 : 1400);
      expect(state.callState()).toEqual({ ...IDLE_CALL });
    }
    vi.useRealTimers();
  });

  it('simulates a peer who does not answer', () => {
    vi.useFakeTimers();
    TestBed.configureTestingModule({
      providers: [provideZonelessChangeDetection()],
    });
    const state = TestBed.inject(PlaygroundCallState);
    const adapter = TestBed.inject(PlaygroundCallAdapter);
    state.opponentResponse.set('no-answer');

    adapter.initiate(2, 'call-no-answer', 'AUDIO', 'Alice', '');
    vi.advanceTimersByTime(4999);
    expect(state.callState().phase).toBe('ringing');
    vi.advanceTimersByTime(1);
    expect(state.callState().phase).toBe('ended');
    expect(state.callState().terminalReason).toBe('missed');
    vi.advanceTimersByTime(1400);
    expect(state.callState()).toEqual({ ...IDLE_CALL });
    vi.useRealTimers();
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

    expect(state.callState().swapped).toBe(true);
    expect(remote.poster).toBe(initialSelfPoster);
    expect(self.poster).toBe(initialRemotePoster);
  });
});
