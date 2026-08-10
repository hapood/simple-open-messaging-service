import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  blockFederationPeer,
  federationPeerEvents,
  getFederationPeer,
  runFederationSelfCheck,
  unblockFederationPeer,
} from './federation'

const request = vi.hoisted(() => vi.fn())
vi.mock('@/api/client', () => ({ request }))

describe('federation admin API', () => {
  beforeEach(() => request.mockReset().mockResolvedValue(undefined))

  it('encodes peer domains as one path segment for detail and events', async () => {
    await getFederationPeer('peer.test/path')
    await federationPeerEvents('peer.test/path', 25)

    expect(request).toHaveBeenNthCalledWith(
      1,
      '/admin/federation/peers/peer.test%2Fpath',
    )
    expect(request).toHaveBeenNthCalledWith(
      2,
      '/admin/federation/peers/peer.test%2Fpath/events',
      { take: 25 },
    )
  })

  it('maps block, unblock, and self-check mutations to their server contracts', async () => {
    await blockFederationPeer('peer.test', 'incident')
    await unblockFederationPeer('peer.test')
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
      '/admin/federation/self-check',
      { ntpServer: 'ntp.example', dnsResolver: '1.1.1.1' },
    )
  })
})
