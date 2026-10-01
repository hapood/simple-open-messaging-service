import {
  escapePlainText,
  parseMessageEntities,
  serializeAudienceMention,
  serializeUserMention,
  toDisplayText,
  toRenderMessageEntities,
} from './message-entity';

describe('message entity codec', () => {
  const mention = '[@张三](somfp://user/12/zhangsan)';

  it('matches the canonical user mention contract', () => {
    expect(serializeUserMention('张三', 12, 'zhangsan')).toBe(mention);
    expect(toDisplayText(`你好 ${mention}`)).toBe('你好 @张三');
    expect(parseMessageEntities(mention)[0]).toEqual(
      expect.objectContaining({
        kind: 'entity',
        sigil: '@',
        label: '张三',
        entityType: 'user',
        entityId: '12/zhangsan',
      }),
    );
  });

  it('distinguishes a stable-account mention of me from another user', () => {
    const me = serializeUserMention('我的新昵称', 0, 'me');
    const other = serializeUserMention('张三', 12, 'zhangsan');
    const rendered = toRenderMessageEntities(`${me} 和 ${other}`, 'me');
    expect(rendered.mentionState).toBe('me');
    expect(rendered.segments).toEqual([
      {
        kind: 'mention',
        text: '@我的新昵称',
        target: 'me',
        account: '0/me',
      },
      { kind: 'text', text: ' 和 ' },
      {
        kind: 'mention',
        text: '@张三',
        target: 'other',
        account: '12/zhangsan',
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
      String.raw`\[@张三](somfp://user/0/a)`,
      '普通 [@张三] 不是实体',
      `emoji 😀 before ${mention}`,
    ];
    for (const input of inputs) {
      expect(toDisplayText(escapePlainText(input))).toBe(input);
    }
  });

  it('degrades malformed input to text', () => {
    for (const value of [
      '[@张三](somfp://user/alice)',
      '[@张三](somfp://USER/0/alice)',
      '[@张三](somfp://user/0/alice?extra=1)',
      '[@张三](somfp://user/0/%61lice)',
      '[@发布](somfp://topic/release)',
    ]) {
      expect(parseMessageEntities(value)).toEqual([
        { kind: 'text', text: value },
      ]);
    }
  });

  it('supports the all-members audience entity', () => {
    const all = serializeAudienceMention('所有人', 'all');
    expect(all).toBe('[@所有人](somfp://audience/all)');
    expect(toDisplayText(all)).toBe('@所有人');
  });
});
