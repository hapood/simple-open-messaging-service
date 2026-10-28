import { afterEach, beforeEach, describe, it, expect, vi } from 'vitest';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { UploadService } from './upload.service.js';
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

const mediaMetadata = {
  fromBuffer: vi.fn(metadataProbe),
  fromFile: vi.fn(metadataProbe),
};

describe('UploadService.saveAvatarFromWire — strict wire validation', () => {
  function target() {
    const svc = new UploadService({} as never, mediaMetadata as never);
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
  const svc = new UploadService({} as never, mediaMetadata as never);

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
  const svc = new UploadService({} as never, mediaMetadata as never);
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

  it('accepts a PNG under an IMAGE intent as IMAGE (no override)', async () => {
    const { payload, overrideContentType } = await svc.resolveStagedPart(
      await stage(PNG),
      ContentType.IMAGE,
      'photo.png',
      'image/png',
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

  it('falls an unsupported IMAGE intent back to a downloadable FILE', async () => {
    const heic = Buffer.from('unsupported-image-bytes');
    const { payload, overrideContentType } = await svc.resolveStagedPart(
      await stage(heic),
      ContentType.IMAGE,
      'phone.heic',
      'image/heic',
    );
    expect(payload).toMatchObject({
      family: 'FILE',
      name: 'phone.heic',
      mimeType: 'image/heic',
    });
    expect(overrideContentType).toBe(ContentType.FILE);
  });

  it('accepts EBML/webm under an AUDIO intent as audio/webm (recorder-emitted container)', async () => {
    const { payload } = await svc.resolveStagedPart(
      await stage(EBML),
      ContentType.AUDIO,
      'voice.webm',
      'audio/webm',
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
      ),
    ).rejects.toThrow('invalid video');
  });

  it('detects freely under a GALLERY intent (a webm is VIDEO by signature)', async () => {
    const { payload } = await svc.resolveStagedPart(
      await stage(EBML),
      ContentType.GALLERY,
      'clip.webm',
      'video/webm',
    );
    expect(payload.family).toBe('VIDEO');
    expect(payload.mimeType).toBe('video/webm');
  });
});

describe('UploadService.landStagedPart — idempotent CAS landing', () => {
  let root: string | undefined;
  const mediaAsset = { publishReady: vi.fn().mockResolvedValue(undefined) };
  const svc = new UploadService(mediaAsset as never, mediaMetadata as never);

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'soms-land-'));
    Object.defineProperty(svc, 'casDir', { value: root });
  });
  afterEach(async () => {
    if (root) await rm(root, { recursive: true, force: true });
    root = undefined;
  });

  const body = Buffer.from('landed staged body');
  const digest = createHash('sha256').update(body).digest('hex');

  it('lands via rename, reports dedup on repeat, and never rewrites existing shards', async () => {
    const src = join(root!, 'staged.part');
    await writeFile(src, body);
    expect(await svc.landStagedPart(src, digest)).toBe('landed');
    expect(svc.casShardExists(digest)).toBe(true);
    expect(
      await readFile(
        join(root!, digest.slice(0, 2), digest.slice(2, 4), digest),
      ),
    ).toEqual(body);

    // A second landing of the identical digest is a no-op dedup.
    await writeFile(src, body);
    expect(await svc.landStagedPart(src, digest)).toBe('dedup');
  });

  it("throws 'staged part lost' when neither source nor shard exists", async () => {
    const ghost = join(root!, 'ghost.part');
    await expect(svc.landStagedPart(ghost, digest)).rejects.toThrow(
      'staged part lost',
    );
  });
});

describe('UploadService.saveCasFromStream — persistent resume', () => {
  let root: string | undefined;
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
      const mediaAsset = { publishReady: vi.fn() };
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
          declaredBytes,
          maxFileBytes,
        }),
      ).rejects.toThrow(error);
      expect(mediaAsset.publishReady).not.toHaveBeenCalled();
      if (declaredBytes > maxFileBytes) expect(fetch).not.toHaveBeenCalled();
    },
  );

  it('rechecks the declared size and object limit on an existing CAS file', async () => {
    root = await mkdtemp(join(tmpdir(), 'soms-cas-cached-'));
    const mediaAsset = { publishReady: vi.fn() };
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
      declaredBytes: 4,
      maxFileBytes: 4,
    });
    await expect(
      service.saveCasFromStream(fetch, digest, {
        declaredBytes: 3,
        maxFileBytes: 4,
      }),
    ).rejects.toThrow('size mismatch');
    await expect(
      service.saveCasFromStream(fetch, digest, {
        declaredBytes: 4,
        maxFileBytes: 3,
      }),
    ).rejects.toThrow('maximum attachment size');
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it('retains a completed prefix after transport failure and resumes at its offset', async () => {
    root = await mkdtemp(join(tmpdir(), 'soms-cas-resume-'));
    const mediaAsset = {
      publishReady: vi.fn().mockResolvedValue(undefined),
    };
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
        { declaredBytes: body.length, maxFileBytes: body.length },
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
      { declaredBytes: body.length, maxFileBytes: body.length },
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
    );
  });

  it('keeps only the continuous verified blocks before the first corrupt resume block', async () => {
    root = await mkdtemp(join(tmpdir(), 'soms-cas-resume-'));
    const mediaAsset = { publishReady: vi.fn().mockResolvedValue(undefined) };
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
        { declaredBytes: body.length, maxFileBytes: body.length },
      ),
    ).rejects.toThrow('network dropped');

    const partPath = join(root, 'tmp', `${digest}.part`);
    const corrupt = await readFile(partPath);
    corrupt[8] ^= 0xff;
    await writeFile(partPath, corrupt);

    const offsets: number[] = [];
    await service.saveCasFromStream(
      (offset) => {
        offsets.push(offset);
        return (async function* () {
          yield body.subarray(offset);
        })();
      },
      digest,
      { declaredBytes: body.length, maxFileBytes: body.length },
    );

    expect(offsets).toEqual([6]);
    expect(
      await readFile(
        join(root, digest.slice(0, 2), digest.slice(2, 4), digest),
      ),
    ).toEqual(body);
  });

  it('automatically restarts from zero when a live partial disappears', async () => {
    root = await mkdtemp(join(tmpdir(), 'soms-cas-resume-'));
    const mediaAsset = { publishReady: vi.fn().mockResolvedValue(undefined) };
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

    await service.saveCasFromStream(
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
      { declaredBytes: body.length, maxFileBytes: body.length },
    );

    expect(offsets).toEqual([0, 0]);
    expect(
      await readFile(
        join(root, digest.slice(0, 2), digest.slice(2, 4), digest),
      ),
    ).toEqual(body);
  });

  it('deletes untrusted partial state when the final digest mismatches', async () => {
    root = await mkdtemp(join(tmpdir(), 'soms-cas-resume-'));
    const mediaAsset = {
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
        { declaredBytes: 7, maxFileBytes: 7 },
      ),
    ).rejects.toThrow('CAS digest mismatch');
    // Tmp transients live under <root>/tmp/<digest>.*; a digest mismatch removes the part + sidecar.
    const tmpBase = join(root, 'tmp', expected);
    await expect(readFile(`${tmpBase}.part`)).rejects.toThrow();
    await expect(readFile(`${tmpBase}.resume.json`)).rejects.toThrow();
    expect(mediaAsset.publishReady).not.toHaveBeenCalled();
  });
});
