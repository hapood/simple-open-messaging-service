import { describe, expect, it } from 'vitest';
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

  it('derives audio duration with bounded ffprobe', async () => {
    const meta = await service.fromBuffer(oneSecondWav(), 'AUDIO');
    expect(meta.duration).toBeCloseTo(1, 2);
    expect(meta.w).toBeUndefined();
    expect(meta.h).toBeUndefined();
  });
});
