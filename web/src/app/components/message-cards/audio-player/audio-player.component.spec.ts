import type { Mock } from 'vitest';
import { TestBed } from '@angular/core/testing';
import { provideZonelessChangeDetection } from '@angular/core';
import { AudioPlayerComponent } from './audio-player.component';

/** Playback behavior only; server readiness is owned by the mounting file cell. */
describe('AudioPlayerComponent', () => {
  beforeEach(() => {
    TestBed.configureTestingModule({
      imports: [AudioPlayerComponent],
      providers: [provideZonelessChangeDetection()],
    });
  });

  /** Render so the #audio viewChild resolves, then settle the zoneless change-detection queue. Returns
   *  the component, the <audio> element, and a play() spy (stubbed so no real network/decode happens). */
  async function render(): Promise<{
    comp: AudioPlayerComponent;
    audio: HTMLAudioElement;
    playSpy: Mock;
  }> {
    const fixture = TestBed.createComponent(AudioPlayerComponent);
    fixture.componentRef.setInput('src', '/uploads/cas/aa/bb/shard.mp3');
    fixture.componentRef.setInput('duration', 5);
    fixture.detectChanges();
    await fixture.whenStable();
    const audio = fixture.nativeElement.querySelector(
      'audio',
    ) as HTMLAudioElement;
    const playSpy = vi
      .spyOn(audio, 'play')
      .mockImplementation(() => Promise.resolve());
    return { comp: fixture.componentInstance, audio, playSpy };
  }

  it('plays normally when ready (the download guard does not over-block the ready path)', async () => {
    const { comp, playSpy } = await render();

    expect(comp.failed()).toBe(false);
    comp.toggle();
    expect(playSpy).toHaveBeenCalledTimes(1);
  });

  it('routes a real DOM button click to the hidden audio engine', async () => {
    const fixture = TestBed.createComponent(AudioPlayerComponent);
    fixture.componentRef.setInput('src', '/uploads/cas/aa/bb/voice.webm');
    fixture.componentRef.setInput('duration', 5);
    fixture.detectChanges();
    await fixture.whenStable();
    const audio = fixture.nativeElement.querySelector(
      'audio',
    ) as HTMLAudioElement;
    const playSpy = vi.spyOn(audio, 'play').mockResolvedValue(undefined);

    (
      fixture.nativeElement.querySelector('.ap-btn') as HTMLButtonElement
    ).click();

    expect(playSpy).toHaveBeenCalledTimes(1);
  });

  it('stays inert once a load/decode failure has been recorded', async () => {
    const { comp, playSpy } = await render();
    comp.failed.set(true);
    expect(comp.failed()).toBe(true);

    comp.toggle();

    expect(playSpy).not.toHaveBeenCalled();
  });

  it('renders ready audio without a transfer rail', async () => {
    const fixture = TestBed.createComponent(AudioPlayerComponent);
    fixture.componentRef.setInput('src', '/uploads/cas/aa/bb/voice.webm');
    fixture.componentRef.setInput('duration', 8);
    fixture.detectChanges();
    await fixture.whenStable();

    expect(fixture.componentInstance.failed()).toBe(false);
    expect(fixture.nativeElement.querySelector('.ap-transfer')).toBeNull();
    expect(fixture.nativeElement.querySelector('.ap-btn').disabled).toBe(false);
    expect(fixture.nativeElement.querySelector('.ap-wave')).not.toBeNull();
  });

  it('seeks from the waveform and cycles 1x → 1.5x → 2x → 1x', async () => {
    const { comp, audio } = await render();
    const wave = document.createElement('button');
    vi.spyOn(wave, 'getBoundingClientRect').mockReturnValue({
      left: 10,
      width: 100,
    } as DOMRect);

    comp.seek({ currentTarget: wave, clientX: 60 } as unknown as MouseEvent);
    expect(audio.currentTime).toBeCloseTo(2.5, 5);
    expect(comp.progress()).toBeCloseTo(0.5, 5);

    comp.cycleRate();
    expect(comp.rate()).toBe(1.5);
    expect(audio.playbackRate).toBe(1.5);
    comp.cycleRate();
    expect(comp.rate()).toBe(2);
    comp.cycleRate();
    expect(comp.rate()).toBe(1);
  });

  it('marks the clip played and removes the unread dot when playback starts', async () => {
    const fixture = TestBed.createComponent(AudioPlayerComponent);
    fixture.componentRef.setInput('src', '/voice.mp3');
    fixture.componentRef.setInput('time', '14:30');
    fixture.detectChanges();
    await fixture.whenStable();
    expect(fixture.nativeElement.querySelector('.ap-unplayed')).not.toBeNull();

    fixture.componentInstance.onPlay();
    expect(fixture.nativeElement.querySelector('.ap-unplayed')).toBeNull();
    expect(fixture.nativeElement.textContent).toContain('14:30');
  });
});
