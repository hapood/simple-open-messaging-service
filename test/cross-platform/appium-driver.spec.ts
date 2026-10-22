import { afterEach, describe, expect, it, vi } from 'vitest';
import { AndroidDriver } from './appium-driver.js';

// Exercise the public session command rather than exposing the HTTP helper.
describe('Appium response validation', () => {
  afterEach(() => vi.unstubAllGlobals());

  it.each([
    null,
    [],
    'invalid',
    42,
    { value: { error: 'session not created' } },
  ])('rejects a malformed or failed session response: %j', async (body) => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(JSON.stringify(body))),
    );
    await expect(new AndroidDriver().open('')).rejects.toThrow(
      'Appium POST /session:',
    );
  });

  it('rejects invalid JSON and HTTP failures', async () => {
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(new Response('not json'))
      .mockResolvedValueOnce(new Response('{}', { status: 500 }));
    vi.stubGlobal('fetch', fetch);
    await expect(new AndroidDriver().open('')).rejects.toThrow(
      'Appium POST /session:',
    );
    await expect(new AndroidDriver().open('')).rejects.toThrow(
      'Appium POST /session:',
    );
  });

  it('accepts a W3C session and queries its contexts', async () => {
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ value: { sessionId: 'session-1' } })),
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ value: ['NATIVE_APP'] })),
      );
    vi.stubGlobal('fetch', fetch);
    await new AndroidDriver('http://localhost:4723').open('');
    expect(fetch.mock.calls).toHaveLength(2);
    expect(fetch).toHaveBeenLastCalledWith(
      'http://localhost:4723/session/session-1/contexts',
      {
        method: 'GET',
        headers: { 'content-type': 'application/json' },
        body: undefined,
      },
    );
  });
});
