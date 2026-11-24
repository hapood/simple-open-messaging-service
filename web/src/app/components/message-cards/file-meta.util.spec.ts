import { categorizeFilename, fileExt, formatBytes } from './file-meta.util';

describe('formatBytes', () => {
  it.each([
    [0, '0 B'],
    [1, '1 B'],
    [1024, '1.0 KB'],
    [1048576, '1.0 MB'],
  ] as const)('formats %i bytes as %s', (bytes, expected) => {
    expect(formatBytes(bytes)).toBe(expected);
  });
});

describe('categorizeFilename', () => {
  it('uses archive only for explicit compressed-file extensions', () => {
    expect(categorizeFilename('backup.zip')).toBe('archive');
    expect(categorizeFilename('backup.7z')).toBe('archive');
    expect(categorizeFilename('payload.bin')).toBe('unknown');
    expect(categorizeFilename('payload.dat')).toBe('unknown');
    expect(categorizeFilename('payload')).toBe('unknown');
  });

  it('caps the displayed extension at four characters', () => {
    expect(fileExt('archive.jpeg')).toBe('JPEG');
    expect(fileExt('payload.customextension')).toBe('CUST');
    expect(fileExt('文档.资料')).toBe('?');
    expect(fileExt('payload.a+b')).toBe('?');
    expect(fileExt('backup.7z')).toBe('7Z');
    expect(fileExt('README')).toBe('FILE');
  });
});
