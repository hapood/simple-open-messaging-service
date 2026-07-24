import { TestBed } from '@angular/core/testing';
import { provideZonelessChangeDetection } from '@angular/core';
import { AudioPlayerComponent } from './audio-player.component';
import { MEDIA_STATUS, type MediaStatus } from '../chat-item';

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
});
