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
    spyOn(window, 'setInterval').and.callThrough();

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
    expect(audio.loop).toBeTrue();
    expect(audio.play).toHaveBeenCalledTimes(1);

    service.setMode('busy');
    expect(audio.pause).toHaveBeenCalled();
    expect(audio.src).toBe('/audio/north-american-busy-signal.ogg');
    expect(audio.play).toHaveBeenCalledTimes(2);

    service.setMode('ended');
    expect(audio.src).toBe('/audio/zip-tone.ogg');
    expect(audio.loop).toBeFalse();
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
    play: jasmine.createSpy('play').and.resolveTo(),
    pause: jasmine.createSpy('pause'),
    removeAttribute: jasmine.createSpy('removeAttribute'),
    load: jasmine.createSpy('load'),
  } as unknown as HTMLAudioElement;
}

function fakeContext(resumeError?: Error): AudioContext {
  const oscillator = {
    type: 'sine',
    frequency: { setValueAtTime: jasmine.createSpy('setValueAtTime') },
    connect: jasmine.createSpy('connect'),
    disconnect: jasmine.createSpy('disconnect'),
    addEventListener: jasmine.createSpy('addEventListener'),
    start: jasmine.createSpy('start'),
    stop: jasmine.createSpy('stop'),
  };
  const gain = {
    gain: {
      setValueAtTime: jasmine.createSpy('setValueAtTime'),
      linearRampToValueAtTime: jasmine.createSpy('linearRampToValueAtTime'),
      exponentialRampToValueAtTime: jasmine.createSpy(
        'exponentialRampToValueAtTime',
      ),
    },
    connect: jasmine.createSpy('connect'),
    disconnect: jasmine.createSpy('disconnect'),
  };
  const resume = jasmine.createSpy('resume');
  if (resumeError) resume.and.rejectWith(resumeError);
  else resume.and.resolveTo();
  return {
    state: 'running',
    currentTime: 0,
    destination: {},
    resume,
    close: jasmine.createSpy('close').and.resolveTo(),
    createOscillator: jasmine
      .createSpy('createOscillator')
      .and.callFake(() => ({ ...oscillator })),
    createGain: jasmine.createSpy('createGain').and.callFake(() => gain),
  } as unknown as AudioContext;
}
