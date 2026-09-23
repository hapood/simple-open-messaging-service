import { mkdtemp, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { describe, expect, it } from 'vitest';
import {
  requiresCoordinatedMultiUser,
  selectCase,
  writeResultFile,
} from './run.js';
import type { NaturalLanguageCase } from './types.js';

const cases: NaturalLanguageCase[] = [
  {
    id: '1.1',
    title: '1.1 Account login',
    goal: 'Login as a single prepared account.',
    preconditions: [],
    actions: [],
    expectations: [],
    source: '',
  },
  {
    id: '2.1',
    title: '2.1 Relationship expiry',
    goal: 'Alice sends an expiring request and later reviews the result.',
    preconditions: [],
    actions: [],
    expectations: [],
    source: '',
  },
  {
    id: '2.2',
    title: '2.2 Relationship cancellation',
    goal: 'Alice cancels a pending request.',
    preconditions: [],
    actions: [],
    expectations: [],
    source: '',
  },
];

describe('selectCase', () => {
  it('prefers exact case ids over title matches', () => {
    expect(selectCase(cases, '2.1')).toBe(cases[1]);
  });

  it('rejects ambiguous title selectors', () => {
    expect(() => selectCase(cases, 'Relationship')).toThrow(
      'Case selector matched multiple titles: 2.1 2.1 Relationship expiry; 2.2 2.2 Relationship cancellation',
    );
  });

  it('rejects missing selectors', () => {
    expect(() => selectCase(cases, 'Not present')).toThrow(
      'Case not found: Not present',
    );
  });
});

describe('requiresCoordinatedMultiUser', () => {
  it('blocks cases that require two named participants', () => {
    expect(
      requiresCoordinatedMultiUser(
        'Alice sends and Bob accepts',
        'The relationship becomes active.',
      ),
    ).toBe(true);
  });

  it('allows single-participant cases that repeat the same actor name', () => {
    expect(
      requiresCoordinatedMultiUser(
        'Alice reviews Alice profile settings',
        'Only one account is controlled.',
      ),
    ).toBe(false);
  });
});

describe('writeResultFile', () => {
  it('writes structured runner results', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'soms-results-'));

    await writeResultFile(
      [
        {
          platform: 'browser',
          caseId: '1.1',
          title: '1.1 Account login',
          outcome: 'SKIPPED',
          reason: 'Not applicable to this platform.',
          steps: 0,
        },
      ],
      directory,
    );

    await expect(
      readFile(join(directory, 'result.json'), 'utf8'),
    ).resolves.toBe(
      JSON.stringify(
        {
          results: [
            {
              platform: 'browser',
              caseId: '1.1',
              title: '1.1 Account login',
              outcome: 'SKIPPED',
              reason: 'Not applicable to this platform.',
              steps: 0,
            },
          ],
        },
        null,
        2,
      ),
    );
  });
});
