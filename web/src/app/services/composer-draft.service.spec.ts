import { TestBed } from '@angular/core/testing';
import { provideZonelessChangeDetection, signal } from '@angular/core';
import { ComposerDraftService } from './composer-draft.service';
import { WebdbService } from './webdb.service';

describe('ComposerDraftService', () => {
  it('serializes rapid saves so a slow first write cannot replace the latest draft', async () => {
    let releaseFirst!: () => void;
    const first = new Promise<void>((resolve) => { releaseFirst = resolve; });
    const writeComposerDrafts = vi.fn().mockImplementationOnce(() => first).mockResolvedValue(undefined);
    TestBed.configureTestingModule({
      providers: [
        provideZonelessChangeDetection(),
        ComposerDraftService,
        { provide: WebdbService, useValue: { ready: signal(false), writeComposerDrafts } },
      ],
    });
    const drafts = TestBed.inject(ComposerDraftService);
    const draft = (plainText: string) => ({
      threadId: 42, plainText, html: plainText, updatedAt: Date.now(),
    });
    drafts.save(draft('first'));
    drafts.save(draft('second'));
    await vi.waitFor(() => expect(writeComposerDrafts).toHaveBeenCalledTimes(1));
    releaseFirst();
    await vi.waitFor(() => expect(writeComposerDrafts).toHaveBeenCalledTimes(2));
    expect(writeComposerDrafts.mock.calls[1][0]).toEqual([expect.objectContaining({ plainText: 'second' })]);
  });
});
