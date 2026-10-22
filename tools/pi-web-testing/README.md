# Project-specific Pi browser testing

This directory is the opt-in Pi entry point for browser E2E work. It is outside Pi's automatically discovered `.pi/` resource directories, so ordinary `pi` sessions do not load it.

Run the interactive browser-testing agent from the repository root:

```sh
npm run pi:webtest
```

Pass an initial task after `--` when useful:

```sh
npm run pi:webtest -- "Continue the next unfinished browser acceptance case"
```

The command loads only the project browser extension and skill; it does not bind a target or start services. Select `target: "playground"` or `target: "federation"` when opening a new browser profile. Independent work must use separate profiles, fixture scopes, and temporary step files; stateful commands against the same profile or shared fixture remain sequential.

The extension exposes one compact `browser_driver` tool backed by `test/browser-e2e/driver.mjs`. The skill routes the agent to the canonical test plan, progress dashboard, handoff, and tooling guide without duplicating them.

Temporary scenario modules belong in `/tmp/soms-browser-e2e/steps/`. They normally disappear after a reboot or system cleanup and are never durable evidence. Reusable harness code belongs in `test/browser-e2e/`, while durable plans and results belong in `docs/development/`.

The npm command requires `pi` on `PATH`. Run `npm run test:browser:install` once to install the Chromium shared by this driver and all Playwright projects. See [browser testing architecture](../../docs/development/browser-testing.md) for target selection, regression commands, artifacts, and lifecycle boundaries.
