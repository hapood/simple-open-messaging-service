import { describe, expect, it } from 'vitest';
import { compareSemver, semverGte } from './shell-compat.js';

/**
 * semverGte is the gate behind the shell↔server compat decision (`GET /shell/compat`) AND the bundle's
 * minShellVersion check before download. Both version strings are project-controlled clean triplets, but
 * the compare must still order them correctly across major/minor/patch boundaries and tolerate the odd
 * prerelease/build suffix (stripped) an operator might paste. These pin the ordering directly.
 */
describe('semverGte / compareSemver', () => {
  it('equal versions are gte', () => {
    expect(semverGte('0.1.0', '0.1.0')).toBe(true);
  });
  it('higher patch is gte', () => {
    expect(semverGte('0.1.5', '0.1.0')).toBe(true);
  });
  it('higher minor beats any patch of the lower minor', () => {
    expect(semverGte('0.2.0', '0.1.9')).toBe(true);
    expect(semverGte('0.1.9', '0.2.0')).toBe(false);
  });
  it('higher major beats any lower-major', () => {
    expect(semverGte('1.0.0', '0.9.9')).toBe(true);
    expect(semverGte('0.9.9', '1.0.0')).toBe(false);
  });
  it('an older shell is rejected against a raised floor (the compat-failure path)', () => {
    expect(semverGte('0.1.0', '99.0.0')).toBe(false);
  });
  it('strips a prerelease/build suffix before comparing', () => {
    expect(semverGte('1.0.0-rc.1', '1.0.0')).toBe(true);
    expect(semverGte('1.2.3+build.5', '1.2.3')).toBe(true);
  });
  it('compareSemver returns negative/zero/positive', () => {
    expect(compareSemver('0.1.0', '0.2.0')).toBeLessThan(0);
    expect(compareSemver('0.1.0', '0.1.0')).toBe(0);
    expect(compareSemver('2.0.0', '1.0.0')).toBeGreaterThan(0);
  });
});
