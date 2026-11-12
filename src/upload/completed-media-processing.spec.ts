import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import sharp from 'sharp';
import { MediaMetadataService } from './media-metadata.service.js';
import { runMediaTool } from './media-tool.js';
import { isStoredMediaMetadata } from './stored-media-metadata.js';

describe('completed-file media processing', () => {
  let root: string;
  const service = new MediaMetadataService();
  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'media-processing-'));
  });
  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it('extracts oriented image dimensions and hashes the actual thumbnail bytes', async () => {
    const path = join(root, 'input');
    await sharp({
      create: { width: 20, height: 10, channels: 3, background: 'red' },
    })
      .jpeg()
      .withMetadata({ orientation: 6 })
      .toFile(path);
    const result = await service.processFile(path);
    expect(isStoredMediaMetadata(result.meta)).toBe(true);
    expect(result.meta).toMatchObject({
      kind: 'IMAGE',
      width: 10,
      height: 20,
      thumbnail: {
        width: 10,
        height: 20,
        digest: createHash('sha256').update(result.thumbnail!).digest('hex'),
      },
    });
  });

  it.each(['mp4', 'webm'])(
    'identifies audio-only %s by streams, not container family',
    async (ext) => {
      const path = join(root, `input.${ext}`);
      await runMediaTool('ffmpeg', [
        '-v',
        'error',
        '-f',
        'lavfi',
        '-i',
        'sine=frequency=440:duration=0.1',
        '-c:a',
        ext === 'mp4' ? 'aac' : 'libopus',
        path,
      ]);
      const result = await service.processFile(path);
      expect(result.meta.kind).toBe('AUDIO');
      expect(result.thumbnail).toBeUndefined();
      expect(isStoredMediaMetadata(result.meta)).toBe(true);
    },
  );

  it('generates a bounded video thumbnail', async () => {
    const path = join(root, 'input.mp4');
    await runMediaTool('ffmpeg', [
      '-v',
      'error',
      '-f',
      'lavfi',
      '-i',
      'color=c=blue:s=64x32:d=0.1',
      '-c:v',
      'mpeg4',
      path,
    ]);
    const result = await service.processFile(path);
    expect(result.meta).toMatchObject({
      kind: 'VIDEO',
      width: 64,
      height: 32,
    });
    expect(result.thumbnail).toBeDefined();
    expect(isStoredMediaMetadata(result.meta)).toBe(true);
  });

  it('keeps unknown files generic and rejects corrupt recognized media', async () => {
    const path = join(root, 'input');
    await writeFile(path, 'ordinary bytes');
    expect((await service.processFile(path)).meta).toMatchObject({
      kind: 'FILE',
    });
    await writeFile(path, Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 0, 0, 0]));
    await expect(service.processFile(path)).rejects.toThrow();
  });
});
