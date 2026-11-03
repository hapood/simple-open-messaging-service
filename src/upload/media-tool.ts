import { spawn } from 'node:child_process';

export class InvalidMediaDataError extends Error {}

/** Bound both output channels and wait for process termination before releasing capacity. */
export function runMediaTool(
  program: 'ffprobe' | 'ffmpeg',
  args: string[],
  maxBytes = 1024 * 1024,
): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const child = spawn(program, args, {
      shell: false,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const chunks: Buffer[] = [];
    let bytes = 0;
    let failure: Error | undefined;
    const stop = (message: string) => {
      failure ??= new Error(message);
      child.kill('SIGKILL');
    };
    const timer = setTimeout(() => stop(`${program} timed out`), 30_000);
    child.stdout.on('data', (chunk: Buffer) => {
      bytes += chunk.length;
      if (bytes > maxBytes) stop(`${program} output too large`);
      else chunks.push(chunk);
    });
    child.stderr.on('data', (chunk: Buffer) => {
      bytes += chunk.length;
      if (bytes > maxBytes) stop(`${program} output too large`);
    });
    child.on('error', (error) => {
      failure = error;
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (failure) reject(failure);
      else if (code !== 0)
        reject(new InvalidMediaDataError(`${program} could not decode media`));
      else resolve(Buffer.concat(chunks));
    });
  });
}
