# Continuous integration test coverage

CI runs `.github/workflows/ci.yml` for pull requests and pushes to `dev` and
`main`. Its reusable application checks live in `verify.yml`; container
publication also waits for that workflow before publishing multi-platform tags.
A successful build is not a substitute for running the corresponding tests.

## Automated gates

| Suite | Entry point | CI location |
| --- | --- | --- |
| Native IPC registration / capability contract | `npm run test:native-contracts` | `verify / verify`, before dependency installation |
| Repository tools, federation lab helpers, deployment, Caddy routing, and conformance validator tests | `npm run test:tooling` | `verify / verify` |
| Browser automation infrastructure unit tests | `npm run test:browser:unit` | `verify / verify` |
| Cross-platform automation infrastructure unit tests | `npm run test:cross-platform:unit` | `verify / verify` |
| Circular-dependency checker and project graph | `npm test --prefix tools/cycle-check`, `npm run check:cycles` | `verify / verify` |
| Backend, shared contracts, and test support unit tests | `npm test` | `verify / verify` |
| Protocol conformance vectors | `npm run federation:conformance` | `verify / verify` |
| Web build tools, pure unit tests, and Angular component tests | `npm run test:build --prefix web`, `npm run test:unit --prefix web`, `npm test --prefix web` | `verify / verify` |
| Administration console unit tests | `npm test --prefix admin-web` | `verify / verify` |
| PostgreSQL-backed backend / federation integration tests | `npm run test:e2e` | `verify / backend-e2e` |
| Playground browser scenarios | `npm run test:playground` | `verify / playground-e2e` |
| Shared Rust runtime unit tests | `cargo test --manifest-path src-tauri/Cargo.toml --locked --lib` | `CI / linux`, `CI / macos` |
| Android JVM unit tests | `./gradlew :app:testUniversalDebugUnitTest --no-daemon` in `src-tauri/gen/android` | `CI / android` |

The tooling runner uses directory globs rather than enumerating individual test
files. New Node tests in those directories are included automatically. Web
script tests and the cycle checker retain their own package-level entry points.
When adding a new directory or test framework, update its CI entry and this table.

For a local tooling run, install the root dependencies and Playwright Chromium,
then run:

```sh
SOMFP_SPEC_DIR="$PWD/spec" CADDY_BIN=/path/to/caddy npm run test:tooling
```

The Android WebView flow tests in this suite use fixture pages in Chromium;
they do not connect to a phone. Caddy routing tests need a real Caddy binary.
They may skip locally when it is absent, but fail on CI instead of silently
reporting a skipped routing check. CI extracts Caddy 2.11 from its container image.

The backend E2E job owns a disposable PostgreSQL 18 service. Its credentials
are test-only, and the suite creates per-run isolated databases. Never point
this job at a deployed database.

## Packaging guard

`make -C src-tauri apk`, `apk-debug`, `apk-e2e-debug`, `linux`, and `macos` depend
on `check-ipc-permissions`. The native release workflow uses these same targets,
so missing or stale ACL entries fail before packaging, including local builds.
This guard checks the registration / permission contract; it does not prove
that every command behaves correctly at runtime or that every capability is
valid for every window and origin. Direct Cargo/Tauri invocations bypass this
Makefile guard and must run `npm run test:native-contracts` explicitly.

## Explicit remaining coverage gaps

- Android instrumentation tests under `src-tauri/gen/android/app/src/androidTest`
  need a device or emulator. The default CI job runs JVM tests and builds an
  arm64 APK, but does not execute instrumentation tests.
- `npm run test:cross-platform` drives device/browser environments and requires
  a configured test lab. Its infrastructure unit tests are automated; its
  full acceptance scenarios are not part of the default workflow.
- Playwright `federation-*` projects need the dedicated three-node lab.
  PostgreSQL-backed federation integration tests are automated, but those UI
  projects are not equivalent to them and remain outside the default workflow.
- `npm run federation:test` is the stateful lab workload, not the lab helper
  unit suite. It is not run automatically against a developer's lab.
- Windows-native build/runtime validation and Android ABI/runtime matrices are
  not covered by the current Linux, macOS, and arm64 Android build jobs.
- Native release publication runs the packaging ACL guard, but does not rerun
  the entire PR CI suite for a selected historical tag. Repository branch and
  release policies must enforce the required CI checks for release commits.

Do not use `continue-on-error`, test exclusion, or missing-tool skips to make a
newly connected suite green. Record exposed failures and fix the owning code or
test separately, retaining failure artifacts where available.
