# Browser testing architecture

## Shared runtime, separate environments

Install root and Web dependencies, then install the lockfile-paired browser once:

```sh
npm ci
npm ci --prefix web
npm run test:browser:install
# On CI images missing browser system libraries:
npm run test:browser:install -- --with-deps
```

Playwright regression projects and the persistent Pi driver share Chromium and
launch options. `CHROME_PATH` is an explicit debugging override, not an automatic
fallback. `BROWSER_HEADFUL=1` shows the browser. A failed browser download is an
environment block; a run with a system-browser override is separate evidence.

```sh
npm run test:browser -- --project=playground
npm run test:browser -- --project=federation-desktop
npm run test:browser -- --project=federation-tablet-web
npm run test:browser -- --project=federation-mobile-web
npm run test:browser:unit
```

`npm run test:playground` is an alias for the playground project. With no project
filter, all projects run and both environments are required. Target-specific
worker fixtures, not global setup, own environment preparation:

- Playground starts its own server on `127.0.0.1:4301`, refuses occupied ports,
  disables HMR/live reload/watch, and terminates only its owned process group.
- Federation connects to an already prepared `dev:be` + `dev:fe` lab and checks
  current Web/Admin HMR statuses. It never starts, resets, or stops the lab.
- Mobile Web changes Chromium viewport and touch emulation. It is not Android
  App testing and does not attach to a device through CDP.

Independent invocations have unique directories under
`test-results/browser-e2e/<run>/`, containing artifacts and an HTML report.
Screenshots and traces are retained on failure; passing tests do not take
unasserted decorative screenshots. Tests use fresh browser contexts. Concurrent
federation scenarios still need disjoint accounts and fixture data.

## Interactive Pi entry

`npm run pi:webtest` only loads Pi's browser extension and skill. It does not
select an environment or start servers. The agent checks existing services and
opens a profile with an explicit target:

```json
{"action":"open","target":"playground","user":"composer-debug"}
{"action":"open","target":"federation","node":"alpha","user":"alice-lab"}
```

For playground exploration, start `npm --prefix web run start:playground --
--host 127.0.0.1 --port 4301` separately when the port is free. Interactive HMR is
allowed. Stop that owned development server before running deterministic
playground regression on the same port; the test runner will not silently reuse
it. Federation and playground may be used together in one Pi session.

Subsequent commands identify the profile by `user`; its target is retained on
disk and cannot silently change. Existing unlabelled profiles remain federation
profiles. Playground profile data lives separately under `.playground/` in the
profile root. Neither profile root is placed in test-runner output directories.
Login helpers apply only to federation. Document navigation is restricted to the
selected local origins, including redirects. Trusted Node step modules are not
sandboxed; this guard is not a general network isolation mechanism.

The Pi extension owns tool transport, timeouts, cancellation, and driver lifetime.
The driver owns browser profiles and browser actions. Shared infrastructure owns
browser selection, target definitions, and lab build-status interpretation.
Temporary exploration steps become committed specs when they should guard a
regression. See [driver operations](browser-e2e-tools.md) for retained lab sessions
and secret-safe evidence collection.

## Build isolation

Frontend builds own their output and generated inputs:

| Target | Build output | Generated worker input |
| --- | --- | --- |
| Web | `web/dist/web` | `web/.generated/web` |
| Playground | `web/dist/playground` | `web/.generated/playground` |
| Native | `web/dist/native` | `web/.generated/native` |

Use `npm --prefix web run build`, `build:playground`, or `build:native`.
The runner appends a target-owned Angular output/assets configuration even when
build mode is overridden. Playground Angular configurations also specify their
output directly. Generated workers no longer write to shared `web/public`;
legacy generated `public/push/sw-runtime.js` is excluded from assets.
Development entry points prepare the matching worker before starting Angular.
Source maps, native validation, and Angular output cleanup only touch the selected
target. Concurrent builds of the *same* target are not supported.
