import {
  fireEvent,
  render,
  screen,
  waitFor,
  cleanup,
} from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';
import { I18nextProvider } from 'react-i18next';
import { createInstance } from 'i18next';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import en from '@/locales/en/audit.json';
import zh from '@/locales/zh-CN/audit.json';
import {
  listAudit,
  getAuditActions,
  getAuditDetail,
  type AuditDetail,
} from '@/api/audit';
import { AuditPage } from './audit-page';
import { AuditDetailPage } from './audit-detail-page';

vi.mock('@/api/audit', () => ({
  listAudit: vi.fn(),
  getAuditActions: vi.fn(),
  getAuditDetail: vi.fn(),
}));
const record: AuditDetail = {
  id: '9007199254740993',
  adminId: 7,
  adminRole: 'ADMIN',
  action: 'user.disable',
  targetType: 'user',
  targetId: '42',
  targetLabel: 'alice',
  status: 'STARTED',
  createdAt: 1780272000000,
  updatedAt: 1780272000000,
  ip: '192.0.2.1',
  userAgent: 'test-agent',
  route: '/admin/users/42/disable',
  errorMessage: null,
  meta: { dailyMsgLimit: 10 },
};
function Location() {
  const location = useLocation();
  return (
    <output data-testid="location">
      {location.pathname}
      {location.search}
    </output>
  );
}
async function mount(url: string, language = 'en') {
  const i18n = createInstance();
  await i18n.init({
    lng: language,
    fallbackLng: 'en',
    resources: {
      en: {
        translation: {
          audit: en,
          common: {
            loading: 'Loading',
            next: 'Next',
            previous: 'Previous',
            page: 'Page {{page}} / {{pages}}',
          },
        },
      },
      'zh-CN': { translation: { audit: zh } },
    },
  });
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return render(
    <I18nextProvider i18n={i18n}>
      <QueryClientProvider client={client}>
        <MemoryRouter initialEntries={[url]}>
          <Location />
          <Routes>
            <Route path="/audit" element={<AuditPage />} />
            <Route path="/audit/:id" element={<AuditDetailPage />} />
          </Routes>
        </MemoryRouter>
      </QueryClientProvider>
    </I18nextProvider>,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(listAudit).mockResolvedValue({ list: [record], total: 150 });
  vi.mocked(getAuditActions).mockResolvedValue({ actions: ['user.disable'] });
  vi.mocked(getAuditDetail).mockResolvedValue(record);
});
afterEach(cleanup);

describe('operation audit', () => {
  it('shows readable summaries without operation JSON or mutation controls', async () => {
    await mount('/audit?status=STARTED&page=1&adminId=7');
    expect(
      await screen.findByText('Disable user', { selector: 'span' }),
    ).toBeInTheDocument();
    expect(
      screen.getByText('Started', { selector: 'span' }),
    ).toBeInTheDocument();
    expect(screen.getByText(/alice/)).toBeInTheDocument();
    expect(screen.queryByText('dailyMsgLimit')).not.toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'View details' })).toHaveAttribute(
      'href',
      `/audit/${record.id}`,
    );
    expect(listAudit).toHaveBeenCalledWith(
      expect.objectContaining({ skip: 50, adminId: 7, status: 'STARTED' }),
    );
    expect(
      screen.queryByRole('button', { name: /delete|edit/i }),
    ).not.toBeInTheDocument();
  });

  it('submits filters explicitly, resets pagination and preserves filters across detail navigation', async () => {
    await mount('/audit?status=STARTED&page=1&adminId=7');
    await screen.findByText('Disable user', { selector: 'span' });
    const calls = vi.mocked(listAudit).mock.calls.length;
    fireEvent.change(screen.getByRole('combobox', { name: /Operation/ }), {
      target: { value: 'user.' },
    });
    expect(listAudit).toHaveBeenCalledTimes(calls);
    fireEvent.click(screen.getByRole('button', { name: 'Search' }));
    await waitFor(() =>
      expect(listAudit).toHaveBeenLastCalledWith(
        expect.objectContaining({ action: 'user.', skip: 0 }),
      ),
    );
    const search = screen.getByTestId('location').textContent;
    fireEvent.click(await screen.findByRole('link', { name: 'View details' }));
    await screen.findByRole('heading', { name: `Audit record #${record.id}` });
    fireEvent.click(
      screen.getByRole('link', { name: 'Back to audit records' }),
    );
    await waitFor(() =>
      expect(screen.getByTestId('location').textContent).toBe(search),
    );
  });

  it('rejects reversed time filters without sending them', async () => {
    await mount('/audit');
    await screen.findByText('Disable user', { selector: 'span' });
    fireEvent.change(screen.getByLabelText('From (inclusive)'), {
      target: { value: '2026-06-02T00:00' },
    });
    fireEvent.change(screen.getByLabelText('Until (exclusive)'), {
      target: { value: '2026-06-01T00:00' },
    });
    const calls = vi.mocked(listAudit).mock.calls.length;
    fireEvent.click(screen.getByRole('button', { name: 'Search' }));
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Start time must precede end time.',
    );
    expect(listAudit).toHaveBeenCalledTimes(calls);
  });

  it('shows operation JSON only in details and copies it', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText },
    });
    await mount(`/audit/${record.id}`);
    expect(
      await screen.findByText(/No final result has been recorded/),
    ).toBeInTheDocument();
    expect(screen.getByText(/"dailyMsgLimit": 10/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Copy JSON' }));
    await waitFor(() =>
      expect(writeText).toHaveBeenCalledWith(
        JSON.stringify(record.meta, null, 2),
      ),
    );
    expect(getAuditDetail).toHaveBeenCalledWith(record.id);
  });

  it('handles empty data and unknown actions without legacy structure conversion', async () => {
    vi.mocked(getAuditDetail).mockResolvedValue({
      ...record,
      action: 'future.operation',
      meta: {},
    });
    await mount(`/audit/${record.id}`);
    expect(
      await screen.findByRole('heading', { name: 'future.operation' }),
    ).toBeInTheDocument();
    expect(
      screen.getByText('This operation has no additional recorded data.'),
    ).toBeInTheDocument();
  });

  it('translates action names in Chinese', async () => {
    await mount('/audit', 'zh-CN');
    expect(
      await screen.findByText('禁用用户', { selector: 'span' }),
    ).toBeInTheDocument();
    expect(
      screen.getByText('已开始', { selector: 'span' }),
    ).toBeInTheDocument();
  });

  it('reports detail failures without exposing server error strings', async () => {
    vi.mocked(getAuditDetail).mockRejectedValue(
      new Error('SQL internal secret'),
    );
    await mount('/audit/1');
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Unable to load audit records.',
    );
    expect(screen.queryByText('SQL internal secret')).not.toBeInTheDocument();
  });
});
