// One-shot frontend builds share preparation and postprocessing. Angular owns continuous rebuilds
// through start/watch; packaging builds always use AOT and target-owned output directories.
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const webDirectory = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const angularCli = require.resolve('@angular/cli/bin/ng.js');
import { frontendTarget } from './frontend-targets.mjs';
const reservedOptions = new Set([
  '--aot',
  '--no-aot',
  '--output-path',
  '--outputPath',
  '--stats-json',
  '--statsJson',
  '--no-stats-json',
  '--watch',
  '--no-watch',
]);

export function createBuildPlan(target, args = []) {
  const options = frontendTarget(target);
  for (const arg of args) {
    if (reservedOptions.has(arg.split('=')[0])) {
      throw new Error(
        `Build targets own AOT, output paths and metadata; use npm run watch for continuous builds. Unsupported override: ${arg}`,
      );
    }
  }

  let configuration = options.configuration;
  const forwarded = [];
  for (let i = 0; i < args.length; i++) {
    const [key, value] = args[i].split('=');
    if (key === '--configuration' || key === '-c') {
      configuration = value ?? args[++i];
      if (!configuration) throw new Error('Missing configuration value.');
    } else forwarded.push(args[i]);
  }
  const commands = [
    ['scripts/build-push-worker.mjs', target],
    [
      angularCli,
      'build',
      '--configuration',
      `${configuration},${options.overlay}`,
      ...forwarded,
      '--aot',
      '--output-path',
      options.output,
      ...(target === 'native' ? ['--stats-json'] : []),
    ],
  ];
  if (target === 'native') commands.push(['scripts/verify-native-build.mjs']);
  commands.push(['scripts/inline-sourcemaps.mjs', `${options.output}/browser`]);
  return commands;
}

export function runBuildPlan(commands, execute = execFileSync) {
  for (const command of commands) {
    execute(process.execPath, command, { cwd: webDirectory, stdio: 'inherit' });
  }
}

if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  try {
    runBuildPlan(createBuildPlan(process.argv[2], process.argv.slice(3)));
  } catch (error) {
    console.error(`[frontend-build] ${error.message}`);
    process.exitCode =
      Number.isInteger(error.status) && error.status > 0 ? error.status : 1;
  }
}
