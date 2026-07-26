import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const webRoot = resolve(fileURLToPath(new URL('..', import.meta.url)));
const tokenFile = resolve(webRoot, 'src/app/assets/_tokens.scss');
const source = readFileSync(tokenFile, 'utf8');

const requiredTokens = [
  '--app-brand',
  '--app-brand-pressed',
  '--app-on-brand',
  '--app-focus-ring',
  '--app-bg',
  '--app-surface',
  '--app-surface-subtle',
  '--app-surface-elevated',
  '--app-surface-sunken',
  '--app-text',
  '--app-text-muted',
  '--app-text-faint',
  '--app-text-disabled',
  '--app-border',
  '--app-border-strong',
  '--app-hover',
  '--app-pressed',
  '--app-selected',
  '--app-selected-strong',
  '--app-danger',
  '--app-danger-soft',
  '--app-warning',
  '--app-warning-soft',
  '--app-success',
  '--app-success-soft',
  '--app-info',
  '--app-info-soft',
  '--app-shadow-1',
  '--app-shadow-2',
  '--app-shadow-3',
  '--app-touch-target',
  '--app-font-size-body',
  '--app-line-height-body',
  '--app-motion-fast',
  '--app-ease-standard',
  '--chat-bg',
  '--chat-bubble-outgoing',
  '--chat-bubble-incoming',
  '--chat-text',
  '--chat-meta',
  '--chat-date-bg',
  '--chat-date-text',
  '--soms-safe-top',
  '--soms-safe-bottom',
];

const definitions = new Set(
  [...source.matchAll(/(--[a-z][a-z0-9-]*)\s*:/g)].map((match) => match[1]),
);
const missing = requiredTokens.filter((token) => !definitions.has(token));

if (missing.length > 0) {
  console.error('[design-tokens] Missing required token definitions:');
  for (const token of missing) console.error(`  - ${token}`);
  process.exitCode = 1;
} else {
  console.log(`[design-tokens] verified ${requiredTokens.length} required tokens`);
}
