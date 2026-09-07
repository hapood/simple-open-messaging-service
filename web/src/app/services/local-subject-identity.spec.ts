import {
  localSubjectIdentity,
  messageCreatorKey,
  parseUserIdentityKey,
} from './model';

describe('client subject coordinates', () => {
  it('normalizes local subjects without changing source coordinates', () => {
    expect(
      localSubjectIdentity({
        account: 'me',
        domain: 'local',
        namespaceId: 7,
        sourceNamespaceId: 7,
      }),
    ).toEqual({
      account: 'me',
      domain: 'local',
      namespaceId: 0,
      sourceNamespaceId: 7,
    });
    expect(
      localSubjectIdentity({
        account: 'me',
        domain: 'own.test',
        namespaceId: 0,
      }),
    ).toEqual({ account: 'me', domain: 'local', namespaceId: 0 });
  });

  it('keeps a third-party subject in the namespace of its publisher', () => {
    expect(
      localSubjectIdentity({
        account: 'other',
        domain: 'third.test',
        namespaceId: 7,
      }),
    ).toEqual({ account: 'other', domain: 'third.test', namespaceId: 7 });
  });

  it('uses the same local coordinates for message and roster lookup keys', () => {
    const key = messageCreatorKey({
      account: 'me',
      domain: 'local',
      namespaceId: 7,
    });
    expect(key).toBe('[0,"local","me"]');
    expect(parseUserIdentityKey('[7,"local","me"]')).toEqual({
      account: 'me',
      domain: 'local',
      namespaceId: 0,
    });
  });
});
