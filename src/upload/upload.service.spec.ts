import { afterEach, beforeEach, describe, it, expect, vi } from 'vitest';
import { createHash } from 'node:crypto';
import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  stat,
  lstat,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { UploadService } from './upload.service.js';
import { detectMedia } from './media-sig.js';
import type { StoredMediaMetadata } from './stored-media-metadata.js';
import { ContentType } from '../database/enums.js';

/** PNG magic bytes + enough trailing length for detectMedia's checks. */
const PNG = Buffer.from([
  0x89, 0x50, 0x4e, 0x47, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
]);
/** EBML magic (1A 45 DF A3) — shared by webm/mkv; detectMedia resolves it as video/webm. */
const EBML = Buffer.from([0x1a, 0x45, 0xdf, 0xa3, 0x00, 0x00, 0x00, 0x00]);
/** 'OggS' — a native audio container. */
const OGG = Buffer.from([0x4f, 0x67, 0x67, 0x53]);
const ONE_PIXEL_PNG_BASE64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9ZlS8AAAAASUVORK5CYII=';

const metadataProbe = async (_target: unknown, family: string) =>
  family === 'IMAGE'
    ? { w: 10, h: 20 }
    : family === 'AUDIO'
      ? { duration: 3 }
      : family === 'VIDEO'
        ? { w: 640, h: 360, duration: 4 }
        : {};

const thumbnail = {
  digest: 'a'.repeat(64),
  size: 10,
  mimeType: 'image/webp' as const,
  width: 10,
  height: 20,
};
const metadataAsset = { metadata: vi.fn().mockResolvedValue(null) };
const mediaMetadata = {
  detectFile: vi.fn(async (path: string) => detectMedia(await readFile(path))),
  processFile: vi.fn(async (path: string) => {
    const detected = await mediaMetadata.detectFile(path);
    const kind = detected?.family.toUpperCase() ?? 'FILE';
    const media =
      kind === 'IMAGE'
        ? { kind, width: 10, height: 20, thumbnail }
        : kind === 'VIDEO'
          ? { kind, width: 640, height: 360, duration: 4, thumbnail }
          : kind === 'AUDIO'
            ? { kind, duration: 3 }
            : { kind: 'FILE' };
    return {
      meta: {
        mimeType: 'application/octet-stream',
        ...media,
      } as StoredMediaMetadata,
    };
  }),
  fromBuffer: vi.fn(metadataProbe),
  fromFile: vi.fn(metadataProbe),
};

describe('UploadService.saveAvatarFromWire — strict wire validation', () => {
  function target() {
    const svc = new UploadService(
      metadataAsset as never,
      mediaMetadata as never,
    );
    vi.spyOn(svc, 'saveAvatar').mockResolvedValue(
      '/uploads/avatars/avatar.png',
    );
    return svc;
  }

  it('accepts canonical base64 whose declared dimensions match the image', async () => {
    const svc = target();
    await expect(
      svc.saveAvatarFromWire({
        b64: ONE_PIXEL_PNG_BASE64,
        w: 1,
        h: 1,
        mimeType: 'image/png',
      }),
    ).resolves.toBe('/uploads/avatars/avatar.png');
    expect(svc.saveAvatar).toHaveBeenCalledOnce();
  });

  it('rejects malformed or non-canonical base64 before localization', async () => {
    const svc = target();
    await expect(
      svc.saveAvatarFromWire({
        b64: 'not base64',
        w: 1,
        h: 1,
        mimeType: 'image/png',
      }),
    ).rejects.toThrow('base64 is invalid');
    expect(svc.saveAvatar).not.toHaveBeenCalled();
  });

  it('rejects declared dimensions that differ from decoded image metadata', async () => {
    const svc = target();
    await expect(
      svc.saveAvatarFromWire({
        b64: ONE_PIXEL_PNG_BASE64,
        w: 2,
        h: 1,
        mimeType: 'image/png',
      }),
    ).rejects.toThrow('dimensions do not match');
    expect(svc.saveAvatar).not.toHaveBeenCalled();
  });

  it('rejects unsafe dimensions without 32-bit coercion', async () => {
    const svc = target();
    await expect(
      svc.saveAvatarFromWire({
        b64: ONE_PIXEL_PNG_BASE64,
        w: Number.MAX_SAFE_INTEGER + 1,
        h: 1,
        mimeType: 'image/png',
      }),
    ).rejects.toThrow('dimensions are invalid');
  });

  it('rejects an image whose media type does not match the bytes', async () => {
    const svc = target();
    await expect(
      svc.saveAvatarFromWire({
        b64: ONE_PIXEL_PNG_BASE64,
        w: 1,
        h: 1,
        mimeType: 'image/webp',
      }),
    ).rejects.toThrow('media type does not match');
    expect(svc.saveAvatar).not.toHaveBeenCalled();
  });
});

describe('UploadService.saveAvatar — byte-preserving storage', () => {
  let root: string | undefined;
  const svc = new UploadService(metadataAsset as never, mediaMetadata as never);

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'soms-avatar-'));
    Object.defineProperty(svc, 'uploadDir', {
      configurable: true,
      value: root,
    });
  });

  afterEach(async () => {
    if (root) await rm(root, { recursive: true, force: true });
    root = undefined;
  });

  it('stores one accepted image with exactly the uploaded bytes', async () => {
    const source = Buffer.from(ONE_PIXEL_PNG_BASE64, 'base64');
    const url = await svc.saveAvatar(source);

    expect(url).toMatch(/^\/uploads\/avatars\/.+\.png$/);
    await expect(
      readFile(join(root!, url.slice('/uploads/'.length))),
    ).resolves.toEqual(source);
  });

  it('deduplicates concurrent client and federation avatar writes in the avatar directory', async () => {
    const source = Buffer.from(ONE_PIXEL_PNG_BASE64, 'base64');
    const digest = createHash('sha256').update(source).digest('hex');
    const urls = await Promise.all([
      svc.saveAvatarFromClientBase64(ONE_PIXEL_PNG_BASE64),
      svc.saveAvatarFromWire({
        b64: ONE_PIXEL_PNG_BASE64,
        w: 1,
        h: 1,
        mimeType: 'image/png',
      }),
    ]);
    expect(urls).toEqual(Array(2).fill(`/uploads/avatars/${digest}.png`));
    expect((await readdir(join(root!, 'avatars'))).sort()).toEqual([
      `${digest}.png`,
      'tmp',
    ]);
    expect(await readdir(join(root!, 'avatars', 'tmp'))).toEqual([]);
    expect(await svc.readAvatarAsWire(urls[0])).toMatchObject({
      b64: ONE_PIXEL_PNG_BASE64,
    });
  });

  it('rejects avatar reads outside the avatar directory', async () => {
    expect(
      await svc.readAvatarAsWire('/uploads/avatars/../secret.png'),
    ).toBeNull();
    expect(
      await svc.readAvatarAsWire('/uploads/msg-assets/other.png'),
    ).toBeNull();
  });
});

describe('UploadService.resolveStagedPart — family gating by staged intent', () => {
  let root: string | undefined;
  const svc = new UploadService(metadataAsset as never, mediaMetadata as never);
  let seq = 0;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'soms-resolve-'));
    mediaMetadata.fromFile.mockClear();
    seq = 0;
  });
  afterEach(async () => {
    if (root) await rm(root, { recursive: true, force: true });
    root = undefined;
  });

  const stage = async (buf: Buffer) => {
    const path = join(root!, `part-${seq++}.part`);
    await writeFile(path, buf);
    return path;
  };

  it('rejects a cancelled upload before opening or processing the source', async () => {
    const controller = new AbortController();
    const reason = new Error('cancelled upload');
    controller.abort(reason);
    await expect(
      svc.resolveStagedPart(
        join(root!, 'missing'),
        ContentType.FILE,
        'file.bin',
        'application/octet-stream',
        controller.signal,
      ),
    ).rejects.toBe(reason);
  });

  it('passes the exact execution signal through metadata processing', async () => {
    const controller = new AbortController();
    const path = await stage(PNG);
    await svc.resolveStagedPart(
      path,
      ContentType.IMAGE,
      'photo.png',
      'image/png',
      controller.signal,
    );
    expect(mediaMetadata.processFile).toHaveBeenLastCalledWith(
      path,
      controller.signal,
    );
  });

  it('accepts a PNG under an IMAGE intent as IMAGE (no override)', async () => {
    const { payload, overrideContentType } = await svc.resolveStagedPart(
      await stage(PNG),
      ContentType.IMAGE,
      'photo.png',
      'image/png',
      new AbortController().signal,
    );
    expect(payload.family).toBe('IMAGE');
    expect(payload.size).toBe(PNG.length);
    expect(payload.w).toBe(10);
    expect(payload.h).toBe(20);
    expect(payload.mimeType).toBeUndefined();
    expect(payload.name).toBe('photo.png');
    expect(payload.digest).toBe(createHash('sha256').update(PNG).digest('hex'));
    expect(overrideContentType).toBeUndefined();
  });

  it.each([
    { bytes: PNG, family: ContentType.IMAGE },
    { bytes: EBML, family: ContentType.VIDEO },
    { bytes: OGG, family: ContentType.AUDIO },
  ])(
    'promotes FILE intent to detected $family regardless of declared MIME',
    async ({ bytes, family }) => {
      const { payload, overrideContentType } = await svc.resolveStagedPart(
        await stage(bytes),
        ContentType.FILE,
        'attachment.bin',
        'application/octet-stream',
        new AbortController().signal,
      );
      expect(payload.family).toBe(family);
      expect(overrideContentType).toBe(family);
      if (family === ContentType.IMAGE) {
        expect(payload.w).toBe(10);
        expect(payload.h).toBe(20);
      }
    },
  );

  it('keeps unrecognized FILE bytes downloadable despite an image name and MIME', async () => {
    const { payload, overrideContentType } = await svc.resolveStagedPart(
      await stage(Buffer.from('not an image')),
      ContentType.FILE,
      'photo.png',
      'image/png',
      new AbortController().signal,
    );
    expect(payload.family).toBe('FILE');
    expect(overrideContentType).toBeUndefined();
  });

  it('falls an unsupported IMAGE intent back to a downloadable FILE', async () => {
    const heic = Buffer.from('unsupported-image-bytes');
    const { payload, overrideContentType } = await svc.resolveStagedPart(
      await stage(heic),
      ContentType.IMAGE,
      'phone.heic',
      'image/heic',
      new AbortController().signal,
    );
    expect(payload).toMatchObject({
      family: 'FILE',
      name: 'phone.heic',
      mimeType: 'image/heic',
    });
    expect(overrideContentType).toBe(ContentType.FILE);
  });

  it('accepts EBML/webm under an AUDIO intent as audio/webm (recorder-emitted container)', async () => {
    mediaMetadata.detectFile.mockResolvedValueOnce({
      family: 'audio',
      ext: 'webm',
    });
    const { payload } = await svc.resolveStagedPart(
      await stage(EBML),
      ContentType.AUDIO,
      'voice.webm',
      'audio/webm',
      new AbortController().signal,
    );
    expect(payload.family).toBe('AUDIO');
    expect(payload.mimeType).toBe('audio/webm');
    expect(payload.duration).toBe(3);
  });

  it('rejects a non-video buffer under a VIDEO intent', async () => {
    await expect(
      svc.resolveStagedPart(
        await stage(OGG),
        ContentType.VIDEO,
        'clip.ogg',
        'video/ogg',
        new AbortController().signal,
      ),
    ).rejects.toThrow('invalid video');
  });

  it('detects freely under a GALLERY intent (a webm is VIDEO by signature)', async () => {
    const { payload } = await svc.resolveStagedPart(
      await stage(EBML),
      ContentType.GALLERY,
      'clip.webm',
      'video/webm',
      new AbortController().signal,
    );
    expect(payload.family).toBe('VIDEO');
    expect(payload.mimeType).toBe('video/webm');
  });
});

describe('UploadService.landStagedPart — idempotent CAS landing', () => {
  let root: string | undefined;
  const mediaAsset = {
    ...metadataAsset,
    publishReady: vi.fn().mockResolvedValue(undefined),
  };
  const svc = new UploadService(mediaAsset as never, mediaMetadata as never);

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'soms-land-'));
    Object.defineProperty(svc, 'casDir', { value: root });
    Object.defineProperty(svc, 'casTmpDir', { value: join(root!, 'tmp') });
  });
  afterEach(async () => {
    if (root) await rm(root, { recursive: true, force: true });
    root = undefined;
  });

  const body = Buffer.from('landed staged body');
  const digest = createHash('sha256').update(body).digest('hex');

  it('lands a copy, preserves staging, and never rewrites existing shards', async () => {
    const src = join(root!, 'staged.part');
    await writeFile(src, body);
    expect(await svc.landStagedPart(src, digest)).toBe('landed');
    expect(svc.casShardExists(digest)).toBe(true);
    expect(
      await readFile(
        join(root!, digest.slice(0, 2), digest.slice(2, 4), digest),
      ),
    ).toEqual(body);

    // Publication never consumes the source, so a retry can simply copy it again.
    expect(await readFile(src)).toEqual(body);
    expect(await svc.landStagedPart(src, digest)).toBe('dedup');
  });

  it('propagates the filesystem error when the source is missing', async () => {
    const ghost = join(root!, 'ghost.part');
    await expect(svc.landStagedPart(ghost, digest)).rejects.toMatchObject({
      code: 'ENOENT',
    });
  });
});

describe('UploadService.saveCasFromStream — persistent resume', () => {
  let root: string | undefined;
  const publication = () =>
    vi.fn(
      async (
        _digest: string,
        _bytes: bigint,
        publish?: () => Promise<void>,
      ) => {
        await publish?.();
      },
    );
  afterEach(async () => {
    if (root) await rm(root, { recursive: true, force: true });
    root = undefined;
  });

  // The resumable writer keeps its `.part`/`.resume.json`/`.complete` in a CAS tmp dir separate from the
  // shard tree, so both casDir (shards) and casTmpDir (transients) are redirected under the test root.
  const stubService = (service: UploadService) => {
    Object.defineProperty(service, 'casDir', { value: root });
    Object.defineProperty(service, 'casTmpDir', { value: join(root!, 'tmp') });
  };

  it.each([
    {
      declaredBytes: 4,
      maxFileBytes: 3,
      body: 'data',
      error: 'maximum attachment size',
    },
    { declaredBytes: 3, maxFileBytes: 4, body: 'data', error: 'declared size' },
    { declaredBytes: 5, maxFileBytes: 5, body: 'data', error: 'size mismatch' },
  ])(
    'rejects object/declared-size violations before publishing: $declaredBytes/$maxFileBytes',
    async ({ declaredBytes, maxFileBytes, body, error }) => {
      root = await mkdtemp(join(tmpdir(), 'soms-cas-size-'));
      const mediaAsset = { ...metadataAsset, publishReady: vi.fn() };
      const service = new UploadService(
        mediaAsset as never,
        mediaMetadata as never,
      );
      stubService(service);
      const digest = createHash('sha256').update(body).digest('hex');
      const fetch = vi.fn(() =>
        (async function* () {
          yield Buffer.from(body);
        })(),
      );
      await expect(
        service.saveCasFromStream(fetch, digest, {
          signal: new AbortController().signal,
          declaredBytes,
          maxFileBytes,
        }),
      ).rejects.toThrow(error);
      expect(mediaAsset.publishReady).not.toHaveBeenCalled();
      if (declaredBytes > maxFileBytes) expect(fetch).not.toHaveBeenCalled();
    },
  );

  it.each(['directory', 'symlink', 'dangling-symlink'])(
    'rejects a %s at the formal CAS path without fetching or registering it',
    async (kind) => {
      root = await mkdtemp(join(tmpdir(), 'soms-cas-target-'));
      const mediaAsset = { ...metadataAsset, publishReady: publication() };
      const service = new UploadService(
        mediaAsset as never,
        mediaMetadata as never,
      );
      stubService(service);
      const body = Buffer.from('data');
      const digest = createHash('sha256').update(body).digest('hex');
      const directory = join(root, digest.slice(0, 2), digest.slice(2, 4));
      await mkdir(directory, { recursive: true });
      const target = join(directory, digest);
      const other = join(root, 'other');
      if (kind === 'directory') await mkdir(target);
      else {
        if (kind === 'symlink') await writeFile(other, body);
        await symlink(other, target);
      }
      const fetch = vi.fn();
      await expect(
        service.saveCasFromStream(fetch, digest, {
          declaredBytes: body.length,
          maxFileBytes: body.length,
          signal: new AbortController().signal,
        }),
      ).rejects.toThrow('CAS target is not a regular file');
      expect(fetch).not.toHaveBeenCalled();
      expect(mediaAsset.publishReady).not.toHaveBeenCalled();
      if (kind === 'symlink') expect(await readFile(other)).toEqual(body);
    },
  );

  it('rechecks the declared size and object limit on an existing CAS file', async () => {
    root = await mkdtemp(join(tmpdir(), 'soms-cas-cached-'));
    const mediaAsset = { ...metadataAsset, publishReady: publication() };
    const service = new UploadService(
      mediaAsset as never,
      mediaMetadata as never,
    );
    stubService(service);
    const body = Buffer.from('data');
    const digest = createHash('sha256').update(body).digest('hex');
    const fetch = vi.fn(() =>
      (async function* () {
        yield body;
      })(),
    );
    await service.saveCasFromStream(fetch, digest, {
      signal: new AbortController().signal,
      declaredBytes: 4,
      maxFileBytes: 4,
    });
    await expect(
      service.saveCasFromStream(fetch, digest, {
        signal: new AbortController().signal,
        declaredBytes: 3,
        maxFileBytes: 4,
      }),
    ).rejects.toThrow('size mismatch');
    await expect(
      service.saveCasFromStream(fetch, digest, {
        signal: new AbortController().signal,
        declaredBytes: 4,
        maxFileBytes: 3,
      }),
    ).rejects.toThrow('maximum attachment size');
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it('retains a completed prefix after transport failure and resumes at its offset', async () => {
    root = await mkdtemp(join(tmpdir(), 'soms-cas-resume-'));
    const mediaAsset = { ...metadataAsset, publishReady: publication() };
    const service = new UploadService(
      mediaAsset as never,
      mediaMetadata as never,
    );
    stubService(service);
    const body = Buffer.from('persistent resumable CAS body');
    const digest = createHash('sha256').update(body).digest('hex');
    const firstOffsets: number[] = [];

    await expect(
      service.saveCasFromStream(
        (offset) => {
          firstOffsets.push(offset);
          return (async function* () {
            yield body.subarray(0, 10);
            throw new Error('network dropped');
          })();
        },
        digest,
        {
          declaredBytes: body.length,
          maxFileBytes: body.length,
          signal: new AbortController().signal,
        },
      ),
    ).rejects.toThrow('network dropped');

    const resumedOffsets: number[] = [];
    const saved = await service.saveCasFromStream(
      (offset) => {
        resumedOffsets.push(offset);
        return (async function* () {
          yield body.subarray(offset);
        })();
      },
      digest,
      {
        declaredBytes: body.length,
        maxFileBytes: body.length,
        signal: new AbortController().signal,
      },
    );
    expect(firstOffsets).toEqual([0]);
    expect(resumedOffsets).toEqual([10]);
    expect(
      await readFile(
        join(root, digest.slice(0, 2), digest.slice(2, 4), digest),
      ),
    ).toEqual(body);
    expect(saved.digest).toBe(digest);
    expect(mediaAsset.publishReady).toHaveBeenCalledWith(
      digest,
      BigInt(body.length),
      expect.any(Function),
      expect.objectContaining({ kind: 'FILE' }),
    );
  });

  it('resumes without prefix hashing and rejects corrupted bytes at final verification', async () => {
    root = await mkdtemp(join(tmpdir(), 'soms-cas-resume-'));
    const mediaAsset = { ...metadataAsset, publishReady: publication() };
    const service = new UploadService(
      mediaAsset as never,
      mediaMetadata as never,
    );
    stubService(service);
    const body = Buffer.from('first-second-final');
    const digest = createHash('sha256').update(body).digest('hex');

    await expect(
      service.saveCasFromStream(
        () =>
          (async function* () {
            yield body.subarray(0, 6);
            yield body.subarray(6, 12);
            throw new Error('network dropped');
          })(),
        digest,
        {
          declaredBytes: body.length,
          maxFileBytes: body.length,
          signal: new AbortController().signal,
        },
      ),
    ).rejects.toThrow('network dropped');

    const partPath = join(root, 'tmp', `${digest}.part`);
    const corrupt = await readFile(partPath);
    corrupt[8] ^= 0xff;
    await writeFile(partPath, corrupt);

    const offsets: number[] = [];
    await expect(
      service.saveCasFromStream(
        (offset) => {
          offsets.push(offset);
          return (async function* () {
            yield body.subarray(offset);
          })();
        },
        digest,
        {
          declaredBytes: body.length,
          maxFileBytes: body.length,
          signal: new AbortController().signal,
        },
      ),
    ).rejects.toThrow('CAS digest mismatch');

    expect(offsets).toEqual([12]);
    expect(mediaAsset.publishReady).not.toHaveBeenCalled();
    await expect(readFile(partPath)).rejects.toThrow();
  });

  it('fails explicitly without restarting when a live partial disappears', async () => {
    root = await mkdtemp(join(tmpdir(), 'soms-cas-resume-'));
    const mediaAsset = { ...metadataAsset, publishReady: publication() };
    const service = new UploadService(
      mediaAsset as never,
      mediaMetadata as never,
    );
    stubService(service);
    const body = Buffer.from('partial-removed-while-downloading');
    const digest = createHash('sha256').update(body).digest('hex');
    const partPath = join(root, 'tmp', `${digest}.part`);
    const offsets: number[] = [];
    let removed = false;

    await expect(
      service.saveCasFromStream(
        (offset) => {
          offsets.push(offset);
          return (async function* () {
            if (!removed) {
              yield body.subarray(offset, 8);
              await rm(partPath);
              removed = true;
            }
            yield body.subarray(removed && offset !== 0 ? offset : 0);
          })();
        },
        digest,
        {
          declaredBytes: body.length,
          maxFileBytes: body.length,
          signal: new AbortController().signal,
        },
      ),
    ).rejects.toMatchObject({ code: 'ENOENT', path: partPath });

    expect(offsets).toEqual([0]);
    expect(mediaAsset.publishReady).not.toHaveBeenCalled();
    expect(
      JSON.parse(
        await readFile(join(root, 'tmp', `${digest}.resume.json`), 'utf8'),
      ).offset,
    ).toBe(8);
  });

  it.each([
    'missing metadata',
    'invalid JSON',
    'wrong digest',
    'wrong size',
    'negative offset',
    'fractional offset',
    'offset beyond declared size',
    'short partial',
    'missing partial',
  ])(
    'rejects %s without silently restarting or deleting retained state',
    async (invalid) => {
      root = await mkdtemp(join(tmpdir(), 'soms-cas-checkpoint-'));
      const mediaAsset = { ...metadataAsset, publishReady: publication() };
      const service = new UploadService(
        mediaAsset as never,
        mediaMetadata as never,
      );
      stubService(service);
      const body = Buffer.from('checkpoint body');
      const digest = createHash('sha256').update(body).digest('hex');
      const options = {
        declaredBytes: body.length,
        maxFileBytes: body.length,
        signal: new AbortController().signal,
      };
      await expect(
        service.saveCasFromStream(
          () =>
            (async function* () {
              yield body.subarray(0, 5);
              throw new Error('network dropped');
            })(),
          digest,
          options,
        ),
      ).rejects.toThrow('network dropped');
      const part = join(root, 'tmp', `${digest}.part`);
      const resume = join(root, 'tmp', `${digest}.resume.json`);
      const meta = { digest, declaredBytes: body.length, offset: 5 };
      switch (invalid) {
        case 'missing metadata':
          await rm(resume);
          break;
        case 'invalid JSON':
          await writeFile(resume, '{');
          break;
        case 'missing partial':
          await rm(part);
          break;
        case 'short partial':
          await writeFile(part, body.subarray(0, 4));
          break;
        default:
          if (invalid === 'wrong digest') meta.digest = 'f'.repeat(64);
          if (invalid === 'wrong size') meta.declaredBytes++;
          if (invalid === 'negative offset') meta.offset = -1;
          if (invalid === 'fractional offset') meta.offset = 1.5;
          if (invalid === 'offset beyond declared size')
            meta.offset = body.length + 1;
          await writeFile(resume, JSON.stringify(meta));
      }
      const before = await readdir(join(root, 'tmp'));
      const fetch = vi.fn();
      await expect(
        service.saveCasFromStream(fetch, digest, options),
      ).rejects.toThrow('invalid CAS download checkpoint');
      expect(fetch).not.toHaveBeenCalled();
      expect(await readdir(join(root, 'tmp'))).toEqual(before);
      expect(mediaAsset.publishReady).not.toHaveBeenCalled();
    },
  );

  it.each(['version', 'blockHashes', 'unexpected'])(
    'rejects a download checkpoint containing %s without fetching or truncating',
    async (field) => {
      root = await mkdtemp(join(tmpdir(), 'soms-cas-checkpoint-'));
      const service = new UploadService(
        metadataAsset as never,
        mediaMetadata as never,
      );
      stubService(service);
      const digest = 'a'.repeat(64);
      const base = join(root, 'tmp', digest);
      await mkdir(join(root, 'tmp'), { recursive: true });
      const checkpoint = JSON.stringify({
        digest,
        declaredBytes: 8,
        offset: 4,
        [field]: 1,
      });
      await writeFile(`${base}.part`, 'abcdefgh');
      await writeFile(`${base}.resume.json`, checkpoint);
      const fetch = vi.fn();
      await expect(
        service.saveCasFromStream(fetch, digest, {
          declaredBytes: 8,
          maxFileBytes: 8,
          signal: new AbortController().signal,
        }),
      ).rejects.toThrow('invalid CAS download checkpoint');
      expect(fetch).not.toHaveBeenCalled();
      expect(await readFile(`${base}.part`, 'utf8')).toBe('abcdefgh');
      expect(await readFile(`${base}.resume.json`, 'utf8')).toBe(checkpoint);
    },
  );

  it.each([
    '.part',
    '.resume.json',
    '.resume.json.tmp',
    '.complete',
    '.complete.tmp',
  ])('rejects a symlink at %s before restoring a download', async (suffix) => {
    root = await mkdtemp(join(tmpdir(), 'soms-cas-unsafe-checkpoint-'));
    const service = new UploadService(
      metadataAsset as never,
      mediaMetadata as never,
    );
    stubService(service);
    const digest = 'a'.repeat(64);
    const base = join(root, 'tmp', digest);
    await mkdir(join(root, 'tmp'), { recursive: true });
    await writeFile(`${base}.part`, 'abcdefgh');
    await writeFile(
      `${base}.resume.json`,
      JSON.stringify({ digest, declaredBytes: 8, offset: 4 }),
    );
    const target = join(root, 'unrelated');
    await writeFile(target, 'keep unchanged');
    await rm(base + suffix, { force: true });
    await symlink(target, base + suffix);
    const fetch = vi.fn();
    await expect(
      service.saveCasFromStream(fetch, digest, {
        declaredBytes: 8,
        maxFileBytes: 8,
        signal: new AbortController().signal,
      }),
    ).rejects.toThrow('invalid CAS download checkpoint');
    expect(fetch).not.toHaveBeenCalled();
    expect(await readFile(target, 'utf8')).toBe('keep unchanged');
    expect((await lstat(base + suffix)).isSymbolicLink()).toBe(true);
    if (suffix !== '.part')
      expect(await readFile(`${base}.part`, 'utf8')).toBe('abcdefgh');
  });

  it('does not treat a lone dangling checkpoint companion as a new download', async () => {
    root = await mkdtemp(join(tmpdir(), 'soms-cas-dangling-checkpoint-'));
    const service = new UploadService(
      metadataAsset as never,
      mediaMetadata as never,
    );
    stubService(service);
    const digest = 'a'.repeat(64);
    const base = join(root, 'tmp', digest);
    await mkdir(join(root, 'tmp'), { recursive: true });
    await symlink(join(root, 'missing'), `${base}.resume.json.tmp`);
    const fetch = vi.fn();
    await expect(
      service.saveCasFromStream(fetch, digest, {
        declaredBytes: 8,
        maxFileBytes: 8,
        signal: new AbortController().signal,
      }),
    ).rejects.toThrow('invalid CAS download checkpoint');
    expect(fetch).not.toHaveBeenCalled();
    await expect(stat(`${base}.part`)).rejects.toMatchObject({
      code: 'ENOENT',
    });
    expect((await lstat(`${base}.resume.json.tmp`)).isSymbolicLink()).toBe(
      true,
    );
  });

  it('retains cancellation checkpoints without versions or block hashes and truncates uncommitted tails', async () => {
    root = await mkdtemp(join(tmpdir(), 'soms-cas-checkpoint-'));
    const mediaAsset = { ...metadataAsset, publishReady: publication() };
    const service = new UploadService(
      mediaAsset as never,
      mediaMetadata as never,
    );
    stubService(service);
    const body = Buffer.from('checkpoint body');
    const digest = createHash('sha256').update(body).digest('hex');
    const options = {
      declaredBytes: body.length,
      maxFileBytes: body.length,
      signal: new AbortController().signal,
    };
    const controller = new AbortController();
    await expect(
      service.saveCasFromStream(
        () =>
          (async function* () {
            yield body.subarray(0, 5);
            controller.abort(new Error('stopped'));
            yield body.subarray(5);
          })(),
        digest,
        { ...options, signal: controller.signal },
      ),
    ).rejects.toThrow('stopped');
    const part = join(root, 'tmp', `${digest}.part`);
    expect(
      JSON.parse(
        await readFile(join(root, 'tmp', `${digest}.resume.json`), 'utf8'),
      ),
    ).toEqual({
      digest,
      declaredBytes: body.length,
      offset: 5,
    });
    await writeFile(
      part,
      Buffer.concat([body.subarray(0, 5), Buffer.from('uncommitted tail')]),
    );
    const offsets: number[] = [];
    await service.saveCasFromStream(
      (offset) =>
        (async function* () {
          offsets.push(offset);
          expect(await readFile(part)).toEqual(body.subarray(0, 5));
          yield body.subarray(offset);
        })(),
      digest,
      options,
    );
    expect(offsets).toEqual([5]);
    expect(
      await readFile(
        join(root, digest.slice(0, 2), digest.slice(2, 4), digest),
      ),
    ).toEqual(body);
  });

  it('verifies a complete checkpoint without requesting a Range at EOF', async () => {
    root = await mkdtemp(join(tmpdir(), 'soms-cas-checkpoint-'));
    const mediaAsset = { ...metadataAsset, publishReady: publication() };
    const service = new UploadService(
      mediaAsset as never,
      mediaMetadata as never,
    );
    stubService(service);
    const body = Buffer.from('checkpoint body');
    const digest = createHash('sha256').update(body).digest('hex');
    const options = {
      declaredBytes: body.length,
      maxFileBytes: body.length,
      signal: new AbortController().signal,
    };
    await expect(
      service.saveCasFromStream(
        () =>
          (async function* () {
            yield body;
            throw new Error('network dropped');
          })(),
        digest,
        options,
      ),
    ).rejects.toThrow('network dropped');
    const fetch = vi.fn();
    await service.saveCasFromStream(fetch, digest, options);
    expect(fetch).not.toHaveBeenCalled();
    expect(mediaAsset.publishReady).toHaveBeenCalledOnce();
  });

  it('retains complete staging when asset commit fails after atomic publication', async () => {
    root = await mkdtemp(join(tmpdir(), 'soms-cas-publication-recovery-'));
    const databaseFailure = new Error('asset transaction rolled back');
    const publishReady = publication();
    publishReady.mockImplementationOnce(async (_digest, _bytes, publish) => {
      await publish?.();
      throw databaseFailure;
    });
    const service = new UploadService(
      { ...metadataAsset, publishReady } as never,
      mediaMetadata as never,
    );
    stubService(service);
    const body = Buffer.from('complete recoverable publication');
    const digest = createHash('sha256').update(body).digest('hex');
    const options = {
      declaredBytes: body.length,
      maxFileBytes: body.length,
      signal: new AbortController().signal,
    };
    await expect(
      service.saveCasFromStream(
        () =>
          (async function* () {
            yield body;
          })(),
        digest,
        options,
      ),
    ).rejects.toBe(databaseFailure);

    const base = join(root, 'tmp', digest);
    const formal = join(root, digest.slice(0, 2), digest.slice(2, 4), digest);
    expect(await readFile(formal)).toEqual(body);
    expect(await readFile(`${base}.part`)).toEqual(body);
    expect(JSON.parse(await readFile(`${base}.resume.json`, 'utf8'))).toEqual({
      digest,
      declaredBytes: body.length,
      offset: body.length,
    });

    const fetch = vi.fn();
    await expect(
      service.saveCasFromStream(fetch, digest, options),
    ).resolves.toMatchObject({
      digest,
      size: body.length,
    });
    expect(fetch).not.toHaveBeenCalled();
    expect(publishReady).toHaveBeenCalledTimes(2);
    // Task-owned cleanup is later than the asset transaction, including on recovery.
    expect(await readFile(`${base}.part`)).toEqual(body);
    expect(await readFile(`${base}.resume.json`, 'utf8')).toBeTruthy();
  });

  it('recovers a full offset after publication failure without a completion marker or network fetch', async () => {
    root = await mkdtemp(join(tmpdir(), 'soms-cas-full-offset-'));
    const body = Buffer.from('verified source retained before publication');
    const digest = createHash('sha256').update(body).digest('hex');
    const base = join(root, 'tmp', digest);
    const publishReady = publication();
    publishReady.mockRejectedValueOnce(new Error('publication unavailable'));
    const service = new UploadService(
      { ...metadataAsset, publishReady } as never,
      mediaMetadata as never,
    );
    stubService(service);
    const options = {
      declaredBytes: body.length,
      maxFileBytes: body.length,
      signal: new AbortController().signal,
    };
    await expect(
      service.saveCasFromStream(
        () =>
          (async function* () {
            yield body;
          })(),
        digest,
        options,
      ),
    ).rejects.toThrow('publication unavailable');
    expect(JSON.parse(await readFile(`${base}.resume.json`, 'utf8'))).toEqual({
      digest,
      declaredBytes: body.length,
      offset: body.length,
    });
    for (const suffix of ['.complete', '.complete.tmp'])
      await expect(lstat(base + suffix)).rejects.toMatchObject({
        code: 'ENOENT',
      });
    const fetch = vi.fn();
    await expect(
      service.saveCasFromStream(fetch, digest, {
        ...options,
      }),
    ).resolves.toMatchObject({ digest, size: body.length });
    expect(fetch).not.toHaveBeenCalled();
    expect(await readFile(`${base}.part`)).toEqual(body);
    expect(
      await readFile(
        join(root, digest.slice(0, 2), digest.slice(2, 4), digest),
      ),
    ).toEqual(body);
    await expect(lstat(`${base}.complete`)).rejects.toMatchObject({
      code: 'ENOENT',
    });
  });

  it('reports companion cleanup failure after publication while retaining recovery artifacts', async () => {
    root = await mkdtemp(join(tmpdir(), 'soms-cas-cleanup-'));
    const body = Buffer.from('published bytes');
    const digest = createHash('sha256').update(body).digest('hex');
    const base = join(root, 'tmp', digest);
    const publishReady = publication();
    publishReady.mockImplementationOnce(async (_digest, _bytes, publish) => {
      await publish?.();
      await mkdir(`${base}.resume.json.tmp`);
      await writeFile(`${base}.complete.tmp`, 'unfinished marker');
    });
    const service = new UploadService(
      { ...metadataAsset, publishReady } as never,
      mediaMetadata as never,
    );
    stubService(service);
    await expect(
      service.saveCasFromStream(
        () =>
          (async function* () {
            yield body;
          })(),
        digest,
        {
          declaredBytes: body.length,
          maxFileBytes: body.length,
          signal: new AbortController().signal,
        },
      ),
    ).rejects.toThrow('staging cleanup failed');
    expect(
      await readFile(
        join(root, digest.slice(0, 2), digest.slice(2, 4), digest),
      ),
    ).toEqual(body);
    expect(await readFile(`${base}.part`)).toEqual(body);
    expect(
      JSON.parse(await readFile(`${base}.resume.json`, 'utf8')).offset,
    ).toBe(body.length);
    await expect(stat(`${base}.complete.tmp`)).rejects.toMatchObject({
      code: 'ENOENT',
    });
    expect((await stat(`${base}.resume.json.tmp`)).isDirectory()).toBe(true);
    const fetch = vi.fn();
    const options = {
      declaredBytes: body.length,
      maxFileBytes: body.length,
      signal: new AbortController().signal,
    };
    await expect(
      service.saveCasFromStream(fetch, digest, options),
    ).rejects.toThrow('staging cleanup failed');
    await rm(`${base}.resume.json.tmp`, { recursive: true });
    await expect(
      service.saveCasFromStream(fetch, digest, options),
    ).resolves.toMatchObject({ digest, size: body.length });
    expect(fetch).not.toHaveBeenCalled();
  });

  it('reports transport and companion cleanup failures without discarding the checkpoint', async () => {
    root = await mkdtemp(join(tmpdir(), 'soms-cas-cleanup-'));
    const service = new UploadService(
      metadataAsset as never,
      mediaMetadata as never,
    );
    stubService(service);
    const body = Buffer.from('recoverable bytes');
    const digest = createHash('sha256').update(body).digest('hex');
    const base = join(root, 'tmp', digest);
    const transportFailure = new Error('connection interrupted');
    const result = service.saveCasFromStream(
      () =>
        (async function* () {
          yield body.subarray(0, 4);
          await mkdir(`${base}.resume.json.tmp`);
          await writeFile(`${base}.complete.tmp`, 'unfinished marker');
          throw transportFailure;
        })(),
      digest,
      {
        declaredBytes: body.length,
        maxFileBytes: body.length,
        signal: new AbortController().signal,
      },
    );
    const failure: unknown = await result.catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(AggregateError);
    if (!(failure instanceof AggregateError))
      throw new Error('expected aggregate failure');
    expect(failure.cause).toBe(transportFailure);
    expect(failure.errors[0]).toBe(transportFailure);
    expect(failure.errors[1]).toBeInstanceOf(AggregateError);
    expect(await readFile(`${base}.part`)).toEqual(body.subarray(0, 4));
    expect(
      JSON.parse(await readFile(`${base}.resume.json`, 'utf8')).offset,
    ).toBe(4);
    expect((await stat(`${base}.resume.json.tmp`)).isDirectory()).toBe(true);
    await expect(stat(`${base}.complete.tmp`)).rejects.toMatchObject({
      code: 'ENOENT',
    });
  });

  it('preserves the filesystem error when the partial file disappears', async () => {
    root = await mkdtemp(join(tmpdir(), 'soms-cas-missing-'));
    const service = new UploadService(
      metadataAsset as never,
      mediaMetadata as never,
    );
    stubService(service);
    const body = Buffer.from('data');
    const digest = createHash('sha256').update(body).digest('hex');
    await expect(
      service.saveCasFromStream(
        () =>
          (async function* () {
            yield body;
            await rm(join(root!, 'tmp', `${digest}.part`));
          })(),
        digest,
        {
          declaredBytes: 4,
          maxFileBytes: 4,
          signal: new AbortController().signal,
        },
      ),
    ).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('cleans all regular CAS companions while reporting unexpected directories and symlinks', async () => {
    root = await mkdtemp(join(tmpdir(), 'soms-cas-maintenance-'));
    const service = new UploadService(
      metadataAsset as never,
      mediaMetadata as never,
    );
    stubService(service);
    const digest = 'a'.repeat(64);
    const base = join(root, 'tmp', digest);
    await mkdir(join(root, 'tmp'), { recursive: true });
    const target = join(root, 'unrelated');
    await writeFile(target, 'keep');
    await mkdir(`${base}.part`);
    await symlink(target, `${base}.resume.json`);
    for (const suffix of ['.resume.json.tmp', '.complete', '.complete.tmp'])
      await writeFile(base + suffix, 'companion');
    const failure: unknown = await service
      .removeCasTemporary(digest)
      .catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(AggregateError);
    if (!(failure instanceof AggregateError))
      throw new Error('expected cleanup failure');
    expect(failure.errors).toHaveLength(2);
    expect(await readFile(target, 'utf8')).toBe('keep');
    expect((await lstat(`${base}.resume.json`)).isSymbolicLink()).toBe(true);
    expect((await stat(`${base}.part`)).isDirectory()).toBe(true);
    for (const suffix of ['.resume.json.tmp', '.complete', '.complete.tmp'])
      await expect(stat(base + suffix)).rejects.toMatchObject({
        code: 'ENOENT',
      });
    await rm(`${base}.part`, { recursive: true });
    await rm(`${base}.resume.json`);
    await service.removeCasTemporary(digest);
    await expect(service.removeCasTemporary('../unrelated')).rejects.toThrow(
      'invalid CAS digest',
    );
    expect(await readFile(target, 'utf8')).toBe('keep');
  });

  it('reports failed integrity cleanup while attempting every artifact', async () => {
    root = await mkdtemp(join(tmpdir(), 'soms-cas-cleanup-'));
    const mediaAsset = { ...metadataAsset, publishReady: publication() };
    const service = new UploadService(
      mediaAsset as never,
      mediaMetadata as never,
    );
    stubService(service);
    const digest = createHash('sha256').update('expected').digest('hex');
    const base = join(root, 'tmp', digest);
    const execution = service.saveCasFromStream(
      () =>
        (async function* () {
          yield Buffer.from('corrupt');
          // Directories produce deterministic unlink failures even when tests run as root.
          await mkdir(`${base}.complete`);
          await mkdir(`${base}.complete.tmp`);
          await writeFile(`${base}.resume.json.tmp`, 'orphan');
        })(),
      digest,
      {
        declaredBytes: 7,
        maxFileBytes: 7,
        signal: new AbortController().signal,
      },
    );
    const error = await execution.catch((cause: unknown) => cause);
    expect(error).toBeInstanceOf(AggregateError);
    const aggregate = error as AggregateError;
    expect(aggregate.message).toContain('invalid artifact cleanup failed');
    expect(aggregate.cause).toBeInstanceOf(Error);
    expect((aggregate.cause as Error).message).toContain('CAS digest mismatch');
    expect(aggregate.errors).toHaveLength(2);
    expect(aggregate.errors.map((item: Error) => item.message)).toEqual(
      expect.arrayContaining([
        expect.stringContaining(`${base}.complete`),
        expect.stringContaining(`${base}.complete.tmp`),
      ]),
    );
    await expect(readFile(`${base}.part`)).rejects.toThrow();
    await expect(readFile(`${base}.resume.json`)).rejects.toThrow();
    await expect(readFile(`${base}.resume.json.tmp`)).rejects.toThrow();
    expect(mediaAsset.publishReady).not.toHaveBeenCalled();
  });

  it.each(['missing', 'directory', 'short', 'complete'] as const)(
    'protects the recovery source during completion cleanup with a %s published original',
    async (kind) => {
      root = await mkdtemp(join(tmpdir(), 'soms-cas-completed-cleanup-'));
      const service = new UploadService(
        metadataAsset as never,
        mediaMetadata as never,
      );
      stubService(service);
      const digest = 'a'.repeat(64);
      const target = service.casTarget(digest).abs;
      const base = join(root, 'tmp', digest);
      await mkdir(join(root, 'tmp'), { recursive: true });
      await mkdir(join(root, 'aa', 'aa'), { recursive: true });
      await writeFile(`${base}.part`, 'data');
      await writeFile(`${base}.resume.json`, '{}');
      if (kind === 'directory') await mkdir(target);
      if (kind === 'short') await writeFile(target, 'x');
      if (kind === 'complete') await writeFile(target, 'data');
      if (kind === 'complete') {
        await service.removePublishedCasTemporary(digest, 4n);
        await expect(readFile(`${base}.part`)).rejects.toMatchObject({
          code: 'ENOENT',
        });
        await expect(readFile(`${base}.resume.json`)).rejects.toMatchObject({
          code: 'ENOENT',
        });
        expect(await readFile(target, 'utf8')).toBe('data');
      } else {
        await expect(
          service.removePublishedCasTemporary(digest, 4n),
        ).rejects.toThrow();
        expect(await readFile(`${base}.part`, 'utf8')).toBe('data');
        expect(await readFile(`${base}.resume.json`, 'utf8')).toBe('{}');
      }
    },
  );

  it('starts at zero when every temporary artifact is absent', async () => {
    root = await mkdtemp(join(tmpdir(), 'soms-cas-checkpoint-'));
    const service = new UploadService(
      metadataAsset as never,
      mediaMetadata as never,
    );
    stubService(service);
    const fetch = vi.fn(() => {
      throw new Error('transport failed');
    });
    await expect(
      service.saveCasFromStream(fetch, 'a'.repeat(64), {
        signal: new AbortController().signal,
        declaredBytes: 10,
        maxFileBytes: 10,
      }),
    ).rejects.toThrow('transport failed');
    expect(fetch).toHaveBeenCalledExactlyOnceWith(0);
    expect(
      JSON.parse(
        await readFile(
          join(root, 'tmp', `${'a'.repeat(64)}.resume.json`),
          'utf8',
        ),
      ),
    ).toEqual({ digest: 'a'.repeat(64), declaredBytes: 10, offset: 0 });
  });

  it('deletes untrusted partial state when the final digest mismatches', async () => {
    root = await mkdtemp(join(tmpdir(), 'soms-cas-resume-'));
    const mediaAsset = {
      ...metadataAsset,
      publishReady: vi.fn().mockResolvedValue(undefined),
    };
    const service = new UploadService(
      mediaAsset as never,
      mediaMetadata as never,
    );
    stubService(service);
    const expected = createHash('sha256').update('expected').digest('hex');
    await expect(
      service.saveCasFromStream(
        () =>
          (async function* () {
            yield Buffer.from('corrupt');
          })(),
        expected,
        {
          declaredBytes: 7,
          maxFileBytes: 7,
          signal: new AbortController().signal,
        },
      ),
    ).rejects.toThrow('CAS digest mismatch');
    // Tmp transients live under <root>/tmp/<digest>.*; a digest mismatch removes the part + sidecar.
    const tmpBase = join(root, 'tmp', expected);
    await expect(readFile(`${tmpBase}.part`)).rejects.toThrow();
    await expect(readFile(`${tmpBase}.resume.json`)).rejects.toThrow();
    expect(mediaAsset.publishReady).not.toHaveBeenCalled();
  });
});
