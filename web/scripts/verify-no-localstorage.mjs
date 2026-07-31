import { readdir, readFile } from 'node:fs/promises';
import { extname, join, relative } from 'node:path';

const root = new URL('..', import.meta.url).pathname;
const roots = [join(root, 'src'), join(root, 'public')];
const violations = [];

async function walk(dir) {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      await walk(path);
      continue;
    }
    if (!['.ts', '.js', '.html'].includes(extname(path)) || path.endsWith('.spec.ts')) continue;
    const source = await readFile(path, 'utf8');
    source.split(/\r?\n/).forEach((line, index) => {
      if (/\blocalStorage\s*\./.test(line)) {
        violations.push(`${relative(root, path)}:${index + 1}`);
      }
    });
  }
}

for (const dir of roots) await walk(dir);
if (violations.length > 0) {
  throw new Error(`Direct localStorage access is forbidden:\n${violations.join('\n')}`);
}
