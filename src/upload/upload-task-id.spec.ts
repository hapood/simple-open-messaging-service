import { describe, expect, it } from 'vitest';
import { parseUploadTaskId } from './upload-task-id.js';

describe('upload task identity', () => {
  it('preserves database IDs above JavaScript safe integer precision', () => {
    expect(parseUploadTaskId('9007199254740993')).toBe(9007199254740993n);
    expect(parseUploadTaskId('9223372036854775807')).toBe(9223372036854775807n);
  });

  it.each([
    '',
    '0',
    '-1',
    '01',
    '1.0',
    '1e3',
    ' 1',
    '9223372036854775808',
    'd51e065c-3a82-40b5-953e-94f0d7cb576c',
  ])('rejects noncanonical or out-of-range identity %j', (value) => {
    expect(() => parseUploadTaskId(value)).toThrow('invalid upload task id');
  });
});
