// Post-build workaround for @nestjs/swagger CLI plugin + native ESM.
//
// The swagger CLI plugin generates same-file DTO self-references as
// `require("./file", { with: { "resolution-mode": "import" } })`. Under
// "type":"module", tsc rewrites single-argument top-level `require("pkg")` to a
// createRequire-based `__require`, but leaves these multi-arg (import-attribute)
// ones as bare `require()` — undefined in ESM, crashing SwaggerModule at boot.
//
// The plugin's own `esmCompatible` option is the intended fix, but in 11.4.x its
// codegen is buggy: it emits `() => (await import("./file")).X` — `await` in a
// non-async arrow → SyntaxError. So neither default nor esmCompatible works
// unaided for same-file DTO refs. This script instead retargets the bare
// RELATIVE requires onto each file's already-defined `__require` (createRequire),
// which is synchronous and returns the module namespace. Only relative
// specifiers are touched (bare-package requires are already `__require`; source
// imports are real ESM import statements). Dev (tsx) is unaffected — the plugin
// only runs at `nest build`.
//
// Revisit once @nestjs/swagger ships an `esmCompatible` that emits valid code,
// then delete this and set `esmCompatible: true` in nest-cli.json.
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
