import type { AuthoredMessageItem } from '../message-cards/chat-item';
import {
  canCopyMessage,
  messageCopyBody,
  selectedMessagesCopyText,
} from './message-copy';

const labels = {
  photo: '[图片]',
  video: '[视频]',
  voice: '[语音]',
  file: '[文件]',
  invite: '[邀请]',
  call: '[通话]',
  forward: '[聊天记录]',
};

function message(
  overrides: Partial<AuthoredMessageItem> = {},
): AuthoredMessageItem {
  return {
    type: 'msg',
    msgId: 1,
    creator: JSON.stringify([0, 'me']),
    isSelf: false,
    name: '张三',
    text: '你好',
    time: '14:03',
    contentType: 'PURE_TEXT',
    images: null,
    file: null,
    createdAtMs: new Date(2026, 6, 31, 14, 3).getTime(),
    ...overrides,
  };
}

describe('message copy', () => {
  it('hides context-menu copy for media and file cards', () => {
    for (const contentType of [
      'IMAGE',
      'VIDEO',
      'AUDIO',
      'FILE',
      'GALLERY',
    ] as const) {
      expect(canCopyMessage(message({ contentType }))).toBe(false);
    }
    expect(canCopyMessage(message({ contentType: 'PURE_TEXT' }))).toBe(true);
  });

  it('copies visible rich text with mentions and line breaks', () => {
    expect(
      messageCopyBody(
        message({
          rich: true,
          text: '<p>Hello <strong>world</strong></p><p>@hidden</p>',
          textSegments: [
            { kind: 'text', text: 'Hello world\n' },
            { kind: 'mention', text: '@李四', target: 'other' },
          ],
        }),
        labels,
      ),
    ).toBe('Hello world\n@李四');
  });

  it('uses readable attachment details without copying a URL', () => {
    expect(
      messageCopyBody(
        message({
          contentType: 'FILE',
          file: {
            name: '计划.pdf',
            url: '/uploads/private-token',
            size: 42,
            mimeType: 'application/pdf',
          },
        }),
        labels,
      ),
    ).toBe('[文件] 计划.pdf');
  });

  it('copies only the selected album member description', () => {
    expect(
      messageCopyBody(
        message({
          contentType: 'VIDEO',
          images: [
            {
              kind: 'video',
              src: '/uploads/private-token',
              w: 100,
              h: 100,
              name: '演示.mp4',
            },
          ],
        }),
        labels,
      ),
    ).toBe('[视频] 演示.mp4');
  });

  it('copies a forward card without exposing its wire JSON', () => {
    expect(
      messageCopyBody(
        message({
          contentType: 'FORWARD',
          text: JSON.stringify({
            bundleId: 'bundle-1',
            summaryLines: ['张三：你好'],
            messageCount: 6,
          }),
        }),
        labels,
      ),
    ).toBe('[聊天记录] 6');
  });

  it('sorts a transcript chronologically and separates messages', () => {
    const earlier = message();
    const later = message({
      msgId: 2,
      name: '李四',
      text: '收到',
      createdAtMs: new Date(2026, 6, 31, 14, 5).getTime(),
    });

    expect(selectedMessagesCopyText([later, earlier], labels)).toBe(
      '[2026-07-31 14:03] 张三\n你好\n\n[2026-07-31 14:05] 李四\n收到',
    );
  });
});
