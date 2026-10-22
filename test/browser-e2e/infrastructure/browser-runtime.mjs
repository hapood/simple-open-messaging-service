import { fileURLToPath } from 'node:url';

export const repositoryRoot = fileURLToPath(
  new URL('../../../', import.meta.url),
);

/** Shared by test-runner contexts and the interactive persistent driver. No fallback browser. */
export function browserLaunchOptions(env = process.env) {
  return {
    headless: env.BROWSER_HEADFUL !== '1',
    ...(env.CHROME_PATH ? { executablePath: env.CHROME_PATH } : {}),
  };
}
