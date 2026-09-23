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

The command intentionally does not include plan-mode or subagent extensions. The canonical project plan, progress dashboard, and handoff already define the work, while the persistent driver and retained fixtures are shared mutable resources that need one coordinator. The agent selects a bounded batch before acting and then executes it in the same session.

The extension exposes one compact `browser_driver` tool backed by `test/browser-e2e/driver.mjs`. The skill routes the agent to the canonical test plan, progress dashboard, handoff, and tooling guide without duplicating them.

Temporary scenario modules belong in `/tmp/soms-browser-e2e/steps/`. They normally disappear after a reboot or system cleanup and are never durable evidence. Reusable harness code belongs in `test/browser-e2e/`, while durable plans and results belong in `docs/development/`.

The npm command requires the `pi` executable to be available on `PATH`. Browser dependencies and the deterministic Playwright suite are managed by the repository's existing dependencies and `npm run test:browser` command.
