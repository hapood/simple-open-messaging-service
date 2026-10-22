import { describe, expect, it, vi } from 'vitest';
import { ProfileNamespaceResolutionService } from './profile-namespace-resolution.service.js';

const pair = { publisherNamespaceId: 12, profileNamespaceId: 9 };
const entry = {
  ...pair,
  domain: 'subject.test',
  rootPublicKey: 'root',
  updateFeedId: 3,
  expired: false,
  status: 'ACTIVE',
};
function harness(row: unknown) {
  const store = { readOne: vi.fn().mockResolvedValue(row) };
  const refresh = { fetch: vi.fn().mockResolvedValue(undefined) };
  return {
    service: new ProfileNamespaceResolutionService(
      store as never,
      refresh as never,
    ),
    store,
    refresh,
  };
}

describe('ProfileNamespaceResolutionService client demand', () => {
  it('returns a usable cache binding without creating fetch work', async () => {
    const { service, refresh } = harness(entry);
    expect(await service.resolveOne(pair)).toEqual({ status: 'READY', entry });
    expect(refresh.fetch).not.toHaveBeenCalled();
  });

  it.each([
    null,
    { ...entry, expired: true },
    { ...entry, domain: null },
    { ...entry, rootPublicKey: null },
  ])(
    'creates or joins fetch work for missing or unusable cache data',
    async (row) => {
      const { service, refresh } = harness(row);
      expect(await service.resolveOne(pair)).toEqual({ status: 'PENDING' });
      expect(refresh.fetch).toHaveBeenCalledWith(pair);
    },
  );

  it('does not return PENDING until fetch work has actually been created or joined', async () => {
    const { service, refresh } = harness(null);
    refresh.fetch.mockRejectedValueOnce(new Error('publisher unavailable'));
    await expect(service.resolveOne(pair)).rejects.toThrow(
      'publisher unavailable',
    );
    expect(await service.resolveOne(pair)).toEqual({ status: 'PENDING' });
  });

  it('returns READY after a demand completes and the cache becomes usable', async () => {
    const { service, store, refresh } = harness({ ...entry, expired: true });
    expect(await service.resolveOne(pair)).toEqual({ status: 'PENDING' });
    store.readOne.mockResolvedValue(entry);
    expect(await service.resolveOne(pair)).toEqual({ status: 'READY', entry });
    expect(refresh.fetch).toHaveBeenCalledOnce();
  });

  it('keeps authoritative local answers synchronous, including archived subjects', async () => {
    const local = {
      ...entry,
      publisherNamespaceId: 0,
      expired: true,
      domain: null,
      rootPublicKey: null,
      status: 'ARCHIVED',
    };
    const { service, refresh } = harness(local);
    expect(
      await service.resolveOne({ ...pair, publisherNamespaceId: 0 }),
    ).toEqual({ status: 'READY', entry: local });
    expect(refresh.fetch).not.toHaveBeenCalled();
  });
});
