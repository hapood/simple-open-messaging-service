import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  FederationFeedHeadReceipt,
  FederationHealthObservation,
} from '@/types/api';
import { PeerDetailPage } from './peer-detail-page';

const state = vi.hoisted(() => ({
  health: null as FederationHealthObservation | null,
  isAdmin: false,
  namespaceError: null as Error | null,
  receipt: null as FederationFeedHeadReceipt | null,
  isSuper: false,
  trustLevel: 'available',
  haltCode: null as number | null,
  reviewEpochMatched: true,
  reviewKind: 'root-rotation',
}));
const probe = vi.hoisted(() => ({ isPending: false, mutateAsync: vi.fn() }));
const refetch = vi.hoisted(() => vi.fn());
const refetchNamespaces = vi.hoisted(() => vi.fn());
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
const toast = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn() }));
const confirmMock = vi.hoisted(() => vi.fn());

vi.mock('react-i18next', async (importOriginal) => ({
  ...(await importOriginal<typeof import('react-i18next')>()),
  useTranslation: () => ({ t: (key: string) => key }),
}));
vi.stubGlobal('confirm', confirmMock);
vi.mock('sonner', () => ({ toast }));
vi.mock('@/hooks/use-me', () => ({
  useIsSuperAdmin: () => state.isSuper,
  useIsAdminPlus: () => state.isAdmin || state.isSuper,
}));
vi.mock('@/hooks/use-quotas', () => ({
  useQuotaNodes: () => ({ data: [], isLoading: false }),
}));
vi.mock('@/hooks/use-federation', () => ({
  useFederationPeer: () => ({
    data: {
      id: 12,
      active: true,
      rootPublicKey: 'root-a',
      signingKeyCreatedAt: 1700000000000,
      identityPinnedAt: 1700000001000,
      peerAssignedLocalNamespaceId: 44,
      localServiceAvailable: true,
      peerAcceptanceConfirmed: true,
      remoteServiceReachable: true,
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
      latestFeedHeadReceipt: state.receipt,
      feedProgress: {
        lastHandshakeAt: 1700000002000,
        latestHealthCheck: state.health,
        namespaceId: 12,
        outboundStateFeedEndId: '40',
        inboundStateFeedPulledThrough: '40',
        stateFeedSourceGeneratedAt: 1700000003000,
        profileNamespaceFeedSourceGeneratedAt: 1700000004000,
        inboundProfileNamespaceFeedPulledThrough: '9',
      },
    },
    isLoading: false,
    error: null,
    refetch,
    isFetching: false,
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
          kind: state.reviewKind,
          matchedNamespaceId: 12,
          matchedDomain: 'peer.test',
          nextDomain: 'peer.test',
          claimedRoot: 'root-b',
          claim: { previousRoot: 'root-a' },
          status: 'pending',
          epochMatched: state.reviewEpochMatched,
          verifiedAt: null,
          reviewedAt: null,
          createdAt: null,
        },
      ],
    },
    isLoading: false,
    error: state.namespaceError,
    refetch: refetchNamespaces,
  }),
  useProbeFederationHealth: () => probe,
  useApproveFederationIdentityReview: () => approveReview,
  useRejectFederationIdentityReview: () => rejectReview,
  useBlockFederationPeer: () => block,
  useUnblockFederationPeer: () => unblock,
  useRecognizeFederationPeer: () => recognize,
}));

function renderPage(options?: { epochMatched?: boolean; tab?: string }) {
  if (options?.epochMatched !== undefined)
    state.reviewEpochMatched = options.epochMatched;
  return render(
    <MemoryRouter
      initialEntries={[
        `/federation/peer.test${options?.tab ? `?tab=${options.tab}` : ''}`,
      ]}
    >
      <Routes>
        <Route path="/federation/:domain" element={<PeerDetailPage />} />
      </Routes>
    </MemoryRouter>,
  );
}

describe('PeerDetailPage authorization', () => {
  beforeEach(() => {
    state.health = null;
    state.isAdmin = false;
    state.namespaceError = null;
    probe.mutateAsync
      .mockReset()
      .mockResolvedValue({
        namespaceId: 12,
        domain: 'peer.test',
        status: 'degraded',
      });
    refetch.mockClear();
    refetchNamespaces.mockClear();
    state.receipt = null;
    state.isSuper = false;
    state.trustLevel = 'available';
    state.haltCode = null;
    state.reviewEpochMatched = true;
    state.reviewKind = 'root-rotation';
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
    confirmMock.mockReset().mockReturnValue(true);
  });

  it('shows an empty receipt separately from synchronization progress', () => {
    renderPage({ tab: 'feed' });
    expect(screen.getByText('federation.receipt.empty')).toBeInTheDocument();
  });

  it('shows the received snapshot with all three timestamp labels', () => {
    state.receipt = {
      namespaceId: 12,
      stateFeedEndId: '123456789',
      profileNamespaceFeedEndId: '987654321',
      generatedAt: 1700000000000,
      sentAt: 1700000001000,
      receivedAt: 1700000002000,
      createdAt: 1700000002000,
      updatedAt: 1700000002000,
    };
    renderPage({ tab: 'feed' });
    for (const key of ['generatedAt', 'sentAt', 'receivedAt'])
      expect(screen.getByText(`federation.receipt.${key}`)).toBeInTheDocument();
    expect(screen.getByText('123456789')).toBeInTheDocument();
    expect(screen.getAllByText('987654321')).toHaveLength(1);
    expect(
      screen.queryByText('federation.receipt.empty'),
    ).not.toBeInTheDocument();
  });

  it('shows committed source times independently from push times', () => {
    renderPage({ tab: 'feed' });
    expect(screen.getByTitle('1700000003000')).toHaveAttribute(
      'datetime',
      '2023-11-14T22:13:23.000Z',
    );
    expect(screen.getByTitle('1700000004000')).toBeInTheDocument();
    expect(screen.getAllByRole('table')).toHaveLength(1);
    expect(screen.getByText('federation.inspect.scanHint')).toBeInTheDocument();
  });

  it('shows signing-key and pin timestamps on the identity tab', () => {
    renderPage({ tab: 'namespaces' });
    expect(
      screen.getByText('federation.inspect.signingKeyCreatedAt'),
    ).toBeInTheDocument();
    expect(screen.getByTitle('1700000000000')).toBeInTheDocument();
    expect(
      screen.getByText('federation.inspect.identityHint'),
    ).toBeInTheDocument();
  });

  it('shows namespace errors instead of an empty result', () => {
    state.namespaceError = new Error('namespace read failed');
    renderPage({ tab: 'namespaces' });
    expect(screen.getByRole('alert')).toHaveTextContent('Operation failed');
    expect(
      screen.queryByText('federation.namespaces.empty'),
    ).not.toBeInTheDocument();
  });

  it('refreshes current peer and namespaces without starting a probe', () => {
    renderPage();
    fireEvent.click(
      screen.getByRole('button', { name: 'federation.inspect.refresh' }),
    );
    expect(refetch).toHaveBeenCalledOnce();
    expect(refetchNamespaces).toHaveBeenCalledOnce();
    expect(probe.mutateAsync).not.toHaveBeenCalled();
  });

  it('does not probe on tab entry and hides probing from viewers', () => {
    renderPage({ tab: 'health' });
    expect(
      screen.getByText('federation.inspect.notProbed'),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole('button', { name: 'federation.inspect.probe' }),
    ).not.toBeInTheDocument();
    expect(probe.mutateAsync).not.toHaveBeenCalled();
  });

  it('lets an administrator probe the displayed namespace', async () => {
    state.isAdmin = true;
    state.health = {
      namespaceId: 12,
      domain: 'peer.test',
      status: 'degraded',
      error: null,
      source: 'manual',
      startedAt: 1700000000000,
      completedAt: 1700000001000,
      durationMs: 1000,
    };
    renderPage({ tab: 'health' });
    fireEvent.click(
      screen.getByRole('button', { name: 'federation.inspect.probe' }),
    );
    await waitFor(() =>
      expect(
        screen.getByText('federation.inspect.healthResult.degraded'),
      ).toBeInTheDocument(),
    );
    expect(probe.mutateAsync).toHaveBeenCalledWith(12);
    expect(
      screen.getByText('federation.inspect.probeCompletedAt'),
    ).toBeInTheDocument();
  });

  it('shows a probe failure separately from a remote unavailable response', async () => {
    state.isAdmin = true;
    probe.mutateAsync.mockRejectedValueOnce(new Error('network timeout'));
    renderPage({ tab: 'health' });
    fireEvent.click(
      screen.getByRole('button', { name: 'federation.inspect.probe' }),
    );
    await waitFor(() =>
      expect(screen.getByRole('alert')).toHaveTextContent('Operation failed'),
    );
    expect(
      screen.queryByText('federation.inspect.healthResult.unavailable'),
    ).not.toBeInTheDocument();
  });

  it('falls back to overview for an unknown tab', () => {
    renderPage({ tab: 'invalid' });
    expect(
      screen.getByRole('tab', { name: 'federation.detail.tabOverview' }),
    ).toHaveAttribute('aria-selected', 'true');
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

  it('lets a super administrator approve a pending rotation without a separate check action', async () => {
    state.isSuper = true;
    renderPage();

    fireEvent.click(screen.getByText('federation.detail.tabNamespaces'));

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

  it.each(['new-peer', 'replace-identity'] as const)(
    'offers explicit identity decision %s',
    async (resolution) => {
      state.isSuper = true;
      state.reviewKind = 'identity-reset';
      renderPage();
      fireEvent.click(screen.getByText('federation.detail.tabNamespaces'));
      fireEvent.click(
        screen.getByRole('button', {
          name: `federation.reviews.${resolution}`,
        }),
      );
      await waitFor(() =>
        expect(approveReview.mutateAsync).toHaveBeenCalledWith({
          reviewId: 7,
          resolution,
        }),
      );
    },
  );

  it('disables approval when the reviewed epoch has drifted from the live pin', async () => {
    state.isSuper = true;
    renderPage({ epochMatched: false });

    fireEvent.click(screen.getByText('federation.detail.tabNamespaces'));

    const approve = screen.getByRole('button', {
      name: 'federation.reviews.approve',
    });
    expect(approve).toBeDisabled();
    fireEvent.click(approve);
    expect(approveReview.mutateAsync).not.toHaveBeenCalled();
  });

  it('reports approval failure without showing success when automatic proof fails', async () => {
    state.isSuper = true;
    approveReview.mutateAsync.mockRejectedValueOnce(
      new Error('predecessor continuity check failed'),
    );
    renderPage();
    fireEvent.click(screen.getByText('federation.detail.tabNamespaces'));
    fireEvent.click(
      screen.getByRole('button', { name: 'federation.reviews.approve' }),
    );
    await waitFor(() => expect(toast.error).toHaveBeenCalledOnce());
    expect(approveReview.mutateAsync).toHaveBeenCalledWith(7);
    expect(toast.success).not.toHaveBeenCalled();
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
