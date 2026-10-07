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
const recognize = vi.hoisted(() => ({
  isPending: false,
  mutateAsync: vi.fn(),
}));
const approveReview = vi.hoisted(() => ({
  isPending: false,
  mutateAsync: vi.fn(),
}));
const rejectReview = vi.hoisted(() => ({
  isPending: false,
  mutateAsync: vi.fn(),
}));
const predecessorCheck = vi.hoisted(() => ({
  isPending: false,
  mutateAsync: vi.fn().mockResolvedValue({
    reviewId: 7,
    checkedRoot: 'root-a',
    ok: true,
    detail: 'opened',
  }),
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
  useFederationPeerNamespaces: () => ({
    data: {
      namespaces: [
        {
          id: 12,
          domain: 'peer.test',
          rootPublicKey: 'root-a',
          peerAssignedLocalNamespaceId: 44,
          identityPinnedAt: null,
          createdAt: null,
          retiredAt: null,
          active: true,
          trustLevel: 'available',
          halted: false,
          pendingReview: null,
        },
      ],
      reviews: [
        {
          id: 7,
          kind: 'root-rotation',
          matchedNamespaceId: 12,
          matchedDomain: 'peer.test',
          nextDomain: 'peer.test',
          claimedRoot: 'root-b',
          claim: { previousRoot: 'root-a' },
          status: 'pending',
          verifiedAt: null,
          reviewedAt: null,
          createdAt: null,
        },
      ],
    },
    isLoading: false,
  }),
  useApproveFederationIdentityReview: () => approveReview,
  useRejectFederationIdentityReview: () => rejectReview,
  useFederationPredecessorCheck: () => predecessorCheck,
  useBlockFederationPeer: () => block,
  useUnblockFederationPeer: () => unblock,
  useRecognizeFederationPeer: () => recognize,
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
    recognize.mutateAsync.mockReset().mockResolvedValue({
      domain: 'peer.test',
      status: 'recognized',
    });
    toast.success.mockReset();
    toast.error.mockReset();
    approveReview.mutateAsync.mockReset().mockResolvedValue(undefined);
    rejectReview.mutateAsync.mockReset().mockResolvedValue(undefined);
    predecessorCheck.mutateAsync.mockReset().mockResolvedValue({
      reviewId: 7,
      checkedRoot: 'root-a',
      ok: true,
      detail: 'opened',
    });
    confirmMock.mockReset().mockReturnValue(true);
  });

  it('does not expose peer lifecycle mutations to a non-super administrator', () => {
    renderPage();

    expect(screen.getByText('peer.test')).toBeInTheDocument();
    expect(
      screen.queryByRole('button', { name: 'federation.action.block' }),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole('button', { name: 'federation.action.recognize' }),
    ).not.toBeInTheDocument();
  });

  it('lets a super administrator start recognition and reports success', async () => {
    state.isSuper = true;
    renderPage();

    fireEvent.click(
      screen.getByRole('button', { name: 'federation.action.recognize' }),
    );

    await waitFor(() =>
      expect(recognize.mutateAsync).toHaveBeenCalledWith('peer.test'),
    );
    expect(toast.success).toHaveBeenCalledWith('federation.toast.recognized');
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

  it('lets a super administrator run the predecessor check and approve a pending rotation review', async () => {
    state.isSuper = true;
    renderPage();

    fireEvent.click(screen.getByText('federation.detail.tabNamespaces'));

    fireEvent.click(
      screen.getByRole('button', {
        name: 'federation.reviews.predecessorCheck',
      }),
    );
    await waitFor(() =>
      expect(predecessorCheck.mutateAsync).toHaveBeenCalledWith(7),
    );
    expect(toast.success).toHaveBeenCalledWith(
      'federation.reviews.predecessorOk',
    );

    fireEvent.click(
      screen.getByRole('button', { name: 'federation.reviews.approve' }),
    );
    await waitFor(() =>
      expect(approveReview.mutateAsync).toHaveBeenCalledWith(7),
    );
    expect(toast.success).toHaveBeenCalledWith(
      'federation.toast.reviewApproved',
    );
  });

  it('lets a super administrator reject a pending rotation review without changing the pin', async () => {
    state.isSuper = true;
    renderPage();

    fireEvent.click(screen.getByText('federation.detail.tabNamespaces'));
    fireEvent.click(
      screen.getByRole('button', { name: 'federation.reviews.reject' }),
    );

    await waitFor(() =>
      expect(rejectReview.mutateAsync).toHaveBeenCalledWith(7),
    );
    expect(toast.success).toHaveBeenCalledWith(
      'federation.toast.reviewRejected',
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
