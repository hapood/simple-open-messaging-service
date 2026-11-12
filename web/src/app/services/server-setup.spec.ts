import { firstValueFrom } from 'rxjs';
import {
  beginServerSetup,
  cancelServerSetup,
  checkServerSetup,
  commitServerSetup,
} from './server-setup';
import { apiOrigin, apiOriginSecondary } from './runtime';

describe('server setup observables', () => {
  const invoke =
    vi.fn<
      (command: string, args?: Record<string, unknown>) => Promise<unknown>
    >();
  beforeEach(() => {
    invoke.mockReset();
    window.__TAURI_INTERNALS__ = {};
    window.__TAURI__ = { core: { invoke } };
  });
  afterEach(() => {
    delete window.__TAURI_INTERNALS__;
    delete window.__TAURI__;
    delete window.SomsSecureStore;
    apiOrigin.set('');
    apiOriginSecondary.set(null);
  });

  it('begins an admission and verifies against the requested origin', async () => {
    invoke.mockImplementation((command: string) =>
      command === 'begin_server_setup'
        ? Promise.resolve('setup-1')
        : Promise.resolve({
            primaryOrigin: 'https://server.example',
            lanOrigin: null,
          }),
    );
    await expect(firstValueFrom(beginServerSetup())).resolves.toBe('setup-1');
    await expect(
      firstValueFrom(checkServerSetup('setup-1', 'https://entered.example')),
    ).resolves.toMatchObject({ primaryOrigin: 'https://server.example' });
    expect(invoke).toHaveBeenCalledWith('check_server_setup', {
      id: 'setup-1',
      origin: 'https://entered.example',
    });
  });

  it('mirrors the committed pair together', async () => {
    const record = vi.fn();
    window.SomsSecureStore = {
      getApiOrigin: () => null,
      getApiOriginSecondary: () => null,
      recordServerOrigins: record,
    };
    invoke.mockImplementation((command: string) =>
      command === 'commit_server_setup'
        ? Promise.resolve({
            origins: { primary: 'https://server.example', secondary: null },
            active: 'https://server.example',
          })
        : Promise.reject(new Error(`unexpected ${command}`)),
    );
    const result = await firstValueFrom(commitServerSetup('setup-1', true));
    expect(result.origins.primary).toBe('https://server.example');
    expect(apiOrigin()).toBe('https://server.example');
    expect(apiOriginSecondary()).toBeNull();
    expect(record).toHaveBeenCalledWith(
      'https://server.example',
      null,
      'primary',
    );
  });

  it('commit failures surface to the caller instead of half-applying the mirror', async () => {
    invoke.mockImplementation((command: string) =>
      command === 'commit_server_setup'
        ? Promise.reject(new Error('login is in progress'))
        : Promise.resolve('setup-1'),
    );
    await expect(
      firstValueFrom(commitServerSetup('setup-1', true)),
    ).rejects.toThrow('login is in progress');
    expect(apiOrigin()).toBe('');
  });

  it('cancellation swallows transport errors: nothing is queued or retried', async () => {
    invoke.mockRejectedValue(new Error('renderer gone'));
    await expect(
      firstValueFrom(cancelServerSetup('setup-1')),
    ).resolves.toBeUndefined();
  });
});
