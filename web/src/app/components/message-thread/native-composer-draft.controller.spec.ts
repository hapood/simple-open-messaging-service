import { of, type Observable, Subject } from 'rxjs';
import type { AccountComposerDraft } from '../../../../../shared/account-state';
import type { LinkGenerationView } from '../../services/link-card-generation.service';
import { NativeComposerDraftController } from './native-composer-draft.controller';

describe('NativeComposerDraftController link generation ownership', () => {
  function setup() {
    const generations = {
      begin$: vi.fn<
        (url: string, text: string) => Observable<LinkGenerationView>
      >(() => new Subject<LinkGenerationView>()),
      resume: vi.fn(),
      pause: vi.fn(),
      forget: vi.fn(),
      snapshot: vi.fn(() => undefined),
    };
    const drafts = {
      get: vi.fn<(threadId: number) => AccountComposerDraft | undefined>(
        () => undefined,
      ),
      save: vi.fn(),
    };
    return {
      controller: new NativeComposerDraftController(drafts, generations),
      generations,
      drafts,
    };
  }

  it('cancels the in-flight generation request when the link changes', () => {
    const { controller, generations } = setup();
    const first = new Subject<LinkGenerationView>();
    generations.begin$.mockReturnValueOnce(first);
    controller.consumeLink('https://example.com', 'text');
    expect(first.observed).toBe(true);
    const second = new Subject<LinkGenerationView>();
    generations.begin$.mockReturnValueOnce(second);
    controller.consumeLink('https://other.example', 'text');
    expect(first.observed).toBe(false);
    expect(second.observed).toBe(true);
  });

  it('ignores a generation response that outlives its link change', () => {
    const { controller, generations } = setup();
    const request = new Subject<LinkGenerationView>();
    generations.begin$.mockReturnValueOnce(request);
    controller.consumeLink('https://example.com', 'text');
    controller.consumeLink(null, '');
    const state = {
      generationId: 'stale-generation',
      status: 'pending' as const,
      expiresAt: 1,
      polling: true,
    };
    request.next(state);
    expect(generations.forget).not.toHaveBeenCalled();
    expect(generations.resume).not.toHaveBeenCalledWith(state);
  });

  it('keeps a completed generation id and persists it with the draft', () => {
    const { controller, generations, drafts } = setup();
    generations.begin$.mockReturnValueOnce(
      of<LinkGenerationView>({
        generationId: 'generation-1',
        status: 'pending',
        expiresAt: 5,
        polling: true,
      }),
    );
    controller.consumeLink('https://example.com', 'text');
    controller.set('hello');
    controller.save(42, (text) => text);
    expect(drafts.save).toHaveBeenCalledWith(
      expect.objectContaining({
        threadId: 42,
        plainText: 'hello',
        linkUrl: 'https://example.com',
        generationId: 'generation-1',
      }),
    );
  });

  it('reset cancels pending work and allows the same URL to start again', () => {
    const { controller, generations } = setup();
    const first = new Subject<LinkGenerationView>();
    const second = new Subject<LinkGenerationView>();
    generations.begin$.mockReturnValueOnce(first).mockReturnValueOnce(second);
    controller.consumeLink('https://example.com', 'text');
    controller.reset();
    expect(first.observed).toBe(false);
    controller.consumeLink('https://example.com', 'text');
    expect(second.observed).toBe(true);
    first.next({
      generationId: 'old',
      status: 'pending',
      expiresAt: 1,
      polling: true,
    });
    controller.save(42, (text) => text);
    expect(generations.begin$).toHaveBeenCalledTimes(2);
    controller.reset();
    expect(second.observed).toBe(false);
  });

  it('reset pauses settled preview polling without deleting the saved draft', () => {
    const { controller, generations, drafts } = setup();
    generations.begin$.mockReturnValueOnce(
      of({
        generationId: 'preview',
        status: 'pending',
        expiresAt: 1,
        polling: true,
      }),
    );
    controller.consumeLink('https://example.com', 'text');
    controller.set('draft');
    controller.save(42, (text) => text);
    controller.reset();
    expect(generations.pause).toHaveBeenCalledExactlyOnceWith('preview');
    expect(generations.forget).not.toHaveBeenCalled();
    expect(drafts.save).toHaveBeenCalledOnce();
    expect(controller.text()).toBe('');
  });

  it('cancels a pending request when a thread is reopened', () => {
    const { controller, generations, drafts } = setup();
    drafts.get.mockReturnValue({
      threadId: 42,
      html: '<p>saved</p>',
      plainText: 'saved',
      updatedAt: 1,
    });
    const request = new Subject<LinkGenerationView>();
    generations.begin$.mockReturnValueOnce(request);
    controller.consumeLink('https://example.com', 'text');
    controller.open(42);
    expect(request.observed).toBe(false);
    expect(controller.text()).toBe('saved');
  });
});
