import { FederationNamespaceService } from './federation-namespace.service';

describe('FederationNamespaceService', () => {
  it('shows only the active namespace under its canonical domain', () => {
    const service = new FederationNamespaceService();
    service.replace([
      { domain: 'peer.test', namespaceId: 12, status: 'ARCHIVED' },
      { domain: 'peer.test', namespaceId: 13, status: 'ACTIVE' },
    ]);

    expect(service.displayDomain('peer.test', 12)).toBe('12.peer.test.local');
    expect(service.displayDomain('peer.test', 13)).toBe('peer.test');
    expect(service.displayDomain('local', 0)).toBe('local');

    service.archive('peer.test', 13);
    expect(service.displayDomain('peer.test', 13)).toBe('13.peer.test.local');
  });
});
