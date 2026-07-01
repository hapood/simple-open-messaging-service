// Post-build workaround for @nestjs/swagger CLI plugin + native ESM.
//
// The swagger CLI plugin (nest-cli.json compilerOptions.plugins) generates same-file
// DTO self-references as `require("./file", { with: { "resolution-mode": "import" } })`.
// Under "type":"module", tsc rewrites single-argument top-level `require("pkg")` to a
// createRequire-based `__require`, but leaves these multi-argument (import-attribute)
// ones as bare `require()` — which is undefined in ESM and crashes SwaggerModule at boot
// (`require is not defined`). Every affected file already defines `__require`, so we
// only need to retarget the bare RELATIVE requires (the self-refs) onto it.
// Bare-package requires are already `__require`; relative specifiers only ever appear
// in these swagger self-refs (source imports are real ESM `import` statements).
//
// Remove this script once @nestjs/swagger emits ESM-compatible self-references upstream.
import { readdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

async function* walk(dir) {
  for (const e of await readdir(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) yield* walk(p);
    else if (e.name.endsWith('.js')) yield p;
  }
}

let touched = 0;
for await (const file of walk('dist')) {
  const src = await readFile(file, 'utf8');
  // Only files where tsc already emitted the createRequire helper can safely use __require.
  if (!src.includes('__require')) continue;
  // `require(` (word-boundary, so __require is skipped) followed by a relative specifier.
  const re = new RegExp("\\brequire\\((?=['\"]\\.\\.?\\/)", "g");
  const out = src.replace(re, '__require(');
  if (out !== src) {
    await writeFile(file, out);
    touched++;
    console.log(`normalized: ${file}`);
  }
}
console.log(`swagger ESM require-fix applied to ${touched} file(s)`);
