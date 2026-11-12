import { fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { describe, expect, it, vi } from 'vitest';
import { QuotaOverviewPage } from './quota-overview-page';
const state = vi.hoisted(() => ({ super: true }));
vi.mock('react-i18next', async (original) => ({
  ...(await original<typeof import('react-i18next')>()),
  useTranslation: () => ({ t: (key: string) => key }),
}));
vi.mock('@/hooks/use-me', () => ({ useIsSuperAdmin: () => state.super }));
vi.mock('@/hooks/use-quota', () => ({
  useBreakers: () => ({
    data: {
      peers: [],
      users: [
        {
          entity: '42',
          userId: 42,
          requests: { count: 0, limit: 50 },
          signals: { count: 0, limit: 10000 },
          scope: 'user',
          msg: { count: 10, limit: 5 },
          file: { count: 0, limit: 5 },
          fileBytes: { bytes: '0', limit: 10 },
          trippedDims: ['messages'],
        },
      ],
    },
    refetch: vi.fn(),
  }),
}));
vi.mock('@/components/admin/continue-quota-dialog', () => ({
  ContinueQuotaDialog: ({ breaker }: { breaker: { entity: string } }) => (
    <div role="dialog">{breaker.entity}</div>
  ),
}));
describe('quota overview', () => {
  it('links to existing object details and reuses the daily-allowance dialog', () => {
    state.super = true;
    render(
      <MemoryRouter>
        <QuotaOverviewPage />
      </MemoryRouter>,
    );
    expect(
      screen.getByRole('link', { name: 'quotaCenter.user · 42' }),
    ).toHaveAttribute('href', '/users/42');
    fireEvent.click(
      screen.getByRole('button', { name: 'quota.breaker.review' }),
    );
    expect(screen.getByRole('dialog')).toHaveTextContent('42');
  });
  it('does not offer additions to non-super administrators', () => {
    state.super = false;
    render(
      <MemoryRouter>
        <QuotaOverviewPage />
      </MemoryRouter>,
    );
    expect(
      screen.queryByRole('button', { name: 'quota.breaker.review' }),
    ).not.toBeInTheDocument();
  });
});
