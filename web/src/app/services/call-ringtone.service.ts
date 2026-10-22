import { Injectable, OnDestroy } from '@angular/core';

export type CallToneMode = 'incoming' | 'ringback' | 'busy' | 'ended';

interface TonePattern {
  intervalMs: number;
  pulses: readonly {
    delay: number;
    duration: number;
    frequencies: readonly number[];
  }[];
}

const TONE_PATTERNS: Record<'incoming', TonePattern> = {
  incoming: {
    intervalMs: 1800,
    pulses: [
      { delay: 0, duration: 0.2, frequencies: [880] },
      { delay: 0.3, duration: 0.2, frequencies: [880] },
    ],
  },
};

const TONE_ASSETS: Record<
  'ringback' | 'busy' | 'ended',
  { source: string; loop: boolean }
> = {
  ringback: { source: '/audio/us-ringback-tone.ogg', loop: true },
  busy: {
    source: '/audio/north-american-busy-signal.ogg',
    loop: true,
  },
  ended: { source: '/audio/zip-tone.ogg', loop: false },
};

/**
 * Owns renderer call tones. Browsers may reject audio started without a user gesture; in that case the
 * service releases the suspended AudioContext instead of accumulating scheduled oscillator nodes. Native
 * incoming-call audio remains the platform call layer's responsibility.
 */
@Injectable({ providedIn: 'root' })
export class CallRingtoneService implements OnDestroy {
  private context: AudioContext | null = null;
  private interval: ReturnType<typeof setInterval> | null = null;
  private readonly assets = new Map<
    'ringback' | 'busy' | 'ended',
    HTMLAudioElement
  >();
  private mode: CallToneMode | null = null;

  constructor() {
    if (typeof Audio === 'undefined') return;
    for (const [mode, asset] of Object.entries(TONE_ASSETS) as [
      'ringback' | 'busy' | 'ended',
      { source: string; loop: boolean },
    ][]) {
      const audio = new Audio();
      audio.preload = 'auto';
      audio.src = asset.source;
      audio.load();
      this.assets.set(mode, audio);
    }
  }

  setMode(mode: CallToneMode | null): void {
    if (mode === this.mode) return;
    this.stopGeneratedTone();
    this.pauseAsset();
    this.mode = mode;
    if (!mode) return;

    if (mode !== 'incoming') {
      const asset = TONE_ASSETS[mode];
      this.playAsset(mode, asset.source, asset.loop);
      return;
    }

    const Context = this.getAudioContext();
    if (!Context) {
      this.mode = null;
      return;
    }

    const context = new Context();
    this.context = context;
    void context
      .resume()
      .then(() => {
        if (this.context !== context || this.mode !== mode) return;
        const pattern = TONE_PATTERNS.incoming;
        this.playPattern(context, pattern);
        this.interval = setInterval(
          () => this.playPattern(context, pattern),
          pattern.intervalMs,
        );
      })
      .catch(() => {
        if (this.context === context) this.stop();
      });
  }

  private playAsset(
    mode: 'ringback' | 'busy' | 'ended',
    source: string,
    loop: boolean,
  ): void {
    const audio = this.assets.get(mode) ?? new Audio();
    this.assets.set(mode, audio);
    audio.loop = loop;
    audio.volume = 0.65;
    audio.src = source;
    audio.currentTime = 0;
    void audio.play().catch(() => {
      if (this.mode === mode) {
        this.pauseAsset();
        this.mode = null;
      }
    });
  }

  private playPattern(context: AudioContext, pattern: TonePattern): void {
    if (context.state !== 'running' || context !== this.context) return;
    for (const pulse of pattern.pulses) {
      const start = context.currentTime + pulse.delay;
      const gain = context.createGain();
      gain.gain.setValueAtTime(0.0001, start);
      gain.gain.linearRampToValueAtTime(0.16, start + 0.02);
      gain.gain.exponentialRampToValueAtTime(
        0.0001,
        start + pulse.duration,
      );
      gain.connect(context.destination);
      let remainingOscillators = pulse.frequencies.length;
      pulse.frequencies.forEach((frequency) => {
        const oscillator = context.createOscillator();
        oscillator.type = 'sine';
        oscillator.frequency.setValueAtTime(frequency, start);
        oscillator.connect(gain);
        oscillator.addEventListener(
          'ended',
          () => {
            oscillator.disconnect();
            remainingOscillators -= 1;
            if (remainingOscillators === 0) gain.disconnect();
          },
          { once: true },
        );
        oscillator.start(start);
        oscillator.stop(start + pulse.duration);
      });
    }
  }

  private stopGeneratedTone(): void {
    if (this.interval) {
      clearInterval(this.interval);
      this.interval = null;
    }
    const context = this.context;
    this.context = null;
    if (context && context.state !== 'closed') {
      void context.close().catch(() => undefined);
    }
  }

  private pauseAsset(): void {
    for (const audio of this.assets.values()) {
      audio.pause();
      audio.currentTime = 0;
    }
  }

  private stop(): void {
    this.stopGeneratedTone();
    this.pauseAsset();
    this.mode = null;
  }

  private getAudioContext(): (new () => AudioContext) | null {
    if (typeof window === 'undefined') return null;
    const audioWindow = window as Window & {
      AudioContext?: typeof AudioContext;
      webkitAudioContext?: typeof AudioContext;
    };
    return audioWindow.AudioContext ?? audioWindow.webkitAudioContext ?? null;
  }

  ngOnDestroy(): void {
    this.stop();
    for (const audio of this.assets.values()) {
      audio.removeAttribute('src');
      audio.load();
    }
    this.assets.clear();
  }
}
