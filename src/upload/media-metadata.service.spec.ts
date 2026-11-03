import { describe, expect, it, vi } from 'vitest';
import sharp from 'sharp';
import { MediaMetadataService } from './media-metadata.service.js';

function oneSecondWav(): Buffer {
  const sampleRate = 8_000;
  const pcmBytes = sampleRate * 2;
  const out = Buffer.alloc(44 + pcmBytes);
  out.write('RIFF', 0);
  out.writeUInt32LE(36 + pcmBytes, 4);
  out.write('WAVEfmt ', 8);
  out.writeUInt32LE(16, 16);
  out.writeUInt16LE(1, 20);
  out.writeUInt16LE(1, 22);
  out.writeUInt32LE(sampleRate, 24);
  out.writeUInt32LE(sampleRate * 2, 28);
  out.writeUInt16LE(2, 32);
  out.writeUInt16LE(16, 34);
  out.write('data', 36);
  out.writeUInt32LE(pcmBytes, 40);
  return out;
}

describe('MediaMetadataService', () => {
  const service = new MediaMetadataService();

  it('derives image dimensions on the server', async () => {
    const png = await sharp({
      create: {
        width: 17,
        height: 23,
        channels: 3,
        background: '#fff',
      },
    })
      .png()
      .toBuffer();
    await expect(service.fromBuffer(png, 'IMAGE')).resolves.toEqual({
      w: 17,
      h: 23,
    });
  });

  it.each([90, -90, 270, 450])(
    'uses display dimensions for rotation %s',
    async (rotation) => {
      const instance = new MediaMetadataService();
      const probe = vi.spyOn(
        instance as unknown as { ffprobe(path: string): Promise<unknown> },
        'ffprobe',
      );
      probe.mockResolvedValue({
        streams: [
          {
            codec_type: 'video',
            width: 1920,
            height: 1080,
            side_data_list: [{ rotation }],
          },
        ],
        format: { duration: '1' },
      });
      await expect(instance.fromFile('unused', 'VIDEO')).resolves.toEqual({
        w: 1080,
        h: 1920,
        duration: 1,
      });
    },
  );

  it.each([0, 180, 360])(
    'preserves dimensions for rotation %s',
    async (rotation) => {
      const instance = new MediaMetadataService();
      vi.spyOn(
        instance as unknown as { ffprobe(path: string): Promise<unknown> },
        'ffprobe',
      ).mockResolvedValue({
        streams: [
          {
            codec_type: 'video',
            width: 1920,
            height: 1080,
            tags: { rotate: String(rotation) },
          },
        ],
        format: { duration: '1' },
      });
      await expect(instance.fromFile('unused', 'VIDEO')).resolves.toEqual({
        w: 1920,
        h: 1080,
        duration: 1,
      });
    },
  );

  it('uses the display matrix before the legacy rotation tag', async () => {
    const instance = new MediaMetadataService();
    vi.spyOn(
      instance as unknown as { ffprobe(path: string): Promise<unknown> },
      'ffprobe',
    ).mockResolvedValue({
      streams: [
        {
          codec_type: 'video',
          width: 1920,
          height: 1080,
          tags: { rotate: '0' },
          side_data_list: [{ rotation: -90 }],
        },
      ],
      format: { duration: '1' },
    });
    await expect(instance.fromFile('unused', 'VIDEO')).resolves.toEqual({
      w: 1080,
      h: 1920,
      duration: 1,
    });
  });

  it('derives audio duration with bounded ffprobe', async () => {
    const meta = await service.fromBuffer(oneSecondWav(), 'AUDIO');
    expect(meta.duration).toBeCloseTo(1, 2);
    expect(meta.w).toBeUndefined();
    expect(meta.h).toBeUndefined();
  });
});
