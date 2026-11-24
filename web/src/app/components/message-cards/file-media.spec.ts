import { describe, expect, it } from 'vitest';
import { fileMedia } from './file-media';
import type { ChatMsgData } from './chat-item';

const message: ChatMsgData = {
  type: 'msg',
  contentType: 'FILE',
  msgId: 42,
  creator: 'alice',
  isSelf: false,
  name: 'Alice',
  text: '',
  time: '12:00',
  createdAtMs: 123,
  images: null,
  file: {
    url: '/uploads/report.pdf',
    name: 'report.pdf',
    size: 0,
    mimeType: 'application/pdf',
  },
};

describe('ordinary file resource projection', () => {
  it('preserves required metadata including a valid zero-byte size', () => {
    expect(fileMedia(message)).toEqual({
      kind: 'file',
      src: '/uploads/report.pdf',
      name: 'report.pdf',
      size: 0,
      mimeType: 'application/pdf',
      msgId: 42,
      senderName: 'Alice',
      sentAt: 123,
    });
  });

  it('rejects missing file metadata rather than silently skipping the viewer', () => {
    // @ts-expect-error FILE metadata is required; also guard untyped callers at runtime.
    expect(() => fileMedia({ ...message, file: null })).toThrow(
      'FILE message requires attachment metadata',
    );
  });

  it('rejects a non-file message even if stale file metadata is present', () => {
    // @ts-expect-error Non-file content cannot carry file metadata.
    expect(() => fileMedia({ ...message, contentType: 'PURE_TEXT' })).toThrow(
      'FILE message requires attachment metadata',
    );
  });
});
