import { describe, expect, it } from 'vitest';
import { uploadCacheControl } from './bootstrap';

describe('uploadCacheControl', () => {
  it.each(['jpg', 'jpeg', 'png', 'gif', 'webp'])(
    'caches .%s images privately for three days',
    (ext) => {
      expect(uploadCacheControl(`/uploads/item.${ext}`)).toBe(
        'private, max-age=259200, immutable',
      );
    },
  );

  it.each(['mp4', 'webm', 'mov', 'flv', 'avi'])(
    'caches .%s videos privately for one day',
    (ext) => {
      expect(uploadCacheControl(`/uploads/item.${ext}`)).toBe(
        'private, max-age=86400, immutable',
      );
    },
  );

  it.each(['mp3', 'ogg', 'opus', 'wav', 'm4a', 'flac', 'aac'])(
    'caches .%s audio responses privately for one day',
    (ext) => {
      expect(uploadCacheControl(`/uploads/item.${ext}`)).toBe(
        'private, max-age=86400, immutable',
      );
    },
  );

  it('keeps the existing policy for generic downloads', () => {
    expect(uploadCacheControl('/uploads/item.pdf')).toBe(
      'private, max-age=1209600, immutable',
    );
  });

  it('matches extensions case-insensitively', () => {
    expect(uploadCacheControl('/uploads/item.MP4')).toBe(
      'private, max-age=86400, immutable',
    );
  });
});
