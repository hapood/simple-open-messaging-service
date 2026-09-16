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

const mediaMetadata = {
  fromBuffer: vi.fn(async (_buf: Buffer, intent: string) =>
    intent === 'IMAGE'
      ? { w: 10, h: 20 }
      : intent === 'AUDIO'
        ? { duration: 3 }
        : intent === 'VIDEO'
          ? { w: 640, h: 360, duration: 4 }
          : {},
  ),
  fromFile: vi.fn(),
};

/**
 * A minimal multipart FastifyRequest stand-in for consumeParts: yields the given file parts (each with
 * a `toBuffer()`) interleaved with non-file form fields. Mirrors the shape @fastify/multipart exposes.
 */
function fakeReq(
  files: Array<{
    buf: Buffer;
    filename?: string;
    mimetype?: string;
  }>,
  fields: Record<string, string> = {},
): any {
  const parts: any[] = [];
  for (const [k, v] of Object.entries(fields)) {
    parts.push({ type: 'field', fieldname: k, value: v });
  }
  for (const f of files) {
    parts.push({
      type: 'file',
      mimetype: f.mimetype ?? 'application/octet-stream',
      ...(f.filename ? { filename: f.filename } : {}),
      file: { resume: () => {} },
      toBuffer: async () => f.buf,
    });
  }
  return {
    parts: async function* () {
      for (const p of parts) yield p;
    },
  };
}

describe('UploadService.detectFamily — magic-byte family resolution', () => {
  const svc = new UploadService({} as never, mediaMetadata as never);

  it('maps PNG magic bytes to IMAGE', () => {
    expect(svc.detectFamily(PNG)).toBe('IMAGE');
  });

  it('maps EBML/webm to VIDEO (free detection; an AUDIO intent re-maps it via savePart)', () => {
    expect(svc.detectFamily(EBML)).toBe('VIDEO');
  });

  it('maps OggS to AUDIO', () => {
    expect(svc.detectFamily(OGG)).toBe('AUDIO');
  });

  it('falls back to FILE for unrecognized bytes', () => {
    expect(svc.detectFamily(Buffer.from([0x00, 0x00, 0x00, 0x00]))).toBe(
      'FILE',
    );
  });
});

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

describe('UploadService.savePart — family gating by staged intent', () => {
  let root: string | undefined;
  const mediaAsset = { publishReady: vi.fn().mockResolvedValue(undefined) };
  const svc = new UploadService(mediaAsset as never, mediaMetadata as never);

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'soms-savepart-'));
    // saveCas writes the shard under casDir + a publish tmp under casTmpDir; redirect both to the
    // test root so no real data/cas is touched.
    Object.defineProperty(svc, 'casDir', { value: root });
    Object.defineProperty(svc, 'casTmpDir', { value: join(root, 'tmp') });
    mediaAsset.publishReady.mockClear();
  });
  afterEach(async () => {
    if (root) await rm(root, { recursive: true, force: true });
    root = undefined;
  });

  it('accepts a PNG under an IMAGE intent as IMAGE (no override)', async () => {
    const { payload, overrideContentType } = await svc.savePart(
      PNG,
      ContentType.IMAGE,
      { filename: 'photo.png', declaredMime: 'image/png' },
    );
    expect(payload.family).toBe('IMAGE');
    expect(payload.size).toBe(PNG.length);
    expect(payload.w).toBe(10);
    expect(payload.h).toBe(20);
    expect(payload.mimeType).toBeUndefined();
    expect(payload.name).toBeUndefined();
    expect(overrideContentType).toBeUndefined();
    expect(mediaAsset.publishReady).toHaveBeenCalledOnce();
  });

  it('falls an unsupported IMAGE intent back to a downloadable FILE', async () => {
    const heic = Buffer.from('unsupported-image-bytes');
    const { payload, overrideContentType } = await svc.savePart(
      heic,
      ContentType.IMAGE,
      {
        filename: 'phone.heic',
        declaredMime: 'image/heic',
      },
    );
    expect(payload).toMatchObject({
      family: 'FILE',
      name: 'phone.heic',
      mimeType: 'image/heic',
    });
    expect(overrideContentType).toBe(ContentType.FILE);
  });

  it('accepts EBML/webm under an AUDIO intent as audio/webm (recorder-emitted container)', async () => {
    const { payload } = await svc.savePart(EBML, ContentType.AUDIO, {
      filename: 'voice.webm',
      declaredMime: 'audio/webm',
    });
    expect(payload.family).toBe('AUDIO');
    expect(payload.mimeType).toBe('audio/webm');
    expect(payload.duration).toBe(3);
  });

  it('rejects a non-video buffer under a VIDEO intent', async () => {
    await expect(
      svc.savePart(OGG, ContentType.VIDEO, { filename: 'clip.ogg' }),
    ).rejects.toThrow('invalid video');
  });

  it('detects freely under a GALLERY intent (a webm is VIDEO by signature)', async () => {
    const { payload } = await svc.savePart(EBML, ContentType.GALLERY, {
      filename: 'clip.webm',
    });
    expect(payload.family).toBe('VIDEO');
    expect(payload.mimeType).toBe('video/webm');
  });
});

describe('UploadService.consumeParts — multi-file drain', () => {
  const svc = new UploadService({} as never, mediaMetadata as never);

  it('collects file parts and companion form fields', async () => {
    const r = await svc.consumeParts(
      fakeReq([{ buf: PNG, filename: 'a.png', mimetype: 'image/png' }], {
        w: '10',
        h: '20',
      }),
      { maxBytes: 1024 },
    );
    expect(r.kind).toBe('ok');
    if (r.kind === 'ok') {
      expect(r.files).toHaveLength(1);
      expect(r.files[0].filename).toBe('a.png');
      expect(r.fields).toEqual({ w: '10', h: '20' });
    }
  });

  it('drops empty parts and rejects with no-file when none remain', async () => {
    const r = await svc.consumeParts(
      fakeReq([{ buf: Buffer.alloc(0), filename: 'empty.bin' }]),
      { maxBytes: 1024 },
    );
    expect(r).toEqual({ kind: 'rejected', reason: 'no-file' });
  });

  it('rejects a part exceeding the per-part cap as too-large', async () => {
    const r = await svc.consumeParts(
      fakeReq([{ buf: Buffer.alloc(10), filename: 'big.bin' }]),
      { maxBytes: 4 },
    );
    expect(r).toEqual({ kind: 'rejected', reason: 'too-large' });
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
      service.saveCasFromStream((offset) => {
        firstOffsets.push(offset);
        return (async function* () {
          yield body.subarray(0, 10);
          throw new Error('network dropped');
        })();
      }, digest),
    ).rejects.toThrow('network dropped');

    const resumedOffsets: number[] = [];
    const saved = await service.saveCasFromStream((offset) => {
      resumedOffsets.push(offset);
      return (async function* () {
        yield body.subarray(offset);
      })();
    }, digest);
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
      ),
    ).rejects.toThrow('network dropped');

    const partPath = join(root, 'tmp', `${digest}.part`);
    const corrupt = await readFile(partPath);
    corrupt[8] ^= 0xff;
    await writeFile(partPath, corrupt);

    const offsets: number[] = [];
    await service.saveCasFromStream((offset) => {
      offsets.push(offset);
      return (async function* () {
        yield body.subarray(offset);
      })();
    }, digest);

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

    await service.saveCasFromStream((offset) => {
      offsets.push(offset);
      return (async function* () {
        if (!removed) {
          yield body.subarray(offset, 8);
          await rm(partPath);
          removed = true;
        }
        yield body.subarray(removed && offset !== 0 ? offset : 0);
      })();
    }, digest);

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
      ),
    ).rejects.toThrow('CAS digest mismatch');
    // Tmp transients live under <root>/tmp/<digest>.*; a digest mismatch removes the part + sidecar.
    const tmpBase = join(root, 'tmp', expected);
    await expect(readFile(`${tmpBase}.part`)).rejects.toThrow();
    await expect(readFile(`${tmpBase}.resume.json`)).rejects.toThrow();
    expect(mediaAsset.publishReady).not.toHaveBeenCalled();
  });
});
