import { describe, expect, it, vi } from 'vitest';
import type { ComposerDraftService } from '../../services/composer-draft.service';
import type { LinkCardGenerationService } from '../../services/link-card-generation.service';
import { NativeComposerDraftController } from './native-composer-draft.controller';

describe('NativeComposerDraftController', () => {
  it('restores and persists the native draft for one thread', () => {
    const save = vi.fn();
    const controller = new NativeComposerDraftController(
      {
        get: () => ({
          threadId: 4,
          html: 'hello',
          plainText: 'hello',
          updatedAt: 1,
        }),
        save,
      } as unknown as ComposerDraftService,
      {} as LinkCardGenerationService,
    );
    expect(controller.open(4)).toBe('hello');
    controller.append('world');
    controller.save(4, (text) => text);
    expect(save).toHaveBeenCalledWith(
      expect.objectContaining({ threadId: 4, plainText: 'hello\nworld' }),
    );
  });
});
