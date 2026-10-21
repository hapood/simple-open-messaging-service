// Native shells forbid unsafe-eval. Reject runtime Angular compilers before packaging, including
// reused WEB_BUILD=0 output. Native artifacts live separately from browser and test builds.
import { readFileSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const defaultDirectory = resolve(
  dirname(fileURLToPath(import.meta.url)),
  '../dist/native',
);

export function verifyNativeBuild(directory = defaultDirectory) {
  const stats = JSON.parse(readFileSync(join(directory, 'stats.json'), 'utf8'));
  if (!stats.inputs || !stats.outputs) {
    throw new Error('Native build is missing Angular bundle metadata.');
  }

  const compilers = Object.keys(stats.inputs).filter((input) =>
    /(?:^|\/)node_modules\/@angular\/(?:compiler|platform-browser-dynamic)\//.test(
      input.replaceAll('\\', '/'),
    ),
  );
  if (compilers.length) {
    throw new Error(
      `Native CSP forbids Angular JIT compilation. Rebuild with AOT; runtime compiler found: ${compilers.join(', ')}`,
    );
  }

  const scripts = Object.entries(stats.outputs).filter(([file]) =>
    file.endsWith('.js'),
  );
  const main = scripts.find(
    ([, output]) => output.entryPoint === 'src/main.ts',
  );
  if (!main) {
    throw new Error(
      'Native build does not contain the application entry point.',
    );
  }
  const index = readFileSync(join(directory, 'browser/index.html'), 'utf8');
  if (!index.includes(main[0])) {
    throw new Error(
      'Native index does not reference the built application entry point.',
    );
  }
  for (const [file] of scripts) {
    if (!statSync(join(directory, 'browser', file)).size) {
      throw new Error(`Native build has an empty script: ${file}`);
    }
  }
}

if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  try {
    verifyNativeBuild();
    console.log(
      '[verify-native-build] AOT application verified; no runtime Angular compiler.',
    );
  } catch (error) {
    console.error(`[verify-native-build] ${error.message}`);
    console.error(
      'Run npm --prefix web run build:native before packaging the native app.',
    );
    process.exitCode = 1;
  }
}
