import assert from 'node:assert/strict';
import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
  rmSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { test } from 'node:test';

for (const scenario of ['primary', 'fallback', 'unreachable', 'apt-failure']) {
  test(`CI APT setup: ${scenario}`, () => {
    const root = mkdtempSync(join(tmpdir(), 'soms-apt-test-'));
    try {
      mkdirSync(join(root, 'apt.conf.d'));
      writeFileSync(join(root, 'apt-mirrors.txt'), 'original\n');
      writeFileSync(
        join(root, 'os-release'),
        'ID=ubuntu\nVERSION_CODENAME=jammy\n',
      );
      const script = readFileSync(
        new URL('./setup-ci-apt.sh', import.meta.url),
        'utf8',
      )
        .replace('/etc/os-release', `${root}/os-release`)
        .replaceAll('/etc/apt/', `${root}/`);
      writeFileSync(join(root, 'setup.sh'), script);
      const commands = {
        dpkg: 'echo amd64',
        sudo: 'exec "$@"',
        curl: `
          echo "$*" >> "$TEST_ROOT/probes"
          case "$SCENARIO" in
            unreachable) exit 1 ;;
            fallback) [[ "$*" != *archive.ubuntu.com* ]] ;;
            *) exit 0 ;;
          esac`,
        'apt-get':
          'echo "$*" >> "$TEST_ROOT/apt-calls"; [[ "$SCENARIO" != apt-failure ]]',
      };
      for (const [name, body] of Object.entries(commands)) {
        writeFileSync(join(root, name), `#!/bin/bash\n${body}\n`, {
          mode: 0o755,
        });
      }
      const result = spawnSync('bash', [join(root, 'setup.sh')], {
        env: {
          ...process.env,
          PATH: `${root}:${process.env.PATH}`,
          TEST_ROOT: root,
          SCENARIO: scenario,
        },
        encoding: 'utf8',
      });
      assert.equal(
        result.status,
        ['unreachable', 'apt-failure'].includes(scenario) ? 1 : 0,
        result.stderr,
      );
      const mirror = readFileSync(join(root, 'apt-mirrors.txt'), 'utf8');
      if (scenario === 'unreachable') {
        assert.equal(mirror, 'original\n');
      } else {
        assert.equal(
          mirror,
          scenario === 'fallback'
            ? 'https://mirrors.edge.kernel.org/ubuntu\n'
            : 'https://archive.ubuntu.com/ubuntu\n',
        );
        assert.equal(readFileSync(join(root, 'apt-calls'), 'utf8'), 'update\n');
        assert.match(
          readFileSync(join(root, 'apt.conf.d/80-soms-ci'), 'utf8'),
          /APT::Update::Error-Mode "any"/,
        );
        assert.match(
          readFileSync(join(root, 'probes'), 'utf8'),
          /jammy-security\/InRelease/,
        );
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
}
