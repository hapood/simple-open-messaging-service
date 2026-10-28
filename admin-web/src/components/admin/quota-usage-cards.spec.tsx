import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { QuotaUsageCards } from './quota-usage-cards';
vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));
describe('symmetric quota usage cards', () => {
  it('renders all five dimensions including call budget and bytes', () => {
    render(
      <QuotaUsageCards
        usage={{
          messages: { count: 1, limit: 10 },
          requests: { count: 2, limit: 10 },
          signals: { count: 400, limit: 10000 },
          files: { count: 1, limit: 5 },
        }}
        fileBytes={{ bytes: '1048576', limit: 2097152 }}
        overrides={{ dailySignalLimit: 10000 }}
      />,
    );
    for (const dim of ['messages', 'requests', 'signals', 'files', 'fileBytes'])
      expect(screen.getByText(`quota.col.${dim}`)).toBeInTheDocument();
    expect(screen.getAllByRole('progressbar')).toHaveLength(5);
    expect(screen.getAllByText('quota.source.custom')).toHaveLength(1);
    expect(screen.getByText('1 MiB / 2 MiB')).toBeInTheDocument();
  });
});
