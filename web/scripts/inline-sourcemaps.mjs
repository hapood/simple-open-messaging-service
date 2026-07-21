// Inline each source map into its .js / .css file as a base64 data: URI, so DevTools can read the map
// straight from the script content — with NO separate network fetch. That fetch is what fails when
// the SPA runs inside the Tauri Android shell: the bundle is served from the custom-protocol origin
// `http://tauri.localhost/`, and edge://inspect / chrome://inspect (USB remote debug) pull source
// maps through a network path that bypasses the WebView's custom-protocol handler, so the maps never
// load and the console shows only `chunk-*.js:NN`. Inlining removes the fetch entirely (the data:
// URI rides along inside the script), which is the community-standard fix for this exact
// WebView-remote-debug problem — the same one Ionic / Capacitor / Cordova hit, since they too serve
// from a device-local origin the desktop DevTools can't reach.
//
// npm runs this automatically as `postbuild` after every `ng build`. The Makefile builds the web via
// `npm run build -- --configuration <development|production>`: debug APKs emit sourcemaps (→ inlined
// here), production does not (→ this script is a no-op). Idempotent — a comment already pointing at a
// `data:` URI is left untouched, so a re-run (e.g. via the OTA bundle packager) is safe.
import { readFileSync, writeFileSync, readdirSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const dir = join(here, '..', 'dist', 'web', 'browser');

if (!existsSync(dir)) {
  console.log('[inline-sourcemaps] no build output found — skipping');
  process.exit(0);
}

/** Recursively collect every file under `d`. Angular esbuild emits chunks flat at the dist root, but
 *  walking keeps this correct should the output layout ever nest. */
function listFiles(d) {
  const out = [];
  for (const ent of readdirSync(d, { withFileTypes: true })) {
    const p = join(d, ent.name);
    if (ent.isDirectory()) out.push(...listFiles(p));
    else out.push(p);
  }
  return out;
}

let inlined = 0;
let skipped = 0;
for (const file of listFiles(dir)) {
  const isJs = file.endsWith('.js');
  const isCss = file.endsWith('.css');
  if (!isJs && !isCss) continue;

  const src = readFileSync(file, 'utf8');
  // JS:  `//# sourceMappingURL=foo.js.map`
  // CSS: `/*# sourceMappingURL=foo.css.map */`
  const re = isJs
    ? /\/\/#\s*sourceMappingURL=(\S+)/
    : /\/\*#\s*sourceMappingURL=([^\s*]+)\s*\*\//;
  const m = src.match(re);
  if (!m) { skipped++; continue; }

  const mapRef = m[1];
  if (mapRef.startsWith('data:')) { skipped++; continue; } // already inlined

  const mapPath = join(dirname(file), mapRef);
  if (!existsSync(mapPath)) { skipped++; continue; }

  // Base64 alphabet is `$`-free, so the result is safe to use as a String.replace replacement.
  const dataUri = `data:application/json;charset=utf-8;base64,${readFileSync(mapPath).toString('base64')}`;
  const replacement = isJs
    ? `//# sourceMappingURL=${dataUri}`
    : `/*# sourceMappingURL=${dataUri} */`;
  writeFileSync(file, src.replace(re, replacement));
  inlined++;
}
console.log(
  `[inline-sourcemaps] inlined ${inlined} map(s) into dist/web/browser (${skipped} file(s) skipped)`,
);
