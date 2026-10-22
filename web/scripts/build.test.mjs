import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { createBuildPlan, runBuildPlan } from './build.mjs';

for (const [target, configuration, output] of [
  ['web', 'production', 'dist/web'],
  ['native', 'production', 'dist/native'],
  ['playground', 'playground', 'dist/playground'],
]) {
  test(`${target} prepares the worker, builds AOT, and postprocesses its own output`, () => {
    const plan = createBuildPlan(target);
    assert.deepEqual(plan[0], ['scripts/build-push-worker.mjs', target]);
    assert.match(plan[1][0], /[\\/]@angular[\\/]cli[\\/]bin[\\/]ng\.js$/);
    assert.deepEqual(plan[1].slice(1), [
      'build',
      '--configuration',
      `${configuration},${target}-output`,
      '--aot',
      '--output-path',
      output,
      ...(target === 'native' ? ['--stats-json'] : []),
    ]);
    assert.deepEqual(plan.at(-1), [
      'scripts/inline-sourcemaps.mjs',
      `${output}/browser`,
    ]);
    assert.deepEqual(
      plan.slice(2, -1),
      target === 'native' ? [['scripts/verify-native-build.mjs']] : [],
    );
  });
}

for (const args of [
  ['--configuration', 'development'],
  ['--configuration=automation'],
  ['-c', 'development'],
  ['-c=development'],
]) {
  test(`forwards configuration without duplicating a default: ${args.join(' ')}`, () => {
    const command = createBuildPlan('native', args)[1];
    assert.deepEqual(command.slice(2, 4), [
      '--configuration',
      `${args.join(' ').includes('automation') ? 'automation' : 'development'},native-output`,
    ]);
    assert.equal(command.includes('production'), false);
    assert.equal(command.includes('--aot'), true);
    assert.equal(command.at(-1), '--stats-json');
  });
}

test('forwards Pages deployment arguments to Angular', () => {
  const command = createBuildPlan('playground', ['--base-href', '/soms/'])[1];
  assert.deepEqual(command.slice(2, 6), [
    '--configuration',
    'playground,playground-output',
    '--base-href',
    '/soms/',
  ]);
});

for (const override of [
  '--aot=false',
  '--aot',
  '--no-aot',
  '--output-path=/tmp/other',
  '--outputPath',
  '--stats-json=false',
  '--statsJson',
  '--no-stats-json',
  '--watch',
  '--watch=false',
  '--no-watch',
]) {
  test(`rejects target invariant override: ${override}`, () => {
    assert.throws(
      () => createBuildPlan('native', [override]),
      /Unsupported override/,
    );
  });
}

test('rejects unknown and inherited target names', () => {
  for (const target of ['other', 'constructor', '__proto__', undefined]) {
    assert.throws(
      () => createBuildPlan(target),
      /Unknown frontend build target/,
    );
  }
});

test('runs all steps in the Web workspace, even when invoked from another directory', () => {
  const plan = createBuildPlan('native');
  const calls = [];
  runBuildPlan(plan, (executable, args, options) =>
    calls.push({ executable, args, options }),
  );
  assert.deepEqual(
    calls.map((call) => call.args),
    plan,
  );
  for (const call of calls) {
    assert.equal(call.executable, process.execPath);
    assert.equal(call.options.stdio, 'inherit');
    const pkg = JSON.parse(
      readFileSync(`${call.options.cwd}/package.json`, 'utf8'),
    );
    assert.equal(pkg.name, 'soms-web');
  }
});

for (const failedStep of [0, 1, 2]) {
  test(`stops immediately when native build step ${failedStep} fails`, () => {
    const plan = createBuildPlan('native');
    const failure = Object.assign(new Error('fixture failure'), { status: 23 });
    let calls = 0;
    assert.throws(
      () =>
        runBuildPlan(plan, () => {
          if (calls++ === failedStep) throw failure;
        }),
      (error) => error === failure,
    );
    assert.equal(calls, failedStep + 1);
  });
}

test('package entry points share the build runner without lifecycle-hook forks', () => {
  const readPackage = (path) =>
    JSON.parse(readFileSync(new URL(path, import.meta.url), 'utf8'));
  const web = readPackage('../package.json').scripts;
  const admin = readPackage('../../admin-web/package.json').scripts;
  const root = readPackage('../../package.json').scripts;
  assert.equal(web.build, 'node scripts/build.mjs web');
  assert.equal(
    web['build:development'],
    'npm run build -- --configuration development',
  );
  assert.equal(web['build:native'], 'node scripts/build.mjs native');
  assert.equal(web['build:playground'], 'node scripts/build.mjs playground');
  assert.equal(
    web['start:playground'],
    'node scripts/start.mjs playground serve',
  );
  assert.equal(web.start, 'node scripts/start.mjs web serve');
  assert.equal(web.prestart, undefined);
  assert.equal(web.prewatch, undefined);
  assert.equal(
    Object.keys(web).some((name) => /^(?:pre|post)build/.test(name)),
    false,
  );
  assert.equal(web['build:debug'], undefined);
  assert.equal(admin['build:debug'], undefined);
  assert.equal(
    admin['build:development'],
    'npm run build -- --mode development --sourcemap --minify=false',
  );
  assert.equal(root.build, 'npm run build:be');
  assert.equal(
    root['build:fe'],
    'npm run build:development --prefix web && npm run build:development --prefix admin-web',
  );
});

test('Angular target configurations isolate outputs and generated assets even without the npm wrapper', () => {
  const config = JSON.parse(
    readFileSync(new URL('../angular.json', import.meta.url), 'utf8'),
  );
  const build = config.projects.web.architect.build;
  for (const target of ['web', 'native', 'playground']) {
    const overlay = build.configurations[`${target}-output`];
    assert.equal(overlay.outputPath, `dist/${target}`);
    assert.equal(overlay.assets[1].input, `.generated/${target}`);
    assert.deepEqual(overlay.assets[0].ignore, ['push/sw-runtime.js']);
  }
  for (const mode of ['playground', 'playground-development']) {
    assert.equal(build.configurations[mode].outputPath, 'dist/playground');
    assert.equal(
      build.configurations[mode].assets[1].input,
      '.generated/playground',
    );
  }
});

test('application builds default to AOT while unit tests explicitly opt into JIT', () => {
  const config = JSON.parse(
    readFileSync(new URL('../angular.json', import.meta.url), 'utf8'),
  );
  const build = config.projects.web.architect.build;
  assert.equal(build.options.aot, true);
  assert.equal(build.configurations.testing.aot, false);
});
