import { mkdtemp, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { describe, expect, it } from 'vitest';
import { loadCases } from './scenario-loader.js';

async function writePlan(markdown: string): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'soms-scenarios-'));
  const path = join(directory, 'plan.md');
  await writeFile(path, markdown);
  return path;
}

describe('loadCases', () => {
  it('loads numbered markdown cases with English heading lists', async () => {
    const path = await writePlan(`
## 1.1 Account login

Login with prepared credentials.

Preconditions:
- Prepared account exists.

Actions:
- Open the login screen.
- Submit credentials.

Expected:
- The account shell is visible.
`);

    const cases = await loadCases(path);

    expect(cases).toHaveLength(1);
    expect(cases[0]).toMatchObject({
      id: '1.1',
      title: '1.1 Account login',
      preconditions: ['Prepared account exists.'],
      actions: ['Open the login screen.', 'Submit credentials.'],
      expectations: ['The account shell is visible.'],
    });
  });

  it('rejects duplicate numbered case ids', async () => {
    const path = await writePlan(`
## 1 First

- **1.1** First case.

## 2 Second

- **1.1** Duplicate case.
`);

    await expect(loadCases(path)).rejects.toThrow(
      'Duplicate numbered E2E case ids: 1.1',
    );
  });
});
