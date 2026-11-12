import { fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { AdminLayout, NAV_COLLAPSED_KEY } from './admin-layout';

vi.mock('@/auth/auth-context', () => ({
  useAuth: () => ({ logout: vi.fn(), isAuthenticated: true }),
}));

vi.mock('@/hooks/use-me', () => ({
  useMe: () => ({
    data: {
      name: 'Admin',
      role: 'SUPER_ADMIN',
      somsDomain: 'node.example.org',
    },
  }),
}));

vi.mock('@/components/admin/breaker-banner', () => ({
  BreakerBanner: () => null,
}));

const t = (key: string) => {
  const dict: Record<string, string> = {
    'common.appName': 'SOMS Admin',
    'topBar.closeNavigation': 'Close navigation',
    'topBar.openNavigation': 'Open navigation',
    'topBar.toggleTheme': 'Toggle theme',
    'topBar.search': 'Search',
    'roles.super': 'Super Admin',
    'nav.collapse': 'Collapse navigation',
    'nav.expand': 'Expand navigation',
    'nav.logout': 'Sign out',
    'nav.security': 'My Account',
    'nav.users': 'Users',
    'nav.dashboard': 'Dashboard',
    'nav.group.users': 'Users & Content',
    'nav.group.security': 'Login & Security',
    'nav.group.monitoring': 'Monitoring',
    'nav.group.account': 'Account',
    'language.label': 'Language',
  };
  return dict[key] || key;
};

vi.mock('react-i18next', async (importOriginal) => ({
  ...(await importOriginal<typeof import('react-i18next')>()),
  useTranslation: () => ({
    t,
    i18n: { language: 'en', changeLanguage: vi.fn(), t },
  }),
}));

function renderLayout() {
  return render(
    <MemoryRouter initialEntries={['/users']}>
      <AdminLayout>
        <div>Content</div>
      </AdminLayout>
    </MemoryRouter>,
  );
}

describe('AdminLayout', () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it('renders expanded drawer by default with scroll container and collapse button', () => {
    renderLayout();

    const collapseBtn = screen.getByRole('button', {
      name: 'Collapse navigation',
    });
    expect(collapseBtn).toBeInTheDocument();

    const aside = collapseBtn.closest('aside');
    expect(aside).toHaveClass('lg:w-60');

    const nav = aside?.querySelector('nav');
    expect(nav).toHaveClass('sidebar-scroll');
    expect(nav).toHaveClass('overflow-y-auto');
  });

  it('collapses drawer when collapse button is clicked and aligns My Account and Logout', () => {
    renderLayout();

    const collapseBtn = screen.getByRole('button', {
      name: 'Collapse navigation',
    });
    fireEvent.click(collapseBtn);

    expect(localStorage.getItem(NAV_COLLAPSED_KEY)).toBe('1');

    const expandBtn = screen.getByRole('button', { name: 'Expand navigation' });
    expect(expandBtn).toBeInTheDocument();

    const aside = expandBtn.closest('aside');
    expect(aside).toHaveClass('lg:w-16');

    // Verify My Account and Logout both have the exact same collapsed centering classes
    const myAccountLink = screen.getByTitle('My Account');
    expect(myAccountLink).toHaveClass('lg:size-9');
    expect(myAccountLink).toHaveClass('lg:justify-center');
    expect(myAccountLink).toHaveClass('lg:mx-auto');

    const logoutBtn = screen.getByRole('button', { name: 'Sign out' });
    expect(logoutBtn).toHaveClass('lg:size-9');
    expect(logoutBtn).toHaveClass('lg:justify-center');
    expect(logoutBtn).toHaveClass('lg:mx-auto');
  });

  it('supports expanding drawer back to full width', () => {
    localStorage.setItem(NAV_COLLAPSED_KEY, '1');
    renderLayout();

    const expandBtn = screen.getByRole('button', { name: 'Expand navigation' });
    fireEvent.click(expandBtn);

    expect(localStorage.getItem(NAV_COLLAPSED_KEY)).toBe('0');
    expect(
      screen.getByRole('button', { name: 'Collapse navigation' }),
    ).toBeInTheDocument();
  });

  it('supports collapsing and expanding navigation groups', () => {
    renderLayout();

    const overviewGroupBtn = screen.getByRole('button', {
      name: 'Users & Content',
    });
    expect(overviewGroupBtn).toBeInTheDocument();
    expect(
      screen.queryByRole('button', { name: 'Dashboard' }),
    ).not.toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Dashboard' })).toHaveAttribute(
      'href',
      '/dashboard',
    );

    // Clicking group toggle collapses the items in the group
    fireEvent.click(overviewGroupBtn);
    expect(screen.queryByTitle('Users')).not.toBeInTheDocument();

    // Clicking again expands it back
    fireEvent.click(overviewGroupBtn);
    expect(screen.getByTitle('Users')).toBeInTheDocument();
  });
});
