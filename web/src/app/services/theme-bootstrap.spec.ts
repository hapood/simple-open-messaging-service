import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
  type Mock,
} from 'vitest';
import { PreferenceStorage } from './preference-storage';
import { initialThemeMode, prepareTheme } from './theme-bootstrap';

describe('pre-render theme bootstrap', () => {
  const originalShell = window.SomsShell;
  let get: ReturnType<typeof vi.spyOn>;
  let close: ReturnType<typeof vi.spyOn>;
  let setSplashTheme: Mock<(dark: boolean) => void>;
  let setSystemBarTheme: Mock<(dark: boolean) => void>;
  let meta: HTMLMetaElement;

  beforeEach(() => {
    get = vi.spyOn(PreferenceStorage.prototype, 'get');
    close = vi.spyOn(PreferenceStorage.prototype, 'close').mockResolvedValue();
    document.documentElement.setAttribute('data-theme-pending', '');
    setSplashTheme = vi.fn();
    setSystemBarTheme = vi.fn();
    window.SomsShell = {
      getSafeInsets: () => '{}',
      setSplashTheme,
      setSystemBarTheme,
    };
    vi.spyOn(window, 'matchMedia').mockReturnValue({
      matches: false,
    } as MediaQueryList);
    meta = document.createElement('meta');
    meta.name = 'theme-color';
    document.head.appendChild(meta);
  });

  afterEach(() => {
    window.SomsShell = originalShell;
    meta.remove();
    document.documentElement.removeAttribute('data-theme-pending');
    vi.restoreAllMocks();
  });

  it.each([
    ['dark', false, 'dark', 'dark'],
    ['light', true, 'light', 'light'],
    ['system', true, 'system', 'dark'],
    ['system', false, 'system', 'light'],
    [undefined, true, 'system', 'dark'],
    ['invalid', false, 'system', 'light'],
  ])(
    'resolves stored %s with system dark=%s before revealing content',
    async (stored, systemDark, mode, effective) => {
      get.mockResolvedValue(stored);
      vi.mocked(window.matchMedia).mockReturnValue({
        matches: systemDark,
      } as MediaQueryList);
      await prepareTheme();
      expect(get).toHaveBeenCalledExactlyOnceWith('global', 'theme');
      expect(close).toHaveBeenCalledOnce();
      expect(initialThemeMode()).toBe(mode);
      expect(document.documentElement.getAttribute('data-theme')).toBe(
        effective,
      );
      expect(setSplashTheme).toHaveBeenCalledExactlyOnceWith(
        effective === 'dark',
      );
      expect(setSystemBarTheme).toHaveBeenCalledExactlyOnceWith(
        effective === 'dark',
      );
      expect(
        document
          .querySelector('meta[name="theme-color"]')
          ?.getAttribute('content'),
      ).toBe(effective === 'dark' ? '#11161b' : '#f3f3f1');
      expect(document.documentElement.hasAttribute('data-theme-pending')).toBe(
        false,
      );
    },
  );

  it('keeps application content hidden until the database read and native publication complete', async () => {
    let resolve!: (value: string) => void;
    get.mockReturnValue(
      new Promise<string>((done) => {
        resolve = done;
      }),
    );
    setSplashTheme.mockImplementation(() => {
      expect(document.documentElement.getAttribute('data-theme')).toBe('dark');
      expect(document.documentElement.hasAttribute('data-theme-pending')).toBe(
        true,
      );
    });
    const ready = prepareTheme();
    expect(document.documentElement.hasAttribute('data-theme-pending')).toBe(
      true,
    );
    expect(setSplashTheme).not.toHaveBeenCalled();
    resolve('dark');
    await ready;
    expect(document.documentElement.hasAttribute('data-theme-pending')).toBe(
      false,
    );
  });

  it('falls back to the OS and releases the gate if storage is unavailable', async () => {
    get.mockRejectedValue(new Error('database unavailable'));
    vi.mocked(window.matchMedia).mockReturnValue({
      matches: true,
    } as MediaQueryList);
    await prepareTheme();
    expect(document.documentElement.getAttribute('data-theme')).toBe('dark');
    expect(document.documentElement.hasAttribute('data-theme-pending')).toBe(
      false,
    );
  });

  it('uses the same preference resolution without a native bridge in the browser', async () => {
    get.mockResolvedValue('dark');
    delete window.SomsShell;
    await prepareTheme();
    expect(document.documentElement.getAttribute('data-theme')).toBe('dark');
    expect(document.documentElement.hasAttribute('data-theme-pending')).toBe(
      false,
    );
  });
});
