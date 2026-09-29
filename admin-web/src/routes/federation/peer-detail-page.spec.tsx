import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { PeerDetailPage } from './peer-detail-page';

const state = vi.hoisted(() => ({
  isSuper: false,
  trustLevel: 'available',
  haltCode: null as number | null,
}));
const block = vi.hoisted(() => ({ isPending: false, mutateAsync: vi.fn() }));
const unblock = vi.hoisted(() => ({ isPending: false, mutateAsync: vi.fn() }));
const setActiveNamespace = vi.hoisted(() => ({
  isPending: false,
  mutateAsync: vi.fn(),
}));
const toast = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn() }));
const confirmMock = vi.hoisted(() => vi.fn());

vi.mock('react-i18next', async (importOriginal) => ({
  ...(await importOriginal<typeof import('react-i18next')>()),
  useTranslation: () => ({ t: (key: string) => key }),
}));
vi.stubGlobal('confirm', confirmMock);
vi.mock('sonner', () => ({ toast }));
vi.mock('@/hooks/use-me', () => ({ useIsSuperAdmin: () => state.isSuper }));
vi.mock('@/hooks/use-quotas', () => ({
  useQuotaNodes: () => ({ data: [], isLoading: false }),
}));
vi.mock('@/hooks/use-federation', () => ({
  useFederationPeer: () => ({
    data: {
      domain: 'peer.test',
      trustLevel: state.trustLevel,
      haltCode: state.haltCode,
      createdAt: null,
      trustedAt: null,
      lastSuccessAt: null,
      degradedAt: null,
      degradationCount: 0,
      addedBy: null,
      degradationReason: null,
    },
    isLoading: false,
    error: null,
  }),
  useFederationPeerEvents: () => ({ data: [], isLoading: false }),
  useFederationPeerNamespaces: () => ({
    data: [
      {
        id: 0,
        domain: 'peer.test',
        rootKeyFingerprint: 'sha256:new',
        rootPublicKey: 'root',
        peerAssignedLocalNamespaceId: 44,
        identityPinnedAt: null,
        createdAt: null,
        retiredAt: null,
        active: false,
        candidate: true,
        candidateStatus: 'pending',
        failedCode: null,
        failedMessage: null,
      },
    ],
    isLoading: false,
  }),
  useSetActiveFederationPeerNamespace: () => setActiveNamespace,
  useBlockFederationPeer: () => block,
  useUnblockFederationPeer: () => unblock,
}));

function renderPage() {
  return render(
    <MemoryRouter initialEntries={['/federation/peer.test']}>
      <Routes>
        <Route path="/federation/:domain" element={<PeerDetailPage />} />
      </Routes>
    </MemoryRouter>,
  );
}

describe('PeerDetailPage authorization', () => {
  beforeEach(() => {
    state.isSuper = false;
    state.trustLevel = 'available';
    state.haltCode = null;
    block.mutateAsync.mockReset().mockResolvedValue(undefined);
    unblock.mutateAsync.mockReset().mockResolvedValue(undefined);
    toast.success.mockReset();
    toast.error.mockReset();
    setActiveNamespace.mutateAsync.mockReset().mockResolvedValue(undefined);
    confirmMock.mockReset().mockReturnValue(true);
  });

  it('does not expose peer lifecycle mutations to a non-super administrator', () => {
    renderPage();

    expect(screen.getByText('peer.test')).toBeInTheDocument();
    expect(
      screen.queryByRole('button', { name: 'federation.action.block' }),
    ).not.toBeInTheDocument();
  });

  it('lets a super administrator block the routed peer and reports success', async () => {
    state.isSuper = true;
    renderPage();

    fireEvent.click(
      screen.getByRole('button', { name: 'federation.action.block' }),
    );

    await waitFor(() =>
      expect(block.mutateAsync).toHaveBeenCalledWith({ domain: 'peer.test' }),
    );
    expect(toast.success).toHaveBeenCalledWith('federation.toast.blocked');
  });

  it('lets a super administrator approve a new namespace candidate without a namespace id', async () => {
    state.isSuper = true;
    renderPage();

    fireEvent.click(screen.getByText('federation.detail.tabNamespaces'));
    fireEvent.click(
      screen.getByRole('button', { name: 'federation.namespaces.approve' }),
    );

    await waitFor(() =>
      expect(setActiveNamespace.mutateAsync).toHaveBeenCalledWith({
        domain: 'peer.test',
        namespaceId: undefined,
      }),
    );
    expect(toast.success).toHaveBeenCalledWith(
      'federation.toast.namespaceActive',
    );
  });

  it('lets a super administrator unblock a blocked peer and reports success', async () => {
    state.isSuper = true;
    state.trustLevel = 'halted';
    state.haltCode = 50009;
    renderPage();

    fireEvent.click(
      screen.getByRole('button', { name: 'federation.action.unblock' }),
    );

    await waitFor(() =>
      expect(unblock.mutateAsync).toHaveBeenCalledWith('peer.test'),
    );
    expect(block.mutateAsync).not.toHaveBeenCalled();
    expect(toast.success).toHaveBeenCalledWith('federation.toast.unblocked');
  });
});
