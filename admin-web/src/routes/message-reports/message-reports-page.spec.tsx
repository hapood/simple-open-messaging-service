import { render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { MessageReportsPage } from './message-reports-page';

const fixture = vi.hoisted(() => ({ deleted: false }));
vi.mock('react-i18next', async (importOriginal) => ({
  ...(await importOriginal<typeof import('react-i18next')>()),
  useTranslation: () => ({ t: (key: string) => key }),
}));
vi.mock('@/hooks/use-me', () => ({ useIsAdminPlus: () => true }));
vi.mock('@/hooks/use-message-reports', () => ({
  useMessageReports: () => ({
    data: {
      total: 1,
      list: [
        {
          threadId: 7,
          seq: 1,
          isDeleted: false,
          createdAt: 1,
          updatedAt: 1,
          creator: { name: 'Sender', account: 'sender', domain: 'local' },
          threadType: 'P2P',
          message: {
            content: '{"text":"<script>raw</script>"}',
            contentType: 'PURE_TEXT',
            isDeleted: fixture.deleted,
          },
        },
      ],
    },
    isLoading: false,
    error: null,
  }),
  useDismissMessageReport: () => ({ isPending: false }),
  useDeleteReportedMessages: () => ({ isPending: false }),
}));

describe('message report content', () => {
  beforeEach(() => {
    fixture.deleted = false;
  });

  it('renders raw content as text without extracting JSON fields or HTML', () => {
    const { container } = render(<MessageReportsPage />);
    expect(
      screen.getByText('{"text":"<script>raw</script>"}'),
    ).toBeInTheDocument();
    expect(container.querySelector('script')).toBeNull();
  });

  it('replaces deleted content with a placeholder and hides message deletion actions', () => {
    fixture.deleted = true;
    render(<MessageReportsPage />);
    expect(screen.getByText('messageReports.deleted')).toBeInTheDocument();
    expect(
      screen.queryByText('{"text":"<script>raw</script>"}'),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByTitle('messageReports.deleteMessage'),
    ).not.toBeInTheDocument();
  });
});
