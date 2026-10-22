import { describe, expect, it } from 'vitest';
import {
  shouldIgnoreUrl,
  shouldRecordBusinessHttpError,
} from './browser-driver.js';

describe('browser driver error classification', () => {
  it('filters routine browser and HMR noise', () => {
    for (const url of [
      'http://localhost:4200/favicon.ico',
      'http://localhost:4200/main.hot-update.json',
      'http://localhost:4200/__vite_ping',
      'http://localhost:4200/ngsw.json',
      'http://localhost:4200/sockjs-node/info',
      'http://localhost:4200/webpack-dev-server',
    ]) {
      expect(shouldIgnoreUrl(url)).toBe(true);
    }
  });

  it('records server errors on any non-ignored URL', () => {
    expect(shouldRecordBusinessHttpError('/assets/avatar.png', 500)).toBe(true);
    expect(shouldRecordBusinessHttpError('/favicon.ico', 500)).toBe(false);
  });

  it('records client errors only for API and federation transport paths', () => {
    expect(shouldRecordBusinessHttpError('/api/login', 401)).toBe(true);
    expect(shouldRecordBusinessHttpError('/s2s/federation', 404)).toBe(true);
    expect(shouldRecordBusinessHttpError('/assets/missing.png', 404)).toBe(
      false,
    );
  });
});
