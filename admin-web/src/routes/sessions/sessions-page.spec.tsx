import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { SessionsPage } from './sessions-page';
const query = vi.hoisted(() => vi.fn());
vi.mock('react-i18next', async (importOriginal) => ({
  ...(await importOriginal<typeof import('react-i18next')>()),
  useTranslation: () => ({ t: (key: string) => key }),
}));
vi.mock('@/hooks/use-me', () => ({ useIsSuperAdmin: () => false }));
vi.mock('@/hooks/use-sessions', () => ({
  useAllSessions: query,
  usePurgeSessions: () => ({ mutateAsync: vi.fn(), isPending: false }),
}));
vi.mock('./session-table', () => ({
  SessionTable: () => <div>session table</div>,
}));
const mount = (url: string) =>
  render(
    <MemoryRouter initialEntries={[url]}>
      <SessionsPage />
    </MemoryRouter>,
  );
describe('SessionsPage filters', () => {
  beforeEach(() =>
    query
      .mockReset()
      .mockReturnValue({ data: { list: [], total: 0 }, isLoading: false }),
  );
  it('loads a linked user scope with IP and client filters', () => {
    mount('/sessions?userId=42&q=192.0.2&client=desktop&p=2');
    expect(query).toHaveBeenLastCalledWith(
      { userId: 42, ip: '192.0.2', client: 'desktop', skip: 100, take: 50 },
      true,
    );
  });
  it('resets pagination when switching client filters', async () => {
    mount('/sessions?userId=42&p=2');
    fireEvent.change(screen.getByRole('combobox'), {
      target: { value: 'web' },
    });
    await waitFor(() =>
      expect(query).toHaveBeenLastCalledWith(
        { userId: 42, ip: undefined, client: 'web', skip: 0, take: 50 },
        true,
      ),
    );
  });
  it('does not broaden an invalid user scope into an unfiltered request', () => {
    mount('/sessions?userId=-1');
    expect(query.mock.lastCall?.[1]).toBe(false);
    expect(screen.getByRole('alert')).toHaveTextContent(
      'sessions.invalidFilters',
    );
    expect(screen.queryByText('session table')).not.toBeInTheDocument();
  });
});
