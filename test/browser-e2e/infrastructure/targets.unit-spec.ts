import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it, expect } from 'vitest';
import { navigationUrl } from './targets.mjs';
import { profileTarget, profileDirectory } from './profile-targets.mjs';
import { browserLaunchOptions } from './browser-runtime.mjs';

describe('browser target isolation', () => {
  it('uses the installed browser by default and only explicitly overrides it', () => {
    expect(browserLaunchOptions({})).toEqual({ headless: true });
    expect(
      browserLaunchOptions({
        CHROME_PATH: '/test/chrome',
        BROWSER_HEADFUL: '1',
      }),
    ).toEqual({ headless: false, executablePath: '/test/chrome' });
  });
  it('accepts only the selected local origins and matching nodes', () => {
    expect(navigationUrl('playground')).toBe('http://127.0.0.1:4301/');
    expect(navigationUrl('federation', 'bravo')).toBe('http://localhost:3102/');
    for (const url of [
      'https://example.com',
      'http://localhost:3101.evil.test',
      'http://user:pass@localhost:3101/',
      'http://127.0.0.1:4301/',
    ]) {
      expect(() => navigationUrl('federation', undefined, url)).toThrow();
    }
    expect(() => navigationUrl('playground', 'alpha')).toThrow();
    expect(() =>
      navigationUrl('federation', 'alpha', 'http://localhost:3102/'),
    ).toThrow();
  });
  it('persists profile target bindings across driver restarts without migrating legacy profiles', () => {
    const root = mkdtempSync(join(tmpdir(), 'browser-targets-'));
    try {
      expect(() => profileTarget(root, 'fresh')).toThrow('Select target');
      expect(profileTarget(root, 'mock', 'playground')).toBe('playground');
      expect(profileTarget(root, 'mock')).toBe('playground');
      expect(() => profileTarget(root, 'mock', 'federation')).toThrow(
        'belongs to',
      );
      mkdirSync(join(root, 'legacy'));
      expect(profileTarget(root, 'legacy')).toBe('federation');
      expect(() => profileTarget(root, 'legacy', 'playground')).toThrow(
        'belongs to',
      );
      expect(profileDirectory(root, 'mock', 'playground')).not.toBe(
        profileDirectory(root, 'mock', 'federation'),
      );
      expect(() => profileTarget(root, '../escape', 'playground')).toThrow();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
