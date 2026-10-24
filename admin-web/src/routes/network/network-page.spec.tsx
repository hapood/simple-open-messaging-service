import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NetworkPage } from './network-page';

const mocks = vi.hoisted(() => ({
  diagnose: vi.fn(),
  getNetworkInfo: vi.fn(),
  probeNetworkIp: vi.fn(),
  role: 'ADMIN',
}));
vi.mock('@/api/network', () => ({
  diagnoseNetwork: mocks.diagnose,
  getNetworkInfo: mocks.getNetworkInfo,
  probeNetworkIp: mocks.probeNetworkIp,
}));
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
        new QueryClient({
          defaultOptions: {
            queries: { retry: false },
            mutations: { retry: false },
          },
        })
      }
    >
      <NetworkPage />
    </QueryClientProvider>,
  );
}
describe('NetworkPage', () => {
  beforeEach(() => {
    mocks.role = 'ADMIN';
    mocks.getNetworkInfo.mockReset().mockResolvedValue({
      checkedAt: 1000,
      runtime: 'docker',
      interfaces: [
        { name: 'eth0', address: '172.20.0.2', family: 4, scope: 'private' },
      ],
      sources: [
        {
          id: 'ip-sb',
          label: 'IP.SB',
          ipv4: 'https://api-ipv4.ip.sb/ip',
          ipv6: 'https://api-ipv6.ip.sb/ip',
        },
      ],
    });
    mocks.probeNetworkIp.mockReset().mockResolvedValue({
      source: 'ip-sb',
      family: 4,
      checkedAt: 1000,
      durationMs: 10,
      status: 'ok',
      ip: '1.1.1.1',
    });
    mocks.diagnose.mockReset().mockResolvedValue({
      target: 'example.com',
      policy: {
        freshConnection: true,
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

  it('renders tabs and loads local interfaces on the external IP tab', async () => {
    mount();
    expect(
      screen.getByRole('tab', { name: 'networkInspection.tabExternal' }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole('tab', { name: 'networkInspection.tabDiagnostics' }),
    ).toBeInTheDocument();
    expect(await screen.findByText('172.20.0.2')).toBeInTheDocument();
  });

  it.each(['example.com', 'peer.example'])(
    'submits domain input %s only after switching to diagnostics tab and explicit click',
    async (target) => {
      mount();
      fireEvent.click(
        screen.getByRole('tab', { name: 'networkInspection.tabDiagnostics' }),
      );
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
  it('keeps active probes unavailable to viewers', async () => {
    mocks.role = 'VIEWER';
    mount();
    expect(
      await screen.findByRole('button', {
        name: 'networkInspection.detect',
      }),
    ).toBeDisabled();
    fireEvent.click(
      screen.getByRole('tab', { name: 'networkInspection.tabDiagnostics' }),
    );
    fireEvent.change(screen.getByRole('textbox'), {
      target: { value: 'example.com' },
    });
    expect(
      screen.getByRole('button', { name: 'networkTools.run' }),
    ).toBeDisabled();
  });
});
