import { fireEvent, render, screen } from '@testing-library/react';
import { createMemoryRouter, RouterProvider } from 'react-router-dom';
import { describe, expect, it, vi } from 'vitest';
import { RouteErrorPage } from './route-error-page';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

describe('RouteErrorPage', () => {
  it('returns to the previous history entry rather than a fixed destination', async () => {
    const router = createMemoryRouter(
      [
        { path: '/connections', element: <p>Previous page</p> },
        {
          path: '/broken',
          loader: () => {
            throw new Error('Page failed');
          },
          element: <p>Unavailable page</p>,
          errorElement: <RouteErrorPage />,
        },
      ],
      { initialEntries: ['/connections', '/broken'], initialIndex: 1 },
    );
    render(<RouterProvider router={router} />);

    fireEvent.click(
      await screen.findByRole('button', { name: 'routeError.back' }),
    );

    expect(await screen.findByText('Previous page')).toBeInTheDocument();
    expect(router.state.location.pathname).toBe('/connections');
  });
});
