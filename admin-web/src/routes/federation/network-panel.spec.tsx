import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NetworkPanel } from './network-panel';
import { SectionNav } from './section-nav';

const api = vi.hoisted(() => ({
  getNetworkInfo: vi.fn(),
  probeNetworkIp: vi.fn(),
}));
vi.mock('@/api/federation', () => api);
vi.mock('react-i18next', async (importOriginal) => ({
  ...(await importOriginal<typeof import('react-i18next')>()),
  useTranslation: () => ({ t: (key: string) => key }),
}));
const info = {
  checkedAt: 1,
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
    {
      id: 'ipify',
      label: 'ipify',
      ipv4: 'https://api.ipify.org',
      ipv6: 'https://api6.ipify.org',
    },
  ],
};
const key = (name: string) => `federation.selfCheck.network.${name}`;
function mount() {
  return render(
    <QueryClientProvider
      client={
        new QueryClient({ defaultOptions: { queries: { retry: false } } })
      }
    >
      <NetworkPanel />
    </QueryClientProvider>,
  );
}
beforeEach(() => {
  api.getNetworkInfo.mockReset().mockResolvedValue(info);
  api.probeNetworkIp.mockReset().mockImplementation(async (source, family) => ({
    source,
    family,
    checkedAt: 1,
    durationMs: 10,
    status: 'ok',
    ip: family === 4 ? '1.1.1.1' : '2606:4700::1111',
  }));
});
afterEach(cleanup);
it('loads local addresses without making third-party probes', async () => {
  mount();
  expect(await screen.findByText('172.20.0.2')).toBeInTheDocument();
  expect(screen.getByText(key('runtime.docker'))).toBeInTheDocument();
  expect(api.probeNetworkIp).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole('button', { name: key('refreshLocal') }));
  await waitFor(() => expect(api.getNetworkInfo).toHaveBeenCalledTimes(2));
  expect(api.probeNetworkIp).not.toHaveBeenCalled();
});
it('runs only selected sources for both families and shows partial results immediately', async () => {
  let finish!: (value: unknown) => void;
  api.probeNetworkIp.mockImplementation((_source, family) =>
    family === 4
      ? Promise.resolve({
          family,
          status: 'ok',
          ip: '1.1.1.1',
          checkedAt: 1,
          durationMs: 1,
        })
      : new Promise((resolve) => {
          finish = resolve;
        }),
  );
  mount();
  await screen.findByText('172.20.0.2');
  fireEvent.click(screen.getByRole('button', { name: key('detect') }));
  expect(await screen.findByText('1.1.1.1')).toBeInTheDocument();
  expect(api.probeNetworkIp.mock.calls).toEqual([
    ['ip-sb', 4],
    ['ip-sb', 6],
  ]);
  expect(screen.getByRole('button', { name: key('detect') })).toBeDisabled();
  await act(async () =>
    finish({
      family: 6,
      status: 'warn',
      code: 'EADDRNOTAVAIL',
      checkedAt: 1,
      durationMs: 1,
    }),
  );
  expect(
    await screen.findByText(key('error.EADDRNOTAVAIL')),
  ).toBeInTheDocument();
  expect(screen.getByRole('button', { name: key('detect') })).toBeEnabled();
});
it('supports multiple sources and no selection', async () => {
  mount();
  await screen.findByText('172.20.0.2');
  fireEvent.click(screen.getByRole('checkbox', { name: 'ipify' }));
  fireEvent.click(screen.getByRole('button', { name: key('detect') }));
  await waitFor(() => expect(api.probeNetworkIp).toHaveBeenCalledTimes(4));
  await waitFor(() =>
    expect(screen.getByRole('button', { name: key('detect') })).toBeEnabled(),
  );
  fireEvent.click(screen.getByRole('checkbox', { name: 'IP.SB' }));
  fireEvent.click(screen.getByRole('checkbox', { name: 'ipify' }));
  expect(screen.getByRole('button', { name: key('detect') })).toBeDisabled();
});
it('renders API errors without hiding successful sibling results', async () => {
  api.probeNetworkIp.mockImplementation(async (_source, family) => {
    if (family === 6) throw new Error('probe failed');
    return { family, status: 'ok', ip: '1.1.1.1', durationMs: 1, checkedAt: 1 };
  });
  mount();
  await screen.findByText('172.20.0.2');
  fireEvent.click(screen.getByRole('button', { name: key('detect') }));
  expect(await screen.findByText('1.1.1.1')).toBeInTheDocument();
  await waitFor(() =>
    expect(screen.getByRole('button', { name: key('detect') })).toBeEnabled(),
  );
});
describe('section navigation', () => {
  it('links to sections, focuses the target and respects reduced motion', () => {
    const scroll = vi.fn();
    vi.stubGlobal('matchMedia', () => ({ matches: true }));
    render(
      <main>
        <SectionNav
          sections={[
            { id: 'network', label: 'Network' },
            { id: 'dns', label: 'DNS', issues: 1 },
          ]}
        />
        <section id="network" tabIndex={-1} />
        <section id="dns" tabIndex={-1} />
      </main>,
    );
    const section = document.getElementById('dns')!;
    section.scrollIntoView = scroll;
    fireEvent.click(screen.getByRole('link', { name: /DNS/ }));
    expect(scroll).toHaveBeenCalledWith({
      behavior: 'instant',
      block: 'start',
    });
    expect(section).toHaveFocus();
    expect(screen.getByRole('link', { name: /DNS/ })).toHaveAttribute(
      'aria-current',
      'location',
    );
    vi.unstubAllGlobals();
  });
});
