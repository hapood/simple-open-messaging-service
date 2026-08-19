import { provideZonelessChangeDetection } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { CallRingtoneService } from './call-ringtone.service';

describe('CallRingtoneService', () => {
  let originalAudioContext: typeof AudioContext;
  let originalAudio: typeof Audio;

  beforeEach(() => {
    originalAudioContext = window.AudioContext;
    originalAudio = window.Audio;
    TestBed.configureTestingModule({
      providers: [provideZonelessChangeDetection()],
    });
  });

  afterEach(() => {
    Object.defineProperty(window, 'AudioContext', {
      configurable: true,
      value: originalAudioContext,
    });
    Object.defineProperty(window, 'Audio', {
      configurable: true,
      value: originalAudio,
    });
    TestBed.resetTestingModule();
  });

  it('does not schedule tones when browser autoplay rejects resume', async () => {
    const context = fakeContext(new Error('blocked'));
    installAudioContext(context);
    vi.spyOn(window, 'setInterval');

    TestBed.inject(CallRingtoneService).setMode('incoming');
    await Promise.resolve();
    await Promise.resolve();

    expect(window.setInterval).not.toHaveBeenCalled();
    expect(context.close).toHaveBeenCalledTimes(1);
    expect(context.createOscillator).not.toHaveBeenCalled();
  });

  it('replaces the generated incoming tone with the ringback asset', async () => {
    const incoming = fakeContext();
    installAudioContext(incoming);
    const audio = fakeAudio();
    installAudio(audio);
    const service = TestBed.inject(CallRingtoneService);

    service.setMode('incoming');
    await Promise.resolve();
    expect(incoming.createOscillator).toHaveBeenCalledTimes(2);

    service.setMode('ringback');
    await Promise.resolve();
    expect(incoming.close).toHaveBeenCalledTimes(1);
    expect(audio.src).toBe('/audio/us-ringback-tone.ogg');
    expect(audio.loop).toBe(true);
    expect(audio.play).toHaveBeenCalledTimes(1);

    service.setMode('busy');
    expect(audio.pause).toHaveBeenCalled();
    expect(audio.src).toBe('/audio/north-american-busy-signal.ogg');
    expect(audio.play).toHaveBeenCalledTimes(2);

    service.setMode('ended');
    expect(audio.src).toBe('/audio/zip-tone.ogg');
    expect(audio.loop).toBe(false);
    expect(audio.play).toHaveBeenCalledTimes(3);
  });
});

function installAudioContext(...contexts: AudioContext[]): void {
  let index = 0;
  Object.defineProperty(window, 'AudioContext', {
    configurable: true,
    value: function () {
      return contexts[index++];
    },
  });
}

function installAudio(audio: HTMLAudioElement): void {
  Object.defineProperty(window, 'Audio', {
    configurable: true,
    value: function () {
      return audio;
    },
  });
}

function fakeAudio(): HTMLAudioElement {
  return {
    src: '',
    preload: '',
    loop: false,
    volume: 1,
    currentTime: 0,
    play: vi.fn().mockName('play').mockResolvedValue(undefined),
    pause: vi.fn().mockName('pause'),
    removeAttribute: vi.fn().mockName('removeAttribute'),
    load: vi.fn().mockName('load'),
  } as unknown as HTMLAudioElement;
}

function fakeContext(resumeError?: Error): AudioContext {
  const oscillator = {
    type: 'sine',
    frequency: { setValueAtTime: vi.fn().mockName('setValueAtTime') },
    connect: vi.fn().mockName('connect'),
    disconnect: vi.fn().mockName('disconnect'),
    addEventListener: vi.fn().mockName('addEventListener'),
    start: vi.fn().mockName('start'),
    stop: vi.fn().mockName('stop'),
  };
  const gain = {
    gain: {
      setValueAtTime: vi.fn().mockName('setValueAtTime'),
      linearRampToValueAtTime: vi.fn().mockName('linearRampToValueAtTime'),
      exponentialRampToValueAtTime: vi
        .fn()
        .mockName('exponentialRampToValueAtTime'),
    },
    connect: vi.fn().mockName('connect'),
    disconnect: vi.fn().mockName('disconnect'),
  };
  const resume = vi.fn().mockName('resume');
  if (resumeError) resume.mockRejectedValue(resumeError);
  else resume.mockResolvedValue(undefined);
  return {
    state: 'running',
    currentTime: 0,
    destination: {},
    resume,
    close: vi.fn().mockName('close').mockResolvedValue(undefined),
    createOscillator: vi
      .fn()
      .mockName('createOscillator')
      .mockImplementation(() => ({ ...oscillator })),
    createGain: vi
      .fn()
      .mockName('createGain')
      .mockImplementation(() => gain),
  } as unknown as AudioContext;
}
