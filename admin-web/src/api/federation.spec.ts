import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  blockFederationPeer,
  approveFederationIdentityReview,
  federationPeerNamespaces,
  federationPendingIdentityReviews,
  getFederationPeer,
  localFederationRootEpochs,
  rejectFederationIdentityReview,
  rotateLocalFederationRoot,
  unpublishLocalFederationRoot,
  unblockFederationPeer,
  recognizeFederationPeer,
} from './federation';

const request = vi.hoisted(() => vi.fn());
vi.mock('@/api/client', () => ({ request }));

describe('federation admin API', () => {
  beforeEach(() => request.mockReset().mockResolvedValue(undefined));

  it('encodes peer domains as one path segment for detail and namespaces', async () => {
    await getFederationPeer('peer.test/path');
    await federationPeerNamespaces('peer.test/path');

    expect(request).toHaveBeenNthCalledWith(
      1,
      '/admin/federation/peers/peer.test%2Fpath',
    );
    expect(request).toHaveBeenNthCalledWith(
      2,
      '/admin/federation/peers/peer.test%2Fpath/namespaces',
    );
  });

  it('maps peer and root mutations to their server contracts', async () => {
    await blockFederationPeer('peer.test', 'incident');
    await unblockFederationPeer('peer.test');
    await recognizeFederationPeer('peer.test');
    await federationPendingIdentityReviews();
    await approveFederationIdentityReview(7);
    await rejectFederationIdentityReview(7);
    await localFederationRootEpochs();
    await rotateLocalFederationRoot();
    await unpublishLocalFederationRoot(3);

    expect(request).toHaveBeenNthCalledWith(
      1,
      '/admin/federation/peers/peer.test/block',
      { note: 'incident' },
    );
    expect(request).toHaveBeenNthCalledWith(
      2,
      '/admin/federation/peers/peer.test/unblock',
    );
    expect(request).toHaveBeenNthCalledWith(
      3,
      '/admin/federation/peers/peer.test/recognize',
    );
    expect(request).toHaveBeenNthCalledWith(
      4,
      '/admin/federation/identity-reviews',
    );
    expect(request).toHaveBeenNthCalledWith(
      5,
      '/admin/federation/identity-reviews/7/approve',
      {},
    );
    expect(request).toHaveBeenNthCalledWith(
      6,
      '/admin/federation/identity-reviews/7/reject',
      {},
    );
    expect(request).toHaveBeenNthCalledWith(
      7,
      '/admin/federation/local-root-epochs',
    );
    expect(request).toHaveBeenNthCalledWith(
      8,
      '/admin/federation/local-root-epochs/rotate',
      {},
    );
    expect(request).toHaveBeenNthCalledWith(
      9,
      '/admin/federation/local-root-epochs/3/unpublish',
      {},
    );
  });
});
