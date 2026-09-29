import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  blockFederationPeer,
  federationPeerEvents,
  federationPeerNamespaces,
  getFederationPeer,
  runFederationSelfCheck,
  setActiveFederationPeerNamespace,
  unblockFederationPeer,
} from './federation'

const request = vi.hoisted(() => vi.fn())
vi.mock('@/api/client', () => ({ request }))

describe('federation admin API', () => {
  beforeEach(() => request.mockReset().mockResolvedValue(undefined))

  it('encodes peer domains as one path segment for detail and events', async () => {
    await getFederationPeer('peer.test/path')
    await federationPeerEvents('peer.test/path', 25)
    await federationPeerNamespaces('peer.test/path')

    expect(request).toHaveBeenNthCalledWith(
      1,
      '/admin/federation/peers/peer.test%2Fpath',
    )
    expect(request).toHaveBeenNthCalledWith(
      2,
      '/admin/federation/peers/peer.test%2Fpath/events',
      { take: 25 },
    )
    expect(request).toHaveBeenNthCalledWith(
      3,
      '/admin/federation/peers/peer.test%2Fpath/namespaces',
    )
  })

  it('maps block, unblock, and self-check mutations to their server contracts', async () => {
    await blockFederationPeer('peer.test', 'incident')
    await unblockFederationPeer('peer.test')
    await setActiveFederationPeerNamespace('peer.test', 12)
    await runFederationSelfCheck({
      ntpServer: 'ntp.example',
      dnsResolver: '1.1.1.1',
    })

    expect(request).toHaveBeenNthCalledWith(
      1,
      '/admin/federation/peers/peer.test/block',
      { note: 'incident' },
    )
    expect(request).toHaveBeenNthCalledWith(
      2,
      '/admin/federation/peers/peer.test/unblock',
    )
    expect(request).toHaveBeenNthCalledWith(
      3,
      '/admin/federation/peers/peer.test/namespaces/active',
      { namespaceId: 12 },
    )
    expect(request).toHaveBeenNthCalledWith(
      4,
      '/admin/federation/self-check',
      { ntpServer: 'ntp.example', dnsResolver: '1.1.1.1' },
    )
  })
})
