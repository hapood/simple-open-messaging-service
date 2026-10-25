import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { RouteTabs } from './route-tabs';

const TABS = [
  { to: '/sessions', label: 'User sessions' },
  { to: '/sessions/admins', label: 'Admin sessions' },
];

function renderAt(path: string) {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <RouteTabs tabs={TABS} />
    </MemoryRouter>,
  );
}

/** RouteTabs is the route-driven tab bar used by the five hubs. The active tab IS the current route,
 *  surfaced via NavLink's aria-current="page" — the semantically-honest indicator for navigation
 *  (not aria-selected + a tablist keyboard contract, since there is no in-page tabpanel to control). */
describe('RouteTabs', () => {
  it('marks the exact-matching tab active via aria-current="page"', () => {
    renderAt('/sessions/admins');
    expect(
      screen.getByRole('link', { name: 'Admin sessions' }),
    ).toHaveAttribute('aria-current', 'page');
    expect(
      screen.getByRole('link', { name: 'User sessions' }),
    ).not.toHaveAttribute('aria-current');
  });

  it('does NOT mark the index tab active on a sibling path (end semantics)', () => {
    renderAt('/sessions');
    expect(screen.getByRole('link', { name: 'User sessions' })).toHaveAttribute(
      'aria-current',
      'page',
    );
    expect(
      screen.getByRole('link', { name: 'Admin sessions' }),
    ).not.toHaveAttribute('aria-current');
  });

  it('renders one anchor per tab', () => {
    renderAt('/sessions');
    expect(
      screen.getByRole('link', { name: 'User sessions' }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole('link', { name: 'Admin sessions' }),
    ).toBeInTheDocument();
  });

  it('renders within a nav landmark', () => {
    renderAt('/sessions');
    expect(screen.getByRole('navigation')).toBeInTheDocument();
  });
});
