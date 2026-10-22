// Fixed worker filenames use updateViaCache: 'none' at registration.
// Bundle the same storage, feed executor and projection helpers used by the application.
import { build } from 'esbuild';
import { copyFile, mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { frontendTarget } from './frontend-targets.mjs';
const target = frontendTarget(process.argv[2]);
if (process.argv[2] === 'playground') {
  const directory = new URL(
    '../.generated/playground/deployment-templates/nas/',
    import.meta.url,
  );
  await mkdir(directory, { recursive: true });
  await copyFile(
    new URL('../../deploy/nas/docker-compose.yml', import.meta.url),
    new URL('docker-compose.yml', directory),
  );
}
const require = createRequire(import.meta.url);
execFileSync(
  process.execPath,
  [
    require.resolve('typescript/bin/tsc'),
    '-p',
    fileURLToPath(new URL('../tsconfig.push.json', import.meta.url)),
  ],
  { stdio: 'inherit' },
);
await build({
  entryPoints: [
    fileURLToPath(new URL('../src/push/push-worker.ts', import.meta.url)),
  ],
  outfile: fileURLToPath(
    new URL(`../${target.generated}/push/sw-runtime.js`, import.meta.url),
  ),
  bundle: true,
  format: 'iife',
  platform: 'browser',
  target: 'es2022',
  minify: true,
  sourcemap: false,
  tsconfig: fileURLToPath(new URL('../tsconfig.json', import.meta.url)),
});
