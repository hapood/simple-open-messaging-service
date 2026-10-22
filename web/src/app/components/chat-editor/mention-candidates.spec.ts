import { isSelfMentionMember } from './mention-candidates';

describe('isSelfMentionMember', () => {
  it('flags the session identity in the local namespace', () => {
    expect(
      isSelfMentionMember(
        { account: 'alice06295391', namespaceId: 0 },
        { account: 'alice06295391', namespaceId: 0 },
      ),
    ).toBe(true);
  });

  it('keeps a same-named account in a different namespace mentionable', () => {
    expect(
      isSelfMentionMember(
        { account: 'alice06295391', namespaceId: 0 },
        { account: 'alice06295391', namespaceId: 12 },
      ),
    ).toBe(false);
  });

  it('excludes nothing when the session profile has not loaded', () => {
    expect(
      isSelfMentionMember(undefined, {
        account: 'alice06295391',
        namespaceId: 0,
      }),
    ).toBe(false);
  });
});
