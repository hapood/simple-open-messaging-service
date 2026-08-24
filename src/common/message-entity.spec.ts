import { describe, expect, it } from 'vitest';
import {
  escapePlainText,
  parseMessageEntities,
  serializeAudienceMention,
  serializeUserMention,
  toDisplayText,
  transformMessageEntities,
} from './message-entity.js';

describe('message entity codec', () => {
  const mention = '[@张三](somfp://user/zhangsan%40example.com)';

  it('serializes and parses a canonical user mention', () => {
    expect(serializeUserMention('张三', 'zhangsan@example.com')).toBe(mention);
    expect(parseMessageEntities(`你好 ${mention}`)).toEqual([
      { kind: 'text', text: '你好 ' },
      {
        kind: 'entity',
        raw: mention,
        sigil: '@',
        label: '张三',
        entityType: 'user',
        entityId: 'zhangsan@example.com',
      },
    ]);
    expect(toDisplayText(`你好 ${mention}`)).toBe('你好 @张三');
  });

  it('keeps a manually typed complete token as literal text', () => {
    const stored = escapePlainText(mention);
    expect(stored).toBe(`\\${mention}`);
    expect(parseMessageEntities(stored)).toEqual([
      { kind: 'text', text: mention },
    ]);
    expect(toDisplayText(stored)).toBe(mention);
  });

  it('round-trips arbitrary plain text including slashes and entity syntax', () => {
    const inputs = [
      String.raw`C:\Users\张三`,
      mention,
      String.raw`\[@张三](somfp://user/a)`,
      '普通 [@张三] 不是实体',
      'emoji 😀 before ' + mention,
    ];
    for (const input of inputs) {
      expect(toDisplayText(escapePlainText(input))).toBe(input);
    }
  });

  it('supports escaped label punctuation', () => {
    const encoded = serializeUserMention('研[发]\\一组', 'dev@example.com');
    expect(toDisplayText(encoded)).toBe('@研[发]\\一组');
  });

  it('serializes the extensible all-members audience', () => {
    const all = serializeAudienceMention('所有人', 'all');
    expect(all).toBe('[@所有人](somfp://audience/all)');
    expect(parseMessageEntities(all)[0]).toMatchObject({
      kind: 'entity',
      entityType: 'audience',
      entityId: 'all',
    });
    expect(toDisplayText(all)).toBe('@所有人');
  });

  it('transforms real entities without touching escaped protocol text', () => {
    const escaped = String.raw`\[@Fake](somfp://user/fake%40example.com)`;
    const content = `${escaped} ${mention}`;
    expect(
      transformMessageEntities(content, (entity) =>
        serializeUserMention('张三（规范）', entity.entityId),
      ),
    ).toBe(`${escaped} [@张三（规范）](somfp://user/zhangsan%40example.com)`);
  });

  it('treats malformed tokens as ordinary text', () => {
    const malformed = [
      '[@张三]',
      '[@张三](https://example.com)',
      '[@张三](somfp://user/)',
      '[@张三](somfp://user/a?v=0)',
      '[@张三](somfp://user/%61lice%40example.com)',
      '[@张三](somfp://USER/alice%40example.com)',
      '[@张三](somfp://user/alice%40example.com?extra=1)',
      '[@发布](somfp://topic/release)',
    ];
    for (const value of malformed) {
      expect(parseMessageEntities(value)).toEqual([
        { kind: 'text', text: value },
      ]);
    }
  });
});
