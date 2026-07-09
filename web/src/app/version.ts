/** App version shown in the Settings → About section. Read from package.json so a release bump propagates
 *  automatically; reading only `pkg.version` lets esbuild tree-shake the rest of the manifest. A default import
 *  (rather than `export { version } from`) is required because package.json is a default-exporting module — webpack's
 *  strict ESM build rejects a named re-export from it (the production esbuild build tolerates it, the test build does not). */
import pkg from '../../package.json';
export const appVersion: string = pkg.version;
