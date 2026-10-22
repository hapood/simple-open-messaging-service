import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { LogsLivePage } from './logs-live-page';
import { getLogOutputLevel, setLogOutputLevel } from '@/api/logs';
import { useLogStream } from '@/hooks/use-log-stream';

vi.mock('react-i18next', async (original) => ({
  ...(await original<typeof import('react-i18next')>()),
  useTranslation: () => ({ t: (key: string) => key }),
}));
vi.mock('@/api/logs', async (original) => ({
  ...(await original<typeof import('@/api/logs')>()),
  getLogOutputLevel: vi.fn(),
  setLogOutputLevel: vi.fn(),
}));
vi.mock('@/hooks/use-log-stream', () => ({
  useLogStream: vi.fn(() => ({
    lines: [{ level: 'info', msg: 'retained log', time: 1 }],
    state: 'open',
    clear: vi.fn(),
  })),
}));
vi.mock('react-virtuoso', () => ({
  Virtuoso: ({
    data,
    itemContent,
  }: {
    data: unknown[];
    itemContent: (index: number, item: unknown) => React.ReactNode;
  }) => (
    <div>
      {data.map((item, index) => (
        <div key={index}>{itemContent(index, item)}</div>
      ))}
    </div>
  ),
}));

function mount() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  render(
    <QueryClientProvider client={client}>
      <LogsLivePage />
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(getLogOutputLevel).mockResolvedValue({ level: 'error' });
});

describe('live log output control', () => {
  it('reads server state and changes production without filtering or clearing retained logs', async () => {
    vi.mocked(setLogOutputLevel).mockImplementation(async (level) => {
      vi.mocked(getLogOutputLevel).mockResolvedValue({ level });
      return { level };
    });
    mount();
    const select = screen.getByRole('combobox', { name: 'logs.outputLevel' });
    await waitFor(() => expect(select).toHaveTextContent('ERROR'));
    fireEvent.click(select);
    const option = await screen.findByRole('option', { name: 'DEBUG' });
    fireEvent.pointerDown(option, { pointerType: 'mouse' });
    fireEvent.click(option);
    await waitFor(() =>
      expect(setLogOutputLevel).toHaveBeenCalledWith(
        'debug',
        expect.anything(),
      ),
    );
    await waitFor(() => expect(select).toHaveTextContent('DEBUG'));
    expect(screen.getByText('retained log')).toBeInTheDocument();
    expect(
      vi.mocked(useLogStream).mock.calls.every((args) => args.length === 0),
    ).toBe(true);
    expect(screen.getByText('logs.outputLevelHint')).toBeInTheDocument();
    expect(screen.queryByText('logs.allLevels')).not.toBeInTheDocument();
  });

  it('keeps the confirmed output level when a change fails', async () => {
    vi.mocked(setLogOutputLevel).mockRejectedValue(new Error('change failed'));
    mount();
    const select = screen.getByRole('combobox', { name: 'logs.outputLevel' });
    await waitFor(() => expect(select).toHaveTextContent('ERROR'));
    fireEvent.click(select);
    const option = await screen.findByRole('option', { name: 'DEBUG' });
    fireEvent.pointerDown(option, { pointerType: 'mouse' });
    fireEvent.click(option);
    await waitFor(() => expect(setLogOutputLevel).toHaveBeenCalled());
    await waitFor(() => expect(select).not.toBeDisabled());
    expect(select).toHaveTextContent('ERROR');
    expect(screen.getByText('retained log')).toBeInTheDocument();
  });

  it('disables changes and displays a read error without assuming a default value', async () => {
    vi.mocked(getLogOutputLevel).mockRejectedValue(new Error('read failed'));
    mount();
    expect(await screen.findByRole('alert')).toBeInTheDocument();
    expect(
      screen.getByRole('combobox', { name: 'logs.outputLevel' }),
    ).toBeDisabled();
    expect(setLogOutputLevel).not.toHaveBeenCalled();
  });
});
