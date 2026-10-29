import { fireEvent, render, screen, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { MemoryRouter } from 'react-router-dom';
import { changeAppLanguage } from '@/i18n';
import { TransportConfigPanel } from './transport-config-panel';
import { ServerKeysPage } from '@/routes/settings/server-keys-page';

const queries = vi.hoisted(() => ({
  settings: {
    isPending: false,
    error: null as Error | null,
    data: {
      configurationDirectory: '/mounted/config',
      fcmConfigured: false,
      firebase: {
        configured: false,
        filePath: '/mounted/config/google-services.json',
      },
    },
  },
  keys: {
    isPending: false,
    error: null as Error | null,
    data: [
      {
        id: 'vapid',
        kind: 'asymmetric',
        configured: true,
        valid: true,
        filePath: '/mounted/config/vapid-key.json',
        fingerprint: 'abc123',
      },
      {
        id: 'firebase-service-account',
        kind: 'external',
        configured: false,
        valid: false,
        filePath: '/mounted/config/firebase-service-account.json',
      },
      {
        id: 'federation-root',
        kind: 'asymmetric',
        available: true,
        databaseTable: 'LocalFederationRoot',
      },
      {
        id: 'admin-jwt',
        kind: 'symmetric',
        configured: true,
        valid: true,
        filePath: '/mounted/config/jwt-admin.key',
      },
    ],
  },
  check: { isPending: false, mutateAsync: vi.fn() },
}));
vi.mock('@/hooks/use-settings', () => ({
  useAdminSettings: () => queries.settings,
  useServerKeys: () => queries.keys,
  useVapidHealthCheck: () => queries.check,
}));

describe('push channel configuration', () => {
  beforeEach(async () => {
    queries.settings.error = null;
    queries.keys.error = null;
    await changeAppLanguage('zh-CN');
  });

  it('shows expected paths and placement instructions even when FCM files are missing', () => {
    render(<TransportConfigPanel />);
    const fcm = screen.getByRole('region', { name: 'FCM 服务端发送凭据' });
    expect(within(fcm).getByText('未配置')).toBeInTheDocument();
    expect(
      within(fcm).getByText('/mounted/config/firebase-service-account.json'),
    ).toBeInTheDocument();
    expect(within(fcm).getByText(/从 Firebase 控制台下载/)).toBeInTheDocument();
    expect(
      screen.getByText('/mounted/config/google-services.json'),
    ).toBeInTheDocument();
    expect(screen.getAllByText(/新增或替换后，请重启服务/)).toHaveLength(3);
    expect(screen.queryByText('管理员 JWT 密钥')).not.toBeInTheDocument();
    expect(screen.queryByText('联邦根密钥')).not.toBeInTheDocument();
  });

  it('explains VAPID on click and keeps diagnostic metadata collapsed', async () => {
    render(<TransportConfigPanel />);
    expect(screen.getByText('abc123').closest('details')).not.toHaveAttribute(
      'open',
    );
    expect(screen.getByText('/mounted/config/vapid-key.json')).toBeVisible();
    fireEvent.click(
      screen.getByRole('button', { name: '查看用途：Web Push VAPID' }),
    );
    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByText(/需要重新订阅/)).toBeInTheDocument();
  });

  it('does not turn API errors into missing-configuration statuses', () => {
    queries.settings.error = new Error('settings unavailable');
    queries.keys.error = new Error('keys unavailable');
    render(<TransportConfigPanel />);
    expect(screen.getAllByRole('alert')).toHaveLength(3);
    expect(screen.queryByText('未配置')).not.toBeInTheDocument();
    expect(
      screen.queryByText('/mounted/config/firebase-service-account.json'),
    ).not.toBeInTheDocument();
  });

  it('keeps non-push keys on the settings page and identifies file versus database storage', () => {
    render(
      <MemoryRouter>
        <ServerKeysPage />
      </MemoryRouter>,
    );
    expect(
      screen.getByText('/mounted/config/jwt-admin.key'),
    ).toBeInTheDocument();
    expect(screen.getByText('LocalFederationRoot')).toBeInTheDocument();
    expect(
      screen.queryByRole('region', { name: 'Web Push VAPID' }),
    ).not.toBeInTheDocument();
  });
});
