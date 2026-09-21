import { isSelfMentionMember } from './mention-candidates';

describe('isSelfMentionMember', () => {
  it('flags the session identity with the roster domain normalized to local', () => {
    expect(
      isSelfMentionMember(
        { account: 'alice06295391', domain: 'local' },
        { account: 'alice06295391', domain: '' },
      ),
    ).toBe(true);
  });

  it('flags the session identity when the profile domain is missing', () => {
    expect(
      isSelfMentionMember(
        { account: 'alice06295391', domain: '' },
        { account: 'alice06295391', domain: 'local' },
      ),
    ).toBe(true);
  });

  it('keeps a same-named account on another federation node mentionable', () => {
    expect(
      isSelfMentionMember(
        { account: 'alice06295391', domain: 'local' },
        { account: 'alice06295391', domain: 'bravo.test' },
      ),
    ).toBe(false);
  });

  it('excludes nothing when the session profile has not loaded', () => {
    expect(
      isSelfMentionMember(undefined, {
        account: 'alice06295391',
        domain: 'local',
      }),
    ).toBe(false);
  });
});
