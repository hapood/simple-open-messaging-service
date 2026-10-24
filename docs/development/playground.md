# Standalone UI Playground

The playground renders the production home shell with in-memory conversation,
relationship, group, profile, message, and call providers. It does not start a
backend, authenticate a real user, or modify the federation lab. Reloading the
page resets social fixtures; closing and reopening a dialog preserves changes
within the same page session.

## Run in an isolated worktree

Use a separate worktree and a free port when another frontend is running. Install
dependencies there (or reuse matching dependencies without sharing build/cache
outputs), then run from that worktree:

```sh
npm --prefix web run start:playground -- --host 127.0.0.1 --port 4301
```

Open `http://127.0.0.1:4301/`. Build and Angular cache output stay in the worktree.
Do not run the federation lab startup/reset commands for playground validation.

## GitHub Pages verification

The [Pages workflow](../../.github/workflows/pages.yml) publishes the playground
after matching changes are pushed to `main`, or when manually dispatched. It
copies [the Google verification file](../../.github/pages/google81ab49229bacef40.html) unchanged
to the root of the Pages artifact so it is served at
`https://hapood.github.io/simple-open-messaging-service/google81ab49229bacef40.html`.
Keep this file and the workflow copy step after verification succeeds so future
deployments preserve Search Console ownership verification.

The workflow also publishes [the sitemap](../../.github/pages/sitemap.xml) at
`https://hapood.github.io/simple-open-messaging-service/sitemap.xml`. Submit this
URL in Search Console after deployment. It lists the playground homepage.
The homepage links to the GitHub repository, and the repository README links
back to the live playground.

Playground builds use a [dedicated HTML entry](../../web/src/playground/index.html)
with the Pages canonical URL and a static About SOMS disclosure containing the
project introduction, features, and repository link. This content remains outside
the Angular root in a dedicated project bar so it is available before and after
JavaScript runs, including when JavaScript is disabled. Self-hosted and native builds keep their existing
HTML entry without the Pages canonical URL or project disclosure.

The project bar reserves 56px above the demo and deployment studio. Its About
menu, repository link, and deployment action stay outside the chat interface;
all layout overrides are scoped to the playground HTML entry.

## Social fixtures

The signed-in mock user is `me`. All seeded identities belong to the mock local
namespace, displayed as `chat.example.test`.

- Existing friends: `alice` and `liam`.
- Incoming friend requests: `maya` and `noah`.
- Outgoing friend request: `zoe`.
- Exact search/add target: `emma` (a prefix such as `emm` does not match).
- Existing group: `!playground`, with Me as owner, Alice as admin, and Maya,
  Noah, and Olivia as members.
- Join applications to that group: `ivy` and `jack`.
- Liam is available to invite; Alice is already a member. Sending an invitation
  does not immediately add the recipient to the roster.
- Incoming group invitation: `!bookclub`.

Requests use decimal bigint IDs, seven-day online pages, immutable outgoing
snapshots, and exact-round decisions. Accepted/rejected/withdrawn records remain
in history. Reads advance the incoming request head without conflating unread
attention with actionable request count.

Group mutations update the roster, current role, profile, announcement, and
conversation projections. Ownership transfer leaves the previous owner as an
admin. Leaving/dissolving a group and deleting a friendship keep read-only
conversation history.

The transport is deliberately not a federation/server simulator. Address lookup
accepts seeded accounts and the mock `chat.example.test` domain; other domains
fail locally. The playground does not simulate remote convergence, durable tasks,
quota enforcement, session recovery, or a second user's acceptance of an outgoing
invitation. Unknown HTTP API calls fail locally with 501, rather than silently
reaching a real backend. Avatar staging and mounted-media status probes have
explicit local handlers.

Implementation: [social fixtures](../../web/src/playground/playground-social-state.ts),
[user requests](../../web/src/playground/playground-user.mock.ts),
[group operations](../../web/src/playground/playground-group.mock.ts), and
[provider wiring](../../web/src/playground/playground.config.ts).

## Regression commands

From the isolated worktree root:

```sh
npm --prefix web test -- --watch=false --include='src/playground/*.spec.ts'
npm run test:browser:install
npm run test:playground
npm --prefix web run build:playground
```

The playground project in the shared Playwright configuration starts and owns
its server on port 4301; it refuses to reuse an existing server. It uses fresh
browser contexts, no lab credentials, and no lab HMR status files. Tests assert
visible UI outcomes, absence of browser errors, and absence of outgoing API
requests. Failure artifacts are isolated per run under `test-results/browser-e2e/`.
See [browser testing architecture](browser-testing.md) for shared installation,
interactive Pi use, and build isolation.
