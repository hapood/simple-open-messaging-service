import { afterEach, describe, it, expect, vi } from 'vitest';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { UploadService } from './upload.service.js';

/**
 * A minimal multipart FastifyRequest stand-in: yields exactly one file part whose `toBuffer()`
 * resolves to `buf`. consumeSingle drains it inside the loop (backpressure-safe contract) and
 * captures mimetype/filename. Only the shape consumeAudio/consumeMedia reads is implemented — the
 * CAS write (saveMedia) happens in the controller, so MediaAssetService is never hit here.
 */
function fakeReq(
  buf: Buffer,
  filename = 'voice.webm',
  mimetype = 'audio/webm',
): any {
  const part = {
    type: 'file' as const,
    mimetype,
    filename,
    file: { resume: () => {} },
    toBuffer: async () => buf,
  };
  return {
    parts: async function* () {
      yield part;
    },
  };
}

describe('UploadService.consumeAudio — recorder-emitted container acceptance', () => {
  const svc = new UploadService({} as never);

  it('accepts EBML/webm (Chrome/Android/Tauri MediaRecorder output) as audio/webm', async () => {
    // EBML magic: 1A 45 DF A3 + enough trailing bytes for detectMedia's length checks.
    const ebml = Buffer.from([0x1a, 0x45, 0xdf, 0xa3, 0x00, 0x00, 0x00, 0x00]);
    const r = await svc.consumeAudio(fakeReq(ebml));
    expect(r.kind).toBe('file');
    if (r.kind === 'file') {
      expect(r.ext).toBe('webm');
      expect(r.mime).toBe('audio/webm');
    }
  });

  it('accepts ISO-BMFF ftyp (Safari/iOS MediaRecorder output) as audio/mp4', async () => {
    // size(4) + 'ftyp' + 'isom' brand (a non-M4A brand → detectMedia resolves it as mp4/video).
    const mp4 = Buffer.from([
      0x00, 0x00, 0x00, 0x20, 0x66, 0x74, 0x79, 0x70, 0x69, 0x73, 0x6f, 0x6d,
    ]);
    const r = await svc.consumeAudio(fakeReq(mp4, 'voice.mp4', 'audio/mp4'));
    expect(r.kind).toBe('file');
    if (r.kind === 'file') {
      expect(r.ext).toBe('mp4');
      expect(r.mime).toBe('audio/mp4');
    }
  });

  it('still accepts a native audio container (ogg) as audio/ogg', async () => {
    const ogg = Buffer.from([0x4f, 0x67, 0x67, 0x53]); // 'OggS'
    const r = await svc.consumeAudio(fakeReq(ogg, 'clip.ogg', 'audio/ogg'));
    expect(r.kind).toBe('file');
    if (r.kind === 'file') expect(r.ext).toBe('ogg');
  });

  it('rejects a non-media buffer (no recognized container signature) as wrong-type', async () => {
    const r = await svc.consumeAudio(
      fakeReq(Buffer.from([0x00, 0x00, 0x00, 0x00])),
    );
    expect(r.kind).toBe('rejected');
    if (r.kind === 'rejected') expect(r.reason).toBe('wrong-type');
  });
});

describe('UploadService.consumeChatImage — unsupported-format fallback', () => {
  const svc = new UploadService({} as never);

  it('keeps an unsupported HEIC selection as a generic file', async () => {
    const bytes = Buffer.from('unsupported-image-bytes');
    const r = await svc.consumeChatImage(
      fakeReq(bytes, 'phone.heic', 'image/heic'),
    );
    expect(r).toEqual({
      kind: 'fallback-file',
      mimetype: 'image/heic',
      buffer: bytes,
      filename: 'phone.heic',
    });
  });

  it('keeps a supported MIME on the image validation path', async () => {
    const pngHeader = Buffer.from([
      0x89, 0x50, 0x4e, 0x47, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
    ]);
    const r = await svc.consumeChatImage(
      fakeReq(pngHeader, 'photo.png', 'image/png'),
    );
    expect(r.kind).toBe('file');
    if (r.kind === 'file') {
      expect(r.mimetype).toBe('image/png');
      expect(r.buffer).toBe(pngHeader);
      expect(r.filename).toBe('photo.png');
    }
  });

  it('rejects an empty unsupported file instead of reporting success', async () => {
    const r = await svc.consumeChatImage(
      fakeReq(Buffer.alloc(0), 'empty.heic', 'image/heic'),
    );
    expect(r).toEqual({ kind: 'rejected', reason: 'no-file' });
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
    const service = new UploadService(mediaAsset as never);
    stubService(service);
    const body = Buffer.from('persistent resumable CAS body');
    const digest = createHash('sha256').update(body).digest('hex');
    const firstOffsets: number[] = [];

    await expect(
      service.saveCasFromStream(
        'bin',
        (offset) => {
          firstOffsets.push(offset);
          return (async function* () {
            yield body.subarray(0, 10);
            throw new Error('network dropped');
          })();
        },
        digest,
      ),
    ).rejects.toThrow('network dropped');

    const resumedOffsets: number[] = [];
    const saved = await service.saveCasFromStream(
      'bin',
      (offset) => {
        resumedOffsets.push(offset);
        return (async function* () {
          yield body.subarray(offset);
        })();
      },
      digest,
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

  it('deletes untrusted partial state when the final digest mismatches', async () => {
    root = await mkdtemp(join(tmpdir(), 'soms-cas-resume-'));
    const mediaAsset = {
      publishReady: vi.fn().mockResolvedValue(undefined),
    };
    const service = new UploadService(mediaAsset as never);
    stubService(service);
    const expected = createHash('sha256').update('expected').digest('hex');
    await expect(
      service.saveCasFromStream(
        'bin',
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
