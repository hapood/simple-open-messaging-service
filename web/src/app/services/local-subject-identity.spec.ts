import {
  localSubjectIdentity,
  messageCreatorKey,
  parseUserIdentityKey,
} from './model';

describe('client subject coordinates', () => {
  it('preserves real domains and namespace coordinates', () => {
    expect(
      localSubjectIdentity({
        account: 'me',
        domain: 'own.test',
        namespaceId: 7,
        publisherNamespaceId: 7,
      }),
    ).toEqual({
      account: 'me',
      domain: 'own.test',
      namespaceId: 7,
      publisherNamespaceId: 7,
    });
    expect(
      localSubjectIdentity({
        account: 'me',
        domain: 'own.test',
        namespaceId: 0,
      }),
    ).toEqual({ account: 'me', domain: 'own.test', namespaceId: 0 });
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

  it('keeps exact coordinates in message and roster lookup keys', () => {
    const key = messageCreatorKey({
      account: 'me',
      domain: 'own.test',
      namespaceId: 7,
    });
    expect(key).toBe('[7,"own.test","me"]');
    expect(parseUserIdentityKey('[7,"own.test","me"]')).toEqual({
      account: 'me',
      domain: 'own.test',
      namespaceId: 7,
    });
  });
});
