import {
  resolveOriginSelection,
  normalizeServerUrl,
  isValidServerUrl,
  isExplicitHttp,
} from './server-config-page.component';

describe('normalizeServerUrl', () => {
  it('defaults to https:// when scheme is omitted', () => {
    expect(normalizeServerUrl('soms.example.com:7667')).toBe(
      'https://soms.example.com:7667',
    );
  });

  it('preserves existing https:// and http:// schemes', () => {
    expect(normalizeServerUrl('https://chat.example.com')).toBe(
      'https://chat.example.com',
    );
    expect(normalizeServerUrl('http://192.168.1.5:3000')).toBe(
      'http://192.168.1.5:3000',
    );
  });

  it('trims whitespace and removes trailing slashes', () => {
    expect(normalizeServerUrl('  example.com:7667///  ')).toBe(
      'https://example.com:7667',
    );
    expect(normalizeServerUrl('  http://localhost:3000/  ')).toBe(
      'http://localhost:3000',
    );
  });

  it('does not disguise unsupported schemes as an HTTPS host', () => {
    for (const raw of [
      'ftp://example.com',
      'file:///etc/passwd',
      'mailto:alice@example.com',
    ]) {
      expect(isValidServerUrl(normalizeServerUrl(raw))).toBe(false);
    }
  });

  it('returns empty string for empty input', () => {
    expect(normalizeServerUrl('')).toBe('');
    expect(normalizeServerUrl('   ')).toBe('');
  });
});

describe('isValidServerUrl', () => {
  it('accepts valid https and http URLs', () => {
    expect(isValidServerUrl('https://soms.example.com')).toBe(true);
    expect(isValidServerUrl('https://soms.example.com:7667')).toBe(true);
    expect(isValidServerUrl('http://192.168.1.1:3000')).toBe(true);
    expect(isValidServerUrl('http://localhost:8080')).toBe(true);
  });

  it('accepts IPv6 origins and rejects non-origin URL components', () => {
    expect(isValidServerUrl(normalizeServerUrl('[::1]:7667'))).toBe(true);
    for (const raw of [
      'https://user:pass@example.com',
      'https://example.com/path',
      'https://example.com?query=1',
      'https://example.com#fragment',
      'https:///example.com',
      'https://example.com\\\\path',
      'https://example.com:99999',
    ]) {
      expect(isValidServerUrl(normalizeServerUrl(raw))).toBe(false);
    }
  });

  it('rejects URLs without hostname or with invalid schemes', () => {
    expect(isValidServerUrl('')).toBe(false);
    expect(isValidServerUrl('https://')).toBe(false);
    expect(isValidServerUrl('ftp://example.com')).toBe(false);
    expect(isValidServerUrl('https://invalid url')).toBe(false);
  });
});

describe('isExplicitHttp', () => {
  it('identifies explicit http:// addresses', () => {
    expect(isExplicitHttp('http://192.168.1.1:3000')).toBe(true);
    expect(isExplicitHttp('HTTP://SERVER.LOCAL')).toBe(true);
  });

  it('does not flag https or schemeless addresses', () => {
    expect(isExplicitHttp('https://soms.example.com')).toBe(false);
    expect(isExplicitHttp('soms.example.com:7667')).toBe(false);
  });
});

describe('resolveOriginSelection', () => {
  it('does not invent a backup from an unadvertised entered address', () => {
    expect(
      resolveOriginSelection(
        'http://10.0.0.1:3000/',
        'https://chat.example',
        null,
      ),
    ).toEqual({
      primary: 'https://chat.example',
      lan: null,
      confirmPair: false,
    });
  });

  it('uses the server-advertised backup even when entered through another address', () => {
    expect(
      resolveOriginSelection(
        'http://10.0.0.1:3000/',
        'https://chat.example',
        'https://lan.chat.example',
      ),
    ).toEqual({
      primary: 'https://chat.example',
      lan: 'https://lan.chat.example',
      confirmPair: true,
    });
  });

  it('keeps one address when the server advertises identical origins', () => {
    expect(
      resolveOriginSelection(
        'https://chat.example',
        'https://chat.example/',
        'https://chat.example/',
      ),
    ).toEqual({
      primary: 'https://chat.example',
      lan: null,
      confirmPair: false,
    });
  });

  it('offers the advertised pair when the entered address is the public origin', () => {
    expect(
      resolveOriginSelection(
        'https://chat.example',
        'https://chat.example',
        'https://lan.chat.example',
      ),
    ).toEqual({
      primary: 'https://chat.example',
      lan: 'https://lan.chat.example',
      confirmPair: true,
    });
  });

  it('offers the advertised pair when the entered address is the LAN origin', () => {
    expect(
      resolveOriginSelection(
        'https://lan.chat.example',
        'https://chat.example',
        'https://lan.chat.example',
      ),
    ).toEqual({
      primary: 'https://chat.example',
      lan: 'https://lan.chat.example',
      confirmPair: true,
    });
  });

  it('keeps the entered address when no complete advertised pair exists', () => {
    expect(
      resolveOriginSelection(
        'https://chat.example/',
        'https://chat.example',
        null,
      ),
    ).toEqual({
      primary: 'https://chat.example',
      lan: null,
      confirmPair: false,
    });
  });
});
