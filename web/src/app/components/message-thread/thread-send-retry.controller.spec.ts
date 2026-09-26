import { describe, expect, it, vi } from 'vitest';
import type { CbItem } from '../../lib/chat-box/chat-box-scroller';
import type { ChatItemData } from '../message-cards/chat-item';
import type { ThreadSendOutbox } from '../../services/thread-send-outbox.service';
import type { ThreadOptimisticController } from './thread-optimistic.controller';
import {
  ThreadSendRetryController,
  type ThreadSendRetryHandlers,
} from './thread-send-retry.controller';

const item = {
  id: -1,
  data: { type: 'msg', serverGap: false },
} as unknown as CbItem<ChatItemData>;

function handlers(): ThreadSendRetryHandlers {
  return {
    webGallery: vi.fn(),
    nativeGallery: vi.fn(),
    voice: vi.fn(),
    nativeVoice: vi.fn(),
    nativeAttachment: vi.fn(),
    webAttachment: vi.fn(),
    text: vi.fn(),
  };
}

describe('ThreadSendRetryController', () => {
  it('replays text when no retained binary resource exists', async () => {
    const callbacks = handlers();
    const controller = new ThreadSendRetryController(
      { resource: () => undefined } as unknown as ThreadSendOutbox,
      {
        beginRetry: async () => item,
      } as unknown as ThreadOptimisticController,
      callbacks,
    );
    await controller.retry('cid');
    expect(callbacks.text).toHaveBeenCalledWith(item);
  });

  it('routes a retained native attachment to its dedicated replay path', async () => {
    const callbacks = handlers();
    const resource = {
      type: 'native-attachment' as const,
      selection: { uploadId: 'upload' },
      partId: 'part',
      release: vi.fn(),
      discard: vi.fn(),
    };
    const controller = new ThreadSendRetryController(
      { resource: () => resource } as unknown as ThreadSendOutbox,
      {
        beginRetry: async () => item,
      } as unknown as ThreadOptimisticController,
      callbacks,
    );
    await controller.retry('cid');
    expect(callbacks.nativeAttachment).toHaveBeenCalledWith(
      'cid',
      resource,
      item,
    );
  });

  it('retries a native voice using its retained recording rather than sending empty text', async () => {
    const callbacks = handlers();
    const resource = {
      type: 'native-voice' as const,
      threadId: 4,
      size: 512,
      discard: vi.fn(),
    };
    const controller = new ThreadSendRetryController(
      {
        resource: () => resource,
      } as unknown as ThreadSendOutbox,
      { beginRetry: async () => item } as unknown as ThreadOptimisticController,
      callbacks,
    );
    await controller.retry('voice-cid');
    expect(callbacks.nativeVoice).toHaveBeenCalledWith(
      'voice-cid',
      resource,
      item,
    );
    expect(callbacks.text).not.toHaveBeenCalled();
  });
});
