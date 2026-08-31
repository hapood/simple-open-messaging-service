import { describe, expect, it, vi } from 'vitest';
import {
  ThreadComposerController,
  type ThreadComposerHandlers,
} from './thread-composer.controller';

describe('ThreadComposerController', () => {
  it('routes each intent to exactly one matching handler', () => {
    const handlers = {
      text: vi.fn(),
      image: vi.fn(),
      file: vi.fn(),
      nativeFiles: vi.fn(),
      link: vi.fn(),
      contact: vi.fn(),
      paste: vi.fn(),
      audio: vi.fn(),
    } satisfies ThreadComposerHandlers;
    const controller = new ThreadComposerController(handlers);
    const intent = { kind: 'text' as const, text: 'hello' };
    controller.dispatch(intent);
    expect(handlers.text).toHaveBeenCalledWith(intent);
    expect(handlers.file).not.toHaveBeenCalled();
  });
});
