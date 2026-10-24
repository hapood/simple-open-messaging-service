import { describe, expect, it } from 'vitest';
import { assertLoginNode } from '../../tools/pi-web-testing/extension/driver-command';

describe('login helper explicit node validation', () => {
  for (const action of ['adminLogin', 'issueOtp', 'userLogin']) {
    it.each([undefined, '', 'unknown'])(
      `${action} rejects invalid node %s before dispatch`,
      (node) => {
        expect(() => assertLoginNode({ action, node })).toThrow(
          `${action} requires an explicit node: alpha, bravo, or charlie.`,
        );
      },
    );

    it.each(['alpha', 'bravo', 'charlie'])(
      `${action} accepts explicit node %s`,
      (node) => {
        expect(() => assertLoginNode({ action, node })).not.toThrow();
      },
    );
  }

  it.each(['status', 'preflight', 'inspect', 'open', 'eval', 'close'])(
    '%s does not require a login node',
    (action) => {
      expect(() => assertLoginNode({ action })).not.toThrow();
    },
  );
});
