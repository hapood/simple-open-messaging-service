import { describe, expect, it, vi } from 'vitest';
import { FederationMessageFeedGcService } from './federation-message-feed-gc.service.js';

type GcInternals = {
  scheduledSweep(): Promise<void>;
  databaseIsBusy(): Promise<boolean>;
  hasEmergencyBacklog(): Promise<boolean>;
  runOnce(): Promise<void>;
};

function makeService(): GcInternals {
  return new FederationMessageFeedGcService(
    {} as never,
  ) as unknown as GcInternals;
}

describe('FederationMessageFeedGcService scheduling', () => {
  it('skips an ordinary sweep while the database is busy', async () => {
    const service = makeService();
    vi.spyOn(service, 'databaseIsBusy').mockResolvedValue(true);
    vi.spyOn(service, 'hasEmergencyBacklog').mockResolvedValue(false);
    const run = vi.spyOn(service, 'runOnce').mockResolvedValue();

    await service.scheduledSweep();

    expect(run).not.toHaveBeenCalled();
  });

  it('runs an emergency over-limit sweep even while the database is busy', async () => {
    const service = makeService();
    vi.spyOn(service, 'databaseIsBusy').mockResolvedValue(true);
    vi.spyOn(service, 'hasEmergencyBacklog').mockResolvedValue(true);
    const run = vi.spyOn(service, 'runOnce').mockResolvedValue();

    await service.scheduledSweep();

    expect(run).toHaveBeenCalledOnce();
  });

  it('logs and absorbs a scheduling probe failure', async () => {
    const service = makeService();
    vi.spyOn(service, 'databaseIsBusy').mockRejectedValue(new Error('db busy'));
    const run = vi.spyOn(service, 'runOnce').mockResolvedValue();

    await expect(service.scheduledSweep()).resolves.toBeUndefined();
    expect(run).not.toHaveBeenCalled();
  });
});
