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
  const mention = '[@张三](soms://user/zhangsan%40example.com?v=1)';

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
        version: 1,
        params: {},
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
      String.raw`\[@张三](soms://user/a?v=1)`,
      '普通 [@张三] 不是实体',
      'emoji 😀 before ' + mention,
    ];
    for (const input of inputs) {
      expect(toDisplayText(escapePlainText(input))).toBe(input);
    }
  });

  it('supports escaped label punctuation and extension parameters', () => {
    const encoded = serializeUserMention('研[发]\\一组', 'dev@example.com');
    expect(toDisplayText(encoded)).toBe('@研[发]\\一组');
    const segment = parseMessageEntities(
      '[#发布](soms://topic/release?v=2&source=composer)',
    )[0];
    expect(segment).toMatchObject({
      kind: 'entity',
      sigil: '#',
      label: '发布',
      entityType: 'topic',
      entityId: 'release',
      version: 2,
      params: { source: 'composer' },
    });
  });

  it('serializes the extensible all-members audience', () => {
    const all = serializeAudienceMention('所有人', 'all');
    expect(all).toBe('[@所有人](soms://audience/all?v=1)');
    expect(parseMessageEntities(all)[0]).toMatchObject({
      kind: 'entity',
      entityType: 'audience',
      entityId: 'all',
      version: 1,
    });
    expect(toDisplayText(all)).toBe('@所有人');
  });

  it('transforms real entities without touching escaped protocol text', () => {
    const escaped = String.raw`\[@Fake](soms://user/fake%40example.com?v=1)`;
    const content = `${escaped} ${mention}`;
    expect(
      transformMessageEntities(content, (entity) =>
        serializeUserMention('张三（规范）', entity.entityId),
      ),
    ).toBe(
      `${escaped} [@张三（规范）](soms://user/zhangsan%40example.com?v=1)`,
    );
  });

  it('treats malformed tokens as ordinary text', () => {
    const malformed = [
      '[@张三]',
      '[@张三](https://example.com)',
      '[@张三](soms://user/a)',
      '[@张三](soms://user/?v=1)',
      '[@张三](soms://user/a?v=0)',
    ];
    for (const value of malformed) {
      expect(parseMessageEntities(value)).toEqual([
        { kind: 'text', text: value },
      ]);
    }
  });
});
