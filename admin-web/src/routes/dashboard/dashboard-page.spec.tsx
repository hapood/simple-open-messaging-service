import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { describe, expect, it, vi } from 'vitest';
import { DashboardPage } from './dashboard-page';

const state = vi.hoisted(() => ({ canManage: false }));
vi.mock('react-i18next', async (importOriginal) => ({
  ...(await importOriginal<typeof import('react-i18next')>()),
  useTranslation: () => ({ t: (key: string) => key }),
}));
vi.mock('@/hooks/use-me', () => ({
  useIsAdminPlus: () => state.canManage,
}));
vi.mock('@/hooks/use-dashboard', () => ({
  useDashboard: () => ({ data: undefined, isLoading: true, error: null }),
}));

describe('DashboardPage permissions', () => {
  it.each([false, true])(
    'gates user creation when canManage is %s',
    (canManage) => {
      state.canManage = canManage;
      render(
        <MemoryRouter>
          <DashboardPage />
        </MemoryRouter>,
      );
      const create = screen.queryByRole('link', {
        name: 'dashboard.createUser',
      });
      if (canManage) expect(create).toHaveAttribute('href', '/users?create=1');
      else expect(create).not.toBeInTheDocument();
      expect(
        screen.getByRole('link', { name: /dashboard.tile.totalUsers/ }),
      ).toHaveAttribute('href', '/users');
    },
  );
});
