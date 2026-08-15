import { ALL_MENTION_ID, toDisplayText } from '../../lib/message-entity';
import {
  serializeEditorBlocks,
  serializeNativeComposerText,
} from './editor-message-serializer';

describe('serializeEditorBlocks', () => {
  it('serializes selected user and all-audience mention nodes', () => {
    const stored = serializeEditorBlocks([
      {
        type: 'paragraph',
        content: [
          { type: 'text', text: '请 ' },
          {
            type: 'mention',
            attrs: { id: 'zhangsan@example.com', label: '张三' },
          },
          { type: 'text', text: ' 通知 ' },
          {
            type: 'mention',
            attrs: { id: ALL_MENTION_ID, label: '所有人' },
          },
        ],
      },
    ]);
    expect(stored).toBe(
      '请 [@张三](socfp://user/zhangsan%40example.com) 通知 [@所有人](socfp://audience/all)',
    );
    expect(toDisplayText(stored)).toBe('请 @张三 通知 @所有人');
  });

  it('serializes native UTF-16 mention ranges and escapes literal protocol text', () => {
    const literal = '[@假](socfp://user/fake)';
    const text = `😀 @张三 ${literal} @所有人`;
    expect(
      serializeNativeComposerText(text, [
        {
          start: 3,
          end: 6,
          kind: 'user',
          id: 'zhangsan@example.com',
          label: '张三',
        },
        {
          start: text.length - 4,
          end: text.length,
          kind: 'all',
          id: 'socfp:audience:all',
          label: '所有人',
        },
      ]),
    ).toBe(
      `😀 [@张三](socfp://user/zhangsan%40example.com) \\${literal} [@所有人](socfp://audience/all)`,
    );
  });

  it('ignores stale or overlapping native ranges', () => {
    expect(
      serializeNativeComposerText('@张三 hello', [
        {
          start: 0,
          end: 2,
          kind: 'user',
          id: 'wrong@example.com',
          label: '张三',
        },
      ]),
    ).toBe('@张三 hello');
  });

  it('escapes identical protocol syntax when it came from a text node', () => {
    const literal = '[@张三](socfp://user/zhangsan%40example.com)';
    const stored = serializeEditorBlocks([
      {
        type: 'paragraph',
        content: [{ type: 'text', text: literal }],
      },
    ]);
    expect(stored).toBe(`\\${literal}`);
    expect(toDisplayText(stored)).toBe(literal);
  });

  it('preserves hard breaks and separates paragraphs', () => {
    expect(
      serializeEditorBlocks([
        {
          type: 'paragraph',
          content: [
            { type: 'text', text: '第一行' },
            { type: 'hardBreak' },
            { type: 'text', text: '第二行' },
          ],
        },
        { type: 'paragraph', content: [{ type: 'text', text: '第三行' }] },
      ]),
    ).toBe('第一行\n第二行\n第三行');
  });
});
