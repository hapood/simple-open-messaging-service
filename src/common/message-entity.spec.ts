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
  const mention = '[@张三](somfp://user/12/zhangsan)';

  it('serializes and parses a canonical user mention', () => {
    expect(serializeUserMention('张三', 12, 'zhangsan')).toBe(mention);
    expect(parseMessageEntities(`你好 ${mention}`)).toEqual([
      { kind: 'text', text: '你好 ' },
      {
        kind: 'entity',
        raw: mention,
        sigil: '@',
        label: '张三',
        entityType: 'user',
        entityId: '12/zhangsan',
      },
    ]);
    expect(toDisplayText(`你好 ${mention}`)).toBe('你好 @张三');
  });

  it('serializes a local user mention with namespace 0', () => {
    expect(serializeUserMention('Alice', 0, 'alice')).toBe(
      '[@Alice](somfp://user/0/alice)',
    );
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
      String.raw`\[@张三](somfp://user/0/a)`,
      '普通 [@张三] 不是实体',
      'emoji 😀 before ' + mention,
    ];
    for (const input of inputs) {
      expect(toDisplayText(escapePlainText(input))).toBe(input);
    }
  });

  it('supports escaped label punctuation', () => {
    const encoded = serializeUserMention('研[发]\\一组', 7, 'dev');
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
    const escaped = String.raw`\[@Fake](somfp://user/3/fake)`;
    const content = `${escaped} ${mention}`;
    expect(
      transformMessageEntities(content, (entity) =>
        serializeUserMention('张三（规范）', 12, 'zhangsan'),
      ),
    ).toBe(`${escaped} [@张三（规范）](somfp://user/12/zhangsan)`);
  });

  it('treats malformed tokens as ordinary text', () => {
    const malformed = [
      '[@张三]',
      '[@张三](https://example.com)',
      '[@张三](somfp://user/)',
      '[@张三](somfp://user/a)',
      '[@张三](somfp://user/0/alice?v=0)',
      '[@张三](somfp://user/0/%61lice)',
      '[@张三](somfp://USER/0/alice)',
      '[@张三](somfp://user/0/alice?extra=1)',
      '[@张三](somfp://user/-1/alice)',
      '[@张三](somfp://user/01/alice)',
      '[@张三](somfp://user/0/)',
      '[@张三](somfp://user/0/alice/extra)',
      '[@张三](somfp://user/x/alice)',
      '[@发布](somfp://topic/release)',
    ];
    for (const value of malformed) {
      expect(parseMessageEntities(value)).toEqual([
        { kind: 'text', text: value },
      ]);
    }
  });
});
