import { test as base, expect } from '@playwright/test';
import { requireHmrFrontend } from '../hmr-status.mjs';

export const test = base.extend<{}, { federationReady: void }>({
  federationReady: [
    async ({}, use) => {
      await requireHmrFrontend();
      await use();
    },
    { scope: 'worker', auto: true },
  ],
});
export { expect };
