import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));

// Focused runtime contracts. Production-provider and Angular compilation gates
// remain covered by ng test; this runner does not replace those checks.
export default {
  test: {
    projects: [
      {
        root,
        test: {
          name: 'session-core',
          environment: 'node',
          include: ['src/app/services/session/*.spec.ts'],
          exclude: ['**/browser-auth.integration.spec.ts'],
        },
      },
      {
        root,
        test: {
          name: 'browser-session',
          environment: 'jsdom',
          include: [
            'src/app/services/session/browser-auth.integration.spec.ts',
          ],
        },
      },
    ],
  },
};
