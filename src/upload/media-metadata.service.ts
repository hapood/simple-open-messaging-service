import { Injectable } from '@nestjs/common';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import sharp, { type Metadata } from 'sharp';
import { ContentType } from '../database/enums.js';
import { open } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { detectMedia, type DetectedMedia } from './media-sig.js';
import { runMediaTool, InvalidMediaDataError } from './media-tool.js';
import type { StoredMediaMetadata } from './stored-media-metadata.js';

export interface ServerMediaMetadata {
  w?: number;
  h?: number;
  duration?: number;
}

interface ProbeOutput {
  streams?: Array<{
    codec_type?: string;
    disposition?: { attached_pic?: number };
    width?: number;
    height?: number;
    duration?: string;
    tags?: { rotate?: string };
    side_data_list?: Array<{ rotation?: number }>;
  }>;
  format?: { duration?: string };
}

/** Authoritative metadata extraction for untrusted uploads. ffprobe is bounded by time and output;
 * filenames are passed as argv (never through a shell). */
@Injectable()
export class MediaMetadataService {
  private static readonly MAX_PROBE_OUTPUT = 64 * 1024;
  private static readonly MAX_IMAGE_PIXELS = 40_000_000;
  private processing: Promise<unknown> = Promise.resolve();

  /** Serialize expensive decoders per instance, without holding database transactions. */
  processFile(
    path: string,
  ): Promise<{ meta: StoredMediaMetadata; thumbnail?: Buffer }> {
    const result = this.processing.then(() => this.processCompleteFile(path));
    this.processing = result.catch(() => undefined);
    return result;
  }

  async detectFile(path: string): Promise<DetectedMedia | null> {
    const file = await open(path, 'r');
    let detected: DetectedMedia | null;
    try {
      const header = Buffer.alloc(4096);
      const { bytesRead } = await file.read(header, 0, header.length, 0);
      detected = detectMedia(header.subarray(0, bytesRead));
    } finally {
      await file.close();
    }
    if (!detected || detected.family === 'image') return detected;
    const probe = await this.ffprobe(path);
    const streams = probe.streams ?? [];
    if (
      streams.some(
        (s) => s.codec_type === 'video' && !s.disposition?.attached_pic,
      )
    )
      return { ...detected, family: 'video' };
    if (streams.some((s) => s.codec_type === 'audio'))
      return { ...detected, family: 'audio' };
    throw new InvalidMediaDataError('media has no audio or video stream');
  }

  private async processCompleteFile(
    path: string,
  ): Promise<{ meta: StoredMediaMetadata; thumbnail?: Buffer }> {
    const detected = await this.detectFile(path);
    if (!detected)
      return {
        meta: {
          mimeType: 'application/octet-stream',
          kind: 'FILE',
        },
      };
    const kind = detected.family.toUpperCase() as 'IMAGE' | 'VIDEO' | 'AUDIO';
    const dimensions = await this.fromFile(path, kind);
    const special: Record<string, string> = {
      jpg: 'image/jpeg',
      mp3: 'audio/mpeg',
      m4a: 'audio/mp4',
      wav: 'audio/wav',
      avi: 'video/x-msvideo',
      flv: 'video/x-flv',
    };
    const mimeType =
      special[detected.ext] ?? `${detected.family}/${detected.ext}`;
    if (kind === 'AUDIO')
      return {
        meta: {
          mimeType,
          kind,
          duration: dimensions.duration!,
        },
      };
    const input =
      kind === 'IMAGE'
        ? path
        : await runMediaTool(
            'ffmpeg',
            [
              '-v',
              'error',
              '-nostdin',
              '-threads',
              '1',
              '-protocol_whitelist',
              'file,pipe',
              '-i',
              path,
              '-map',
              '0:V:0',
              '-frames:v',
              '1',
              '-an',
              '-vf',
              "scale=w='min(960,iw)':h='min(960,ih)':force_original_aspect_ratio=decrease",
              '-threads',
              '1',
              '-f',
              'image2pipe',
              '-vcodec',
              'png',
              'pipe:1',
            ],
            8 * 1024 * 1024,
          );
    const { data, info } = await sharp(input, {
      limitInputPixels: MediaMetadataService.MAX_IMAGE_PIXELS,
    })
      .rotate()
      .resize({
        width: 960,
        height: 960,
        fit: 'inside',
        withoutEnlargement: true,
      })
      .webp({ quality: 80 })
      .toBuffer({ resolveWithObject: true });
    if (data.length > 1024 * 1024)
      throw new Error('thumbnail output too large');
    const thumbnail = {
      digest: createHash('sha256').update(data).digest('hex'),
      size: data.length,
      mimeType: 'image/webp' as const,
      width: info.width,
      height: info.height,
    };
    const media =
      kind === 'IMAGE'
        ? { kind, width: dimensions.w!, height: dimensions.h!, thumbnail }
        : {
            kind,
            width: dimensions.w!,
            height: dimensions.h!,
            duration: dimensions.duration!,
            thumbnail,
          };
    return { meta: { mimeType, ...media }, thumbnail: data };
  }

  async fromBuffer(
    input: Buffer,
    intent: 'IMAGE' | 'VIDEO' | 'AUDIO' | 'FILE',
  ): Promise<ServerMediaMetadata> {
    if (intent === ContentType.FILE) return {};
    if (intent === ContentType.IMAGE) return this.image(input);
    // Some containers expose duration only through seekable input. Persist the already-bounded
    // multipart buffer to an isolated temporary file instead of trusting incomplete pipe metadata.
    const dir = await mkdtemp(join(tmpdir(), 'soms-media-probe-'));
    const path = join(dir, 'input');
    try {
      await writeFile(path, input, { flag: 'wx' });
      return await this.av(intent, path);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }

  async fromFile(
    path: string,
    intent: 'IMAGE' | 'VIDEO' | 'AUDIO' | 'FILE',
  ): Promise<ServerMediaMetadata> {
    if (intent === ContentType.FILE) return {};
    if (intent === ContentType.IMAGE) return this.image(path);
    return this.av(intent, path);
  }

  private async image(input: Buffer | string): Promise<ServerMediaMetadata> {
    let meta: Metadata;
    try {
      meta = await sharp(input, {
        limitInputPixels: MediaMetadataService.MAX_IMAGE_PIXELS,
      }).metadata();
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code) throw error;
      throw new InvalidMediaDataError('invalid image metadata');
    }
    if (!meta.width || !meta.height)
      throw new InvalidMediaDataError('invalid image metadata');
    const swap = meta.orientation !== undefined && meta.orientation >= 5;
    return {
      w: swap ? meta.height : meta.width,
      h: swap ? meta.width : meta.height,
    };
  }

  private async av(
    intent: 'AUDIO' | 'VIDEO',
    path: string,
  ): Promise<ServerMediaMetadata> {
    const parsed = await this.ffprobe(path);
    const streams = parsed.streams ?? [];
    const audio = streams.some((stream) => stream.codec_type === 'audio');
    const video = streams.find(
      (stream) =>
        stream.codec_type === 'video' && !stream.disposition?.attached_pic,
    );
    const duration = Number(
      parsed.format?.duration ??
        streams.find((stream) => stream.duration !== undefined)?.duration,
    );
    if (!Number.isFinite(duration) || duration <= 0) {
      throw new InvalidMediaDataError('invalid media duration');
    }
    if (intent === ContentType.AUDIO) {
      if (!audio || video)
        throw new InvalidMediaDataError('audio upload must contain audio only');
      return { duration };
    }
    if (!video || !video.width || !video.height) {
      throw new InvalidMediaDataError(
        'video upload must contain a video stream',
      );
    }
    // Stream dimensions describe encoded pixels, not necessarily the intended display orientation.
    // Modern MP4 stores rotation in a display matrix; older containers use a rotate tag.
    const rotation = Number(
      video.side_data_list?.find((side) => Number.isFinite(side.rotation))
        ?.rotation ??
        video.tags?.rotate ??
        0,
    );
    const normalized = ((rotation % 360) + 360) % 360;
    const swap = normalized === 90 || normalized === 270;
    return {
      w: swap ? video.height : video.width,
      h: swap ? video.width : video.height,
      duration,
    };
  }

  private async ffprobe(path: string): Promise<ProbeOutput> {
    const output = await runMediaTool(
      'ffprobe',
      [
        '-v',
        'error',
        '-protocol_whitelist',
        'file,pipe',
        '-show_entries',
        'stream=codec_type,width,height,duration:stream_disposition=attached_pic:stream_tags=rotate:stream_side_data=rotation:format=duration',
        '-of',
        'json',
        path,
      ],
      MediaMetadataService.MAX_PROBE_OUTPUT,
    );
    return JSON.parse(output.toString('utf8')) as ProbeOutput;
  }
}
