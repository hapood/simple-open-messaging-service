/** App version shown in the Settings → About section. Re-exported from package.json so a release
 *  bump propagates automatically; the named import lets esbuild tree-shake the rest of the manifest. */
export { version as appVersion } from '../../package.json';
