import { readFileSync } from 'node:fs';

const readJson = (path) => JSON.parse(readFileSync(path, 'utf8'));
const rootVersion = readJson('package.json').version;

const versions = new Map([
  ['package-lock.json', readJson('package-lock.json').version],
  [
    'package-lock.json workspace',
    readJson('package-lock.json').packages[''].version,
  ],
  ['web/package.json', readJson('web/package.json').version],
  ['web/package-lock.json', readJson('web/package-lock.json').version],
  [
    'web/package-lock.json workspace',
    readJson('web/package-lock.json').packages[''].version,
  ],
  ['admin-web/package.json', readJson('admin-web/package.json').version],
  [
    'admin-web/package-lock.json',
    readJson('admin-web/package-lock.json').version,
  ],
  [
    'admin-web/package-lock.json workspace',
    readJson('admin-web/package-lock.json').packages[''].version,
  ],
  ['src-tauri/tauri.conf.json', readJson('src-tauri/tauri.conf.json').version],
]);

for (const path of ['src-tauri/Cargo.toml', 'src-tauri/Cargo.lock']) {
  const source = readFileSync(path, 'utf8');
  const match = path.endsWith('Cargo.lock')
    ? /name = "soms-client"\nversion = "([^"]+)"/.exec(source)
    : /^version = "([^"]+)"/m.exec(source);
  versions.set(path, match?.[1]);
}

const mismatches = [...versions].filter(
  ([, version]) => version !== rootVersion,
);
if (mismatches.length > 0) {
  for (const [source, version] of mismatches) {
    console.error(
      `${source}: ${version ?? '<missing>'} (expected ${rootVersion})`,
    );
  }
  process.exitCode = 1;
} else {
  console.log(`SOMS version synchronized: ${rootVersion}`);
}
