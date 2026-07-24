import { describe, it, expect } from 'vitest';
import { SafeFetchService } from './safe-fetch.service.js';

/**
 * SSRF guards are the security-critical core of link-preview. These tests exercise the IP classifier +
 * URL-shape validator directly (they are private impl details; accessed via cast) so every blocked range
 * + the classic bypasses (CGNAT, 0.0.0.0/8, IPv4-mapped IPv6, AWS metadata IP) are pinned. The connect-
 * time IP pin + redirect re-validation are exercised by the e2e (they need a live socket).
 */
describe('SafeFetchService SSRF guards', () => {
  const svc = new SafeFetchService();
  const isPublic = (addr: string): boolean =>
    (svc as unknown as { isPublicIp: (a: string) => boolean }).isPublicIp(addr);
  const validate = (url: string): boolean => {
    try {
      (svc as unknown as { validateUrlShape: (u: string) => URL }).validateUrlShape(url);
      return true;
    } catch {
      return false;
    }
  };

  describe('isPublicIp', () => {
    it('rejects private / loopback / link-local / reserved IPv4', () => {
      expect(isPublic('10.0.0.1')).toBe(false);
      expect(isPublic('172.16.0.1')).toBe(false);
      expect(isPublic('192.168.1.1')).toBe(false);
      expect(isPublic('127.0.0.1')).toBe(false);
      expect(isPublic('169.254.169.254')).toBe(false); // cloud metadata endpoint
      expect(isPublic('0.0.0.0')).toBe(false);
      expect(isPublic('100.64.0.1')).toBe(false); // CGNAT
      expect(isPublic('224.0.0.1')).toBe(false); // multicast
    });

    it('rejects IPv6 loopback / link-local / unique-local', () => {
      expect(isPublic('::1')).toBe(false);
      expect(isPublic('fe80::1')).toBe(false);
      expect(isPublic('fc00::1')).toBe(false);
    });

    it('unwraps IPv4-mapped IPv6 and blocks the inner private address (the classic bypass)', () => {
      expect(isPublic('::ffff:127.0.0.1')).toBe(false);
      expect(isPublic('::ffff:169.254.169.254')).toBe(false); // mapped metadata endpoint
      expect(isPublic('::ffff:8.8.8.8')).toBe(true); // mapped public → still public
    });

    it('accepts genuinely public addresses', () => {
      expect(isPublic('8.8.8.8')).toBe(true);
      expect(isPublic('1.1.1.1')).toBe(true);
      expect(isPublic('2606:4700:4700::1111')).toBe(true);
    });
  });

  describe('validateUrlShape', () => {
    it('accepts http and https URLs', () => {
      expect(validate('http://example.com')).toBe(true);
      expect(validate('https://example.com/p?q=1#frag')).toBe(true);
    });

    it('rejects non-http schemes', () => {
      expect(validate('ftp://example.com')).toBe(false);
      expect(validate('javascript:alert(1)')).toBe(false);
      expect(validate('data:text/html,x')).toBe(false);
      expect(validate('//example.com')).toBe(false); // scheme-relative
    });

    it('rejects darknet hosts, userinfo, empty host, and overlong URLs', () => {
      expect(validate('https://evil.onion')).toBe(false);
      expect(validate('https://site.i2p')).toBe(false);
      expect(validate('https://user:pass@example.com')).toBe(false);
      expect(validate('https://')).toBe(false);
      expect(validate('https://' + 'a'.repeat(2100) + '.com')).toBe(false);
    });
  });
});
