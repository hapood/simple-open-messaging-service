import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const SRC = join(dirname(fileURLToPath(import.meta.url)), '..'); // src/common → src

/** Recursively collect every *.controller.ts under `dir`. */
function controllerFiles(dir: string, acc: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) controllerFiles(p, acc);
    else if (name.endsWith('.controller.ts')) acc.push(p);
  }
  return acc;
}

/**
 * Structural guard for the @Raw invariant. A handler that takes over the raw response — `reply.hijack()`
 * or a bare `@Res()` (non-passthrough; NOT `@Res({ passthrough: true })`) — MUST be @Raw, else the global
 * SerializeInterceptor wraps its output in the ApiResult envelope → a double-wrapped / malformed stream.
 * Nest auto-skips the interceptor for hijacked/non-passthrough-@Res returns today, but @Raw makes the
 * intent explicit and survives that behavior changing. (The bare `@Res()` form is what every raw handler
 * here uses; `@Res({ passthrough: false })` would also be non-passthrough but is unused.)
 */
describe('@Raw invariant', () => {
  const files = controllerFiles(SRC);

  it('every controller that hijacks the reply or uses a non-passthrough @Res() is @Raw', () => {
    const offenders = files
      .map((f) => ({ f, src: readFileSync(f, 'utf8') }))
      .filter(
        ({ src }) => src.includes('reply.hijack(') || /@Res\(\)/.test(src),
      )
      .filter(({ src }) => !src.includes('@Raw'))
      .map(({ f }) => f);
    expect(
      offenders,
      `raw-response controllers missing @Raw (would double-wrap): ${offenders.join(', ')}`,
    ).toEqual([]);
  });
});
