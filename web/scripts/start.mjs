import { execFileSync, spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { frontendTarget } from './frontend-targets.mjs';

const require = createRequire(import.meta.url);
const cwd = fileURLToPath(new URL('../', import.meta.url));
const target = process.argv[2];
frontendTarget(target);
// A target's source/assets/output are selected together; use build.mjs for packaging mode overrides.
const forwarded = process.argv.slice(4);
for (const arg of forwarded) {
  if (
    [
      '--configuration',
      '-c',
      '--build-target',
      '--buildTarget',
      '--output-path',
      '--outputPath',
    ].includes(arg.split('=')[0])
  )
    throw new Error(`Development targets own configuration and output: ${arg}`);
}
const mode = process.argv[3];
if (!['serve', 'watch'].includes(mode))
  throw new Error('Expected serve or watch.');
execFileSync(process.execPath, ['scripts/build-push-worker.mjs', target], {
  cwd,
  stdio: 'inherit',
});
const args =
  mode === 'serve'
    ? [
        'serve',
        '--configuration',
        target === 'playground' ? 'playground' : 'development',
      ]
    : [
        'build',
        '--watch',
        '--configuration',
        `development,${frontendTarget(target).overlay}`,
      ];
const child = spawn(
  process.execPath,
  [require.resolve('@angular/cli/bin/ng.js'), ...args, ...forwarded],
  { cwd, stdio: 'inherit' },
);
for (const signal of ['SIGINT', 'SIGTERM'])
  process.on(signal, () => child.kill(signal));
child.once('error', (error) => {
  console.error(error);
  process.exitCode = 1;
});
child.once('exit', (code) => {
  process.exitCode = code ?? 1;
});
