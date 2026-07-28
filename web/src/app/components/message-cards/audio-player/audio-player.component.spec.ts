import { TestBed } from '@angular/core/testing';
import { provideZonelessChangeDetection } from '@angular/core';
import { AudioPlayerComponent } from './audio-player.component';
import { MEDIA_STATUS, type MediaStatus } from '../chat-item';
import { MediaTransferService } from '../../../services/media-transfer.service';

/**
 * Guards the federated playback bug: while a clip is not playable — still localizing (status
 * 'downloading') OR localize failed ('failed') — tapping play must be a no-op, never reaching
 * <audio>.play() against a not-yet-local or 4xx shard, which would onError() into a spurious
 * frontend-only 'failed'. The ready path + both not-ready sources (server status, frontend decode
 * failure) are covered so the "button is inert while not ready" contract stays whole.
 */
describe('AudioPlayerComponent', () => {
  beforeEach(() => {
    TestBed.configureTestingModule({
      imports: [AudioPlayerComponent],
      providers: [provideZonelessChangeDetection()],
    });
  });

  /** Render so the #audio viewChild resolves, then settle the zoneless change-detection queue. Returns
   *  the component, the <audio> element, and a play() spy (stubbed so no real network/decode happens). */
  async function render(
    status: MediaStatus = MEDIA_STATUS.READY,
  ): Promise<{ comp: AudioPlayerComponent; audio: HTMLAudioElement; playSpy: jasmine.Spy }> {
    const fixture = TestBed.createComponent(AudioPlayerComponent);
    fixture.componentRef.setInput('src', '/uploads/shards/aa/bb/shard.mp3');
    fixture.componentRef.setInput('duration', 5);
    fixture.componentRef.setInput('status', status);
    fixture.detectChanges();
    await fixture.whenStable();
    const audio = fixture.nativeElement.querySelector('audio') as HTMLAudioElement;
    const playSpy = spyOn(audio, 'play').and.callFake(() => Promise.resolve());
    return { comp: fixture.componentInstance, audio, playSpy };
  }

  it('suppresses play while downloading — no spurious failed from a not-yet-local shard', async () => {
    const { comp, playSpy } = await render(MEDIA_STATUS.DOWNLOADING);

    expect(comp.inert()).toBe(true);
    expect(comp.failed()).toBe(false);

    comp.toggle();

    expect(playSpy).not.toHaveBeenCalled();
    expect(comp.failed()).toBe(false); // the onError path never runs
  });

  it('plays normally when ready (the download guard does not over-block the ready path)', async () => {
    const { comp, playSpy } = await render(MEDIA_STATUS.READY);

    expect(comp.inert()).toBe(false);
    comp.toggle();
    expect(playSpy).toHaveBeenCalledTimes(1);
  });

  it('routes a real DOM button click to the hidden audio engine', async () => {
    const fixture = TestBed.createComponent(AudioPlayerComponent);
    fixture.componentRef.setInput('src', '/uploads/shards/aa/bb/voice.webm');
    fixture.componentRef.setInput('duration', 5);
    fixture.detectChanges();
    await fixture.whenStable();
    const audio = fixture.nativeElement.querySelector('audio') as HTMLAudioElement;
    const playSpy = spyOn(audio, 'play').and.resolveTo();

    (fixture.nativeElement.querySelector('.ap-btn') as HTMLButtonElement).click();

    expect(playSpy).toHaveBeenCalledTimes(1);
  });

  it('stays inert once a load/decode failure has been recorded', async () => {
    const { comp, playSpy } = await render(MEDIA_STATUS.READY);
    comp.failed.set(true);
    expect(comp.inert()).toBe(true);

    comp.toggle();

    expect(playSpy).not.toHaveBeenCalled();
  });

  it('stays inert when the server localize failed (status FAILED)', async () => {
    const { comp, playSpy } = await render(MEDIA_STATUS.FAILED);

    expect(comp.inert()).toBe(true);
    expect(comp.failed()).toBe(false); // not the frontend decode-failed signal — the message-level status

    comp.toggle();

    expect(playSpy).not.toHaveBeenCalled();
    expect(comp.failed()).toBe(false); // inert preempts play, so onError never trips a spurious failed
  });

  it('uses the same playable player structure for an optimistic blob URL', async () => {
    const fixture = TestBed.createComponent(AudioPlayerComponent);
    fixture.componentRef.setInput('src', 'blob:voice');
    fixture.componentRef.setInput('duration', 8);
    fixture.componentRef.setInput('pending', true);
    fixture.detectChanges();
    await fixture.whenStable();

    expect(fixture.componentInstance.inert()).toBe(false);
    expect(fixture.nativeElement.querySelector('.ap-pending-ring')).not.toBeNull();
    expect(fixture.nativeElement.querySelector('.ap-btn').disabled).toBe(false);
    expect(fixture.nativeElement.querySelector('.ap-wave')).not.toBeNull();
  });

  it('renders upload progress as a height-neutral bottom rail', async () => {
    const transfers = TestBed.inject(MediaTransferService);
    transfers.start({
      clientMessageId: 'voice-progress',
      threadId: 1,
      kind: 'audio',
      name: 'voice.webm',
      size: 100,
    });
    transfers.progress('voice-progress', 40, 100);
    const fixture = TestBed.createComponent(AudioPlayerComponent);
    fixture.componentRef.setInput('src', 'blob:voice');
    fixture.componentRef.setInput('pending', true);
    fixture.componentRef.setInput('transferId', 'voice-progress');
    fixture.detectChanges();
    await fixture.whenStable();

    const rail = fixture.nativeElement.querySelector('.ap-transfer') as HTMLElement;
    const fill = rail.querySelector('span') as HTMLElement;
    expect(rail).not.toBeNull();
    expect(rail.classList).not.toContain('ap-transfer--indeterminate');
    expect(fill.style.width).toBe('40%');
    transfers.dismiss('voice-progress');
  });

  it('seeks from the waveform and cycles 1x → 1.5x → 2x → 1x', async () => {
    const { comp, audio } = await render();
    const wave = document.createElement('button');
    spyOn(wave, 'getBoundingClientRect').and.returnValue({
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
