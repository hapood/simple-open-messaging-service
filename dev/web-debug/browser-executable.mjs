import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';

const requireFromWeb = createRequire(
  new URL('../../web/package.json', import.meta.url),
);

export const puppeteer = requireFromWeb('puppeteer-core');

const candidates = [
  process.env.CHROME_PATH,
  process.env.PUPPETEER_EXECUTABLE_PATH,
  '/usr/bin/google-chrome',
  '/usr/bin/chromium',
  '/usr/bin/chromium-browser',
].filter(Boolean);

export function browserExecutable() {
  const executable = candidates.find((candidate) => existsSync(candidate));
  if (executable) return executable;
  throw new Error(
    'Chrome or Chromium was not found; set CHROME_PATH to its executable',
  );
}
