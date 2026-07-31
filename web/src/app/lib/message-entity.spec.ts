import {
  escapePlainText,
  parseMessageEntities,
  serializeAudienceMention,
  serializeUserMention,
  toDisplayText,
  toRenderMessageEntities,
} from './message-entity';

describe('message entity codec', () => {
  const mention = '[@张三](soms://user/zhangsan%40example.com?v=1)';

  it('matches the canonical user mention contract', () => {
    expect(serializeUserMention('张三', 'zhangsan@example.com')).toBe(mention);
    expect(toDisplayText(`你好 ${mention}`)).toBe('你好 @张三');
    expect(parseMessageEntities(mention)[0]).toEqual(
      jasmine.objectContaining({
        kind: 'entity',
        sigil: '@',
        label: '张三',
        entityType: 'user',
        entityId: 'zhangsan@example.com',
        version: 1,
      }),
    );
  });

  it('distinguishes a stable-account mention of me from another user', () => {
    const me = serializeUserMention('我的新昵称', 'me@example.com');
    const other = serializeUserMention('张三', 'zhangsan@example.com');
    const rendered = toRenderMessageEntities(
      `${me} 和 ${other}`,
      'ME@example.com',
    );
    expect(rendered.mentionState).toBe('me');
    expect(rendered.segments).toEqual([
      {
        kind: 'mention',
        text: '@我的新昵称',
        target: 'me',
        account: 'me@example.com',
      },
      { kind: 'text', text: ' 和 ' },
      {
        kind: 'mention',
        text: '@张三',
        target: 'other',
        account: 'zhangsan@example.com',
      },
    ]);
  });

  it('does not promote manually typed protocol text to an entity', () => {
    const stored = escapePlainText(mention);
    expect(stored).toBe(`\\${mention}`);
    expect(parseMessageEntities(stored)).toEqual([
      { kind: 'text', text: mention },
    ]);
  });

  it('round-trips plain input losslessly', () => {
    const inputs = [
      String.raw`C:\Users\张三`,
      mention,
      String.raw`\[@张三](soms://user/a?v=1)`,
      '普通 [@张三] 不是实体',
      `emoji 😀 before ${mention}`,
    ];
    for (const input of inputs) {
      expect(toDisplayText(escapePlainText(input))).toBe(input);
    }
  });

  it('degrades malformed input to text', () => {
    const value = '[@张三](soms://user/a)';
    expect(parseMessageEntities(value)).toEqual([
      { kind: 'text', text: value },
    ]);
  });

  it('supports the all-members audience entity', () => {
    const all = serializeAudienceMention('所有人', 'all');
    expect(all).toBe('[@所有人](soms://audience/all?v=1)');
    expect(toDisplayText(all)).toBe('@所有人');
  });
});
