import { Injectable } from '@nestjs/common';
import { spawn } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import sharp from 'sharp';
import { ContentType } from '../database/enums.js';

export interface ServerMediaMetadata {
  w?: number;
  h?: number;
  duration?: number;
}

interface ProbeOutput {
  streams?: Array<{
    codec_type?: string;
    width?: number;
    height?: number;
    duration?: string;
  }>;
  format?: { duration?: string };
}

/** Authoritative metadata extraction for untrusted uploads. ffprobe is bounded by time and output;
 * filenames are passed as argv (never through a shell). */
@Injectable()
export class MediaMetadataService {
  private static readonly PROBE_TIMEOUT_MS = 10_000;
  private static readonly MAX_PROBE_OUTPUT = 64 * 1024;
  private static readonly MAX_IMAGE_PIXELS = 40_000_000;

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
    const meta = await sharp(input, {
      limitInputPixels: MediaMetadataService.MAX_IMAGE_PIXELS,
    }).metadata();
    if (!meta.width || !meta.height) throw new Error('invalid image metadata');
    return { w: meta.width, h: meta.height };
  }

  private async av(
    intent: 'AUDIO' | 'VIDEO',
    path: string,
  ): Promise<ServerMediaMetadata> {
    const parsed = await this.ffprobe(path);
    const streams = parsed.streams ?? [];
    const audio = streams.some((stream) => stream.codec_type === 'audio');
    const video = streams.find((stream) => stream.codec_type === 'video');
    const duration = Number(
      parsed.format?.duration ??
        streams.find((stream) => stream.duration !== undefined)?.duration,
    );
    if (!Number.isFinite(duration) || duration < 0) {
      throw new Error('invalid media duration');
    }
    if (intent === ContentType.AUDIO) {
      if (!audio || video)
        throw new Error('audio upload must contain audio only');
      return { duration };
    }
    if (!video || !video.width || !video.height) {
      throw new Error('video upload must contain a video stream');
    }
    return { w: video.width, h: video.height, duration };
  }

  private ffprobe(path: string): Promise<ProbeOutput> {
    return new Promise((resolve, reject) => {
      const args = [
        '-v',
        'error',
        '-show_entries',
        'stream=codec_type,width,height,duration:format=duration',
        '-of',
        'json',
        path,
      ];
      const child = spawn('ffprobe', args, {
        shell: false,
        stdio: ['pipe', 'pipe', 'pipe'],
      });
      const stdout: Buffer[] = [];
      const stderr: Buffer[] = [];
      let outputBytes = 0;
      let settled = false;
      const finish = (error?: Error, value?: ProbeOutput) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (error) reject(error);
        else resolve(value ?? {});
      };
      const timer = setTimeout(() => {
        child.kill('SIGKILL');
        finish(new Error('media metadata probe timed out'));
      }, MediaMetadataService.PROBE_TIMEOUT_MS);
      child.stdout.on('data', (chunk: Buffer) => {
        outputBytes += chunk.length;
        if (outputBytes > MediaMetadataService.MAX_PROBE_OUTPUT) {
          child.kill('SIGKILL');
          finish(new Error('media metadata probe output too large'));
          return;
        }
        stdout.push(chunk);
      });
      child.stderr.on('data', (chunk: Buffer) => stderr.push(chunk));
      child.on('error', (error) => finish(error));
      child.on('close', (code) => {
        if (settled) return;
        if (code !== 0) {
          finish(
            new Error(
              `invalid media: ${Buffer.concat(stderr).toString('utf8').slice(0, 200)}`,
            ),
          );
          return;
        }
        try {
          finish(undefined, JSON.parse(Buffer.concat(stdout).toString('utf8')));
        } catch {
          finish(new Error('invalid media probe response'));
        }
      });
      child.stdin.end();
    });
  }
}
