import { describe, expect, it } from 'vitest';
import { parseDecisionText } from './decision-schema.js';

describe('parseDecisionText', () => {
  it('accepts a complete tap action', () => {
    expect(
      parseDecisionText(
        JSON.stringify({
          action: { type: 'tap', target: 'css=#login', reason: 'Open login' },
          evidence: 'The control is visible',
        }),
      ),
    ).toEqual({
      action: { type: 'tap', target: 'css=#login', reason: 'Open login' },
      evidence: 'The control is visible',
    });
  });

  it('rejects unknown actions and missing targets', () => {
    expect(() =>
      parseDecisionText(
        JSON.stringify({
          action: { type: 'runShell', command: 'id', reason: 'Not allowed' },
        }),
      ),
    ).toThrow('unsupported type runShell');

    expect(() =>
      parseDecisionText(
        JSON.stringify({ action: { type: 'tap', reason: 'Click it' } }),
      ),
    ).toThrow('action.target');
  });

  it('rejects invalid keys, contexts, and out-of-range waits', () => {
    for (const action of [
      { type: 'press', key: 'TAB', reason: 'Move focus' },
      { type: 'switchContext', context: 'shell', reason: 'Switch context' },
      { type: 'wait', milliseconds: 15_001, reason: 'Wait' },
    ]) {
      expect(() => parseDecisionText(JSON.stringify({ action }))).toThrow(
        'Invalid AI action',
      );
    }
  });

  it('accepts only defined finish outcomes', () => {
    expect(
      parseDecisionText(
        JSON.stringify({
          action: { type: 'finish', outcome: 'BLOCKED', reason: 'No device' },
        }),
      ).action,
    ).toEqual({ type: 'finish', outcome: 'BLOCKED', reason: 'No device' });

    expect(() =>
      parseDecisionText(
        JSON.stringify({
          action: { type: 'finish', outcome: 'MAYBE', reason: 'Unclear' },
        }),
      ),
    ).toThrow('unsupported outcome MAYBE');
  });

  it('rejects malformed JSON and missing decisions', () => {
    expect(() => parseDecisionText('{')).toThrow('invalid JSON');
    expect(() =>
      parseDecisionText(JSON.stringify({ action: { type: 'tap' } })),
    ).toThrow('action.reason');
  });
});
