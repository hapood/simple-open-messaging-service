import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NetworkPage } from './network-page';
const mocks = vi.hoisted(() => ({ diagnose: vi.fn(), role: 'ADMIN' }));
vi.mock('@/api/network', () => ({ diagnoseNetwork: mocks.diagnose }));
vi.mock('@/hooks/use-me', () => ({
  useMe: () => ({ data: { role: mocks.role } }),
}));
vi.mock('react-i18next', async (importOriginal) => ({
  ...(await importOriginal<typeof import('react-i18next')>()),
  useTranslation: () => ({ t: (key: string) => key }),
}));
function mount() {
  return render(
    <QueryClientProvider
      client={
        new QueryClient({ defaultOptions: { mutations: { retry: false } } })
      }
    >
      <NetworkPage />
    </QueryClientProvider>,
  );
}
describe('NetworkPage', () => {
  beforeEach(() => {
    mocks.role = 'ADMIN';
    mocks.diagnose.mockReset().mockResolvedValue({
      target: 'example.com',
      policy: {
        freshConnection: true,
        publicDestinationsOnly: true,
        connectTimeoutMs: 12000,
        callTimeoutMs: 12000,
      },
      route: {
        domain: 'example.com',
        host: 'edge.example.net',
        port: 7668,
        origin: 'https://example.com:7668',
      },
      checkedAt: 1000,
      durationMs: 1,
      checks: [],
    });
  });
  it.each(['example.com', 'peer.example'])(
    'submits domain input %s only after an explicit click',
    async (target) => {
      mount();
      expect(mocks.diagnose).not.toHaveBeenCalled();
      expect(
        screen.getByRole('button', { name: 'networkTools.run' }),
      ).toBeDisabled();
      expect(screen.getByRole('textbox')).toHaveAttribute(
        'placeholder',
        'example.com',
      );
      fireEvent.change(screen.getByRole('textbox'), {
        target: { value: `  ${target}  ` },
      });
      expect(mocks.diagnose).not.toHaveBeenCalled();
      fireEvent.click(screen.getByRole('button', { name: 'networkTools.run' }));
      await waitFor(() => expect(mocks.diagnose).toHaveBeenCalled());
      expect(mocks.diagnose.mock.calls[0][0]).toBe(target);
      expect(
        await screen.findByText(/edge\.example\.net:7668/),
      ).toHaveTextContent('https://example.com:7668/.well-known/somfp');
    },
  );
  it('keeps active probes unavailable to viewers', () => {
    mocks.role = 'VIEWER';
    mount();
    fireEvent.change(screen.getByRole('textbox'), {
      target: { value: 'example.com' },
    });
    expect(
      screen.getByRole('button', { name: 'networkTools.run' }),
    ).toBeDisabled();
  });
});
