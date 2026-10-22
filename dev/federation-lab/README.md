# Three-node federation lab

This lab starts three independent development SOMS nodes on one machine. It intentionally bypasses
DNS/SRV and TLS through `SOMS_DEV_FEDERATION_ROUTES`; recognition, key pinning, HTTP signatures,
state/message feeds, media, and persistence remain real.

## Layout

| Node | Federation identity | Browser URL             | Backend origin          | Database               |
| ---- | ------------------- | ----------------------- | ----------------------- | ---------------------- |
| A    | `alpha.test`        | `http://localhost:3101` | `http://127.0.0.1:3201` | `soms_fed_lab_alpha`   |
| B    | `bravo.test`        | `http://localhost:3102` | `http://127.0.0.1:3202` | `soms_fed_lab_bravo`   |
| C    | `charlie.test`      | `http://localhost:3103` | `http://127.0.0.1:3203` | `soms_fed_lab_charlie` |

Each backend has its own database, `data/` directory, S2S root/signing keys, JWT secrets, logs,
uploads, and media CAS. All three use the PostgreSQL server and credentials from the repository
`.env` `DATABASE_URL`; only the database name is replaced.

In the default mode, the lab starts one shared Angular development server with unhashed in-memory
assets and one shared Vite development server. The dedicated `Caddyfile.hmr` forwards frontend HTTP
and HMR WebSocket traffic to those servers while routing API/uploads to the edge's own backend node.
Built mode uses `Caddyfile.built` to serve static outputs. Both backend ports `3201`–`3203` and
browser-facing ports `3101`–`3103` bind to `0.0.0.0`, so another device on the LAN can use
`http://<development-machine-ip>:3101` (and the corresponding other ports).

## Run

Install Caddy plus the repository, web, and admin dependencies first, and configure a reachable
PostgreSQL `DATABASE_URL` in the repository `.env`. The configured PostgreSQL user must be able to
create the three lab databases.

For database-native deadlock diagnostics, enable PostgreSQL's logging collector and lock-wait
logging. A suitable development configuration is:

```conf
logging_collector = on
log_destination = 'stderr'
log_directory = 'log'
log_filename = 'postgresql-%a.log'
log_rotation_age = '1d'
log_rotation_size = 0
log_truncate_on_rotation = on
log_line_prefix = '%m [%p] xid=%x db=%d user=%u app=%a client=%r '
log_lock_waits = on
log_min_error_statement = error
log_error_verbosity = verbose
```

`logging_collector` requires a PostgreSQL restart. Superusers can enumerate and read the resulting
files through `pg_ls_logdir()` and `pg_read_file()`, which also works when the database data directory
is inside a container or VM that does not share the application's filesystem.

Build and run the backend and frontend independently in separate terminals:

```bash
# Terminal 1
npm run build:be
npm run dev:be
```

```bash
# Terminal 2: frontend HMR
npm run dev:fe
```

The backend command starts three Node processes from existing build outputs without
building automatically. `dev:fe` starts Angular/Vite with HMR through Caddy without
connecting to PostgreSQL. To serve static assets, run `npm run build:fe`, then
`npm run dev:fe:built`. Browse through the `310x`
edge URLs so each session reaches the intended backend node.

Use `Ctrl+C` in each terminal to stop its child processes. Shutdown stops new durable-task dispatch and waits
for in-flight executions before unregistering handlers. Unstarted durable work remains available
for startup recovery. The launcher waits up to 60 seconds, exits as soon as all children finish,
and logs a warning and exits nonzero if it must force remaining children to stop. Interrupting during
startup takes effect immediately instead of waiting for readiness checks to time out, and a second
`Ctrl+C` force-kills the remaining children and exits at once.

Starting the backend creates any missing lab databases and applies pending migrations.
Existing database records are preserved across restarts. Credentials and node identity files
persist under `dev/federation-lab/local/<node>/`; mutable data and workload reports live under
`dev/federation-lab/runtime/`. To clear lab data, stop the lab
and explicitly run `npm run dev:reset` before starting it again.

## Federation consistency test

The maintained runner is [p2p/run.mjs](p2p/run.mjs). Its API actors, workload selection,
snapshot readers, final audit, and unit tests live together in `p2p/`.
Stop existing lab backends and run from the repository root:

```bash
npm run build:be
npm run federation:test
```

`federation:test` allows one session at a time: startup purges all leftover artifacts from previous
diagnostic sessions — every `soms_fed_diag_*` database and the whole diagnostic output directory —
without touching the interactive dev lab, then creates fresh per-session databases and starts the built
backends with process and database diagnostics, runs the workload, and stops the owned
processes. Each backend uses a single database connection (`DATABASE_POOL_MAX=1`)
to expose transaction code that incorrectly requests another pool connection while
holding its current one. This is a correctness workload, not a throughput benchmark.
All workload settings are explicit in the `package.json` script: 600 random
decisions, five users and groups per node, 10 admissions per
second, concurrency 12, round size 10, task timeout 120000 ms, progress every 25 decisions,
and convergence timeout/interval/samples of 300000 ms / 1000 ms / 3. The account prefix
is `p2p`; fresh per-session databases keep it reusable.

The script uses `--seed=random`. The launcher resolves and records the actual integer
seed in `session.json`, and the workload records it in its artifacts. Replay selection
randomness with `npm run federation:test -- --seed=1894910172`; asynchronous timing may
still change the observed workload. Edit the package script to change workload settings.

The prefix must start with a lowercase letter and contain at most 10 lowercase letters,
digits, or hyphens. A new prefix avoids account collisions; a fresh lab remains the acceptance
baseline because retained data and background work can affect timing.

The federation consistency workload attaches to these same running backends. Its administrator and user
actors live only in the workload process, while every account and session is created through the real
HTTP API and persists in the lab databases. A workload does not stop or reset the lab when it exits,
so its final state remains available through the three browser URLs for manual inspection.

The runner provisions and OTP-authenticates 5 users on each node and creates 5 groups per node.
The seed selects two distinct users and reserves one group for each as an active group. All other
groups remain ordinary groups. Activity belongs to the group, so a new owner inherits its behavior
after an ownership transfer.

The selector samples a three-user/three-group window, weights active groups more heavily, and retains
a stateful group when possible. Group candidates are weighted by attraction, pending management work,
and whether the user previously left that active group. Active owners and administrators favor
accepting applications. Active members rarely leave; a pending applicant usually waits instead of
immediately revoking the request. A retained roster MEMBER_UPSERT alone never grants membership: the user's
relationship must also be active, with only the local owner's missing-pair fallback allowed.

Group messages include text, quotes, direct forwards, history forwards, files, and galleries.
Established P2P friends usually send text or media and occasionally withdraw a message or remove the
relationship. Re-established friendships retain their prior messages in the consistency comparison.
The baseline admits at most one ordinary operation per group or P2P pair in a round.

After half the random-operation budget has been submitted, the runner selects one active group and asks its
current owner to dissolve it. The other active group survives until the end. Clients that observe
dissolution stop selecting group actions; discovery returning NOT_FOUND or an explicit GROUP_DISSOLVED
result is recorded as observed unavailability, not an unexplained admission failure. Other failures,
including an unexpected permission rejection or transport ambiguity, still fail the run.

Once an active group has members on different nodes, a bounded scenario sends one original, creates
a remote quote plus DIRECT and HISTORY forwards, and withdraws the original after each step converges.
It verifies public message reads and the forward bundle afterward. The scenario also repeats identical
requests concurrently and after success using the same idempotency key. Ordinary eligible sends may
also be retried. Attempts remain one logical operation. Scenario operations are additional to the
random-operation budget. Failure to reach the scenario's membership preconditions is reported as
missing coverage.

Before random admissions, three mandatory relay cases use four dedicated accounts across all three
nodes: B sends two originals to A, A combines them with its own message and forwards back to B,
then B relays the bundle to C using DIRECT, HISTORY, or additional B-to-A-to-B HISTORY nesting.
These cases run on every workload invocation and do not consume `--operations`.
Each case uses a fresh avatar, verifies that C has neither its CAS row nor file before delivery,
changes B's profile after capture, and checks the complete original author/profile/content snapshot,
descendant closure, deduplicated asset descriptors, local files, and authenticated download bytes.
C never resolves A's profile. Digest-only requests, an unrelated message coordinate, an unrelated
authenticated account, and anonymous requests must all fail to download the existing snapshot avatar.
Evidence and the dedicated operation journal are stored under `forwardRelayScenario` in
`operations.json` and `forwardRelay` in `coverage.json`; any case failure fails execution.

Admissions are globally paced at 10 operation starts per second by default, with slow requests allowed
to overlap. Random batches do not wait for the durable queue to drain or invoke the global convergence
oracle. They observe current state and completed task outcomes only to select later operations; these
observations are not intermediate assertions. Random relationship decisions use only the acting node's
Pair and Intent view.

An outgoing pending request can be cancelled by its sender; it does not schedule an accept/reject on
the remote recipient. Accept/reject submits immediately, without waiting for an incoming request to
reappear. Expected races retain their original result codes, while admission failures, execution
failures (`FAILED`), and unfinished tasks fail the run. Fixed scenarios retain narrow prerequisite waits
when a quote, forward, or withdrawal cannot be submitted until its target is visible; these waits do not
invoke the global convergence oracle.

After all operations, the harness drains all three durable-task queues, including child fanout work.
Task-level business rejections (`REJECTED`) remain in the report but do not prevent the final consistency
audit. The single final audit waits for stable convergence and checks coverage, profiles, seq/originSeq,
message content, tombstones, and actual media digests and lengths. Intermediate states that later
operations overwrite are intentionally not asserted. Midpoint dissolution is submitted without a queue
barrier; the final profile audit remains mandatory.

The default random batch size is 10 (capped by the available pair count), with a
shared admission pacer limiting submission starts to 10 operations per second
across batches. With full batches, round 50 means 500 random operations submitted;
fixed scenarios do not increment the random round number. Progress is printed after
submission, not with the previous round's count. State reads, slow API calls, and
fixed-scenario prerequisites can lower actual throughput; the pacer does not burst
to catch up after a pause. A final partial batch or insufficient eligible operations
can contain fewer than 10 operations.

FILE, IMAGE, VIDEO, AUDIO, and GALLERY carrier URLs are checked against each
node's local thread/sequence before cross-node comparison uses their portable
CAS paths. Metadata, item order, asset digests, and byte lengths remain exact checks.

`ADMIN_BOOTSTRAP_PASSWORD` must match the bootstrap administrator used by the running lab. The runner
temporarily changes the OTP login rate-limit policy and request-quota defaults through the admin API,
restores the previous configuration before exiting, and writes token-free reports below
`dev/federation-lab/runtime/p2p-runs/`. The journal contains no credentials, OTPs, cookies, or session
tokens. After operations stop, the final auditor repeatedly reads all three databases. It compares P2P
active pairs and directed intents, and current group rosters and roles. For each surviving group, it
assembles the original-message set from the home databases of CURRENT active roster members, then
compares that set with the authority and all current member peers. Historical authors and former
member peers are excluded from message equality. Dissolved groups have terminal membership checks
but no current-member message equality requirement. For active P2P pairs, both authors' original
messages are compared on both endpoint nodes, including messages predating removal and re-addition.
Selected messages must have positive integer coordinates, unique local seq within the owning thread,
and seq at or below curSeq. Message identity is the author address and the author's immutable local seq.
For a remote group submission, the authority's originSeq identifies that author-local seq, while the
author's confirmed originSeq and other mirrors' originSeq identify the authority's seq. The auditor
checks both directions and the source namespace; it does not require equal originSeq across all copies.
A submission withdrawn before confirmation may retain its provisional coordinate because the message
feed no longer returns its body. P2P author coordinates remain local. Selected-author seq
values need not be contiguous because system messages and historical authors occupy other slots.
Retained deleted messages must agree with the author and have local tombstones. A missing withdrawn
body is accepted only with a deletion fact at the group authority (or P2P author), completed receiver
history scanning with no gaps, caught-up message/deletion positions, and no pending deletion recovery.
This does not exempt an undeleted retained copy after friendship reauthorization. Live message sets
remain strict. Quote targets are compared by author address and immutable author-local seq: an unresolved local quote
uses its publisher namespace and sourceSeq to resolve the target in the publisher's database, rather
than requiring a local row for a previously withdrawn target. Audit snapshots include source namespaces,
sync state, history gaps, and pending tombstones. FILE/GALLERY assets require
live MediaAsset bindings and actual CAS bytes matching the submitted SHA-256 digest and size; retained
transfer-task rows are not required after completed batches have been cleaned up. The complete
oracle also resolves every positive profile reference through the same authorization-scoped client
API used by the UI. Before issuing profile requests, the harness opens an authenticated SSE stream
per viewer. A `PENDING` response is completed by a `PROFILE_AVAILABLE` wake followed by another
database-backed resolution request; `PROFILE_UNAVAILABLE` reports the returned profile key and reason.
Streams are closed when profile checks finish or fail.
It compares the exact revision's name and biography, requires every referenced
avatar file to exist and compares its exact SHA-256 digest. Accepted avatars are stored and federated
byte-for-byte, so any transformation or corruption is a consistency failure. Current P2P
display falls back to its effective relationship reference when there is no later message; group
member display selects the latest member-authored message reference and otherwise the current roster
reference; the group thread profile follows the latest Group Meta group-profile reference. The oracle
must pass for the configured number of consecutive samples. Console output includes
provisioning, per-round selections, admission throughput, active task IDs, convergence samples, audit
differences, the random seed, and artifact paths.
Three concurrent read workers each own a database connection and a REPEATABLE READ, READ ONLY
transaction, giving one internally consistent snapshot per node. These are not a global snapshot;
repeated convergence samples remain necessary. Successful command effects are checked after a round
converges, before subsequent commands can supersede them.

The runner writes append-only operation transitions to operations.jsonl, an atomic operations.json
snapshot, coverage.json, and detailed execution-failure.json snapshots on Oracle failures. Coverage
includes membership re-entry, re-established friendships, operation types, and fixed-scenario results.
To recheck a failed run without creating accounts or changing state:

```bash
node dev/federation-lab/p2p/audit-run.mjs path/to/operations.json
```

This diagnostic does not exercise lazy profile APIs or claim complete workload coverage.
The default baseline uses three nodes with 5 users and 5 groups each. `federation:test`
builds fresh databases before each workload and stops its backends afterward. Workload artifacts
remain available until the next `federation:test` starts (its startup purge removes them);
preserve a failed run before starting another. Smaller diagnostic runs may be used while developing the harness, but do
not replace the 3-by-5-user/5-group acceptance run.

### Logs and timing diagnostics

Backend business/access logs are separate from the workload's `[p2p]` progress output.
Every runner progress/error line is also appended with a UTC timestamp to
`runtime/p2p-runs/<run-id>/progress.jsonl`, including drain timings, convergence samples,
and terminal errors. This file is written independently of the backend log level and remains
available when the workload fails. Existing runs cannot recover terminal output that was not saved.

The backend launcher defaults to `FED_LAB_LOG_LEVEL=debug`, disables per-statement SQL logs, and
measures every annotated business operation and durable-task execution. This keeps development
output focused on `execution_measurement` summaries rather than SQL text. Set
`DATABASE_QUERY_LOG=1` for focused SQL debugging, or
`EXECUTION_MEASUREMENT_SAMPLE_RATE=0` to benchmark without measurement. These values are captured
when the backend starts; changing them requires restarting the backend processes.

Each node writes JSON records to `runtime/<node>/data/logs/soms.log` and rotated files in the
same directory. To follow all three current files from the repository root:

```bash
tail -F dev/federation-lab/runtime/{alpha,bravo,charlie}/data/logs/soms.log
```

Correlate backend timestamps, request IDs, and durable task IDs with
`runtime/p2p-runs/<run-id>/operations.jsonl` and `operations.json`. The operation journal records
admission and terminal outcomes; the interval from `admittedAt` to `finishedAt` includes queueing
and execution and is not the time spent by the runner waiting for global idleness.

A drain barrier requires two consecutive samples with no pending, processing, or asynchronously
processing tasks on any node. Each sample concurrently issues four status requests per node
(twelve requests for the default topology), including a check for failed tasks, then waits 500 milliseconds before the next sample.
The final idle sample returns without another sleep. Drain progress includes:

| Field                          | Meaning                                                             |
| ------------------------------ | ------------------------------------------------------------------- |
| `elapsed`                      | Total wall-clock time since this barrier began.                     |
| `sample`, `idleSamples`        | Sample number and consecutive idle samples out of two required.     |
| `sampleMs`                     | Wall-clock time for the current sample across all nodes.            |
| Per-node `queryMs`             | Wall-clock time for that node's concurrent status requests.         |
| Per-node `statusMs`            | Individual `PENDING`, `PROCESSING`, and `FAILED` request durations. |
| `queryTotalMs`, `sleepTotalMs` | Cumulative sample time and actual polling sleep time.               |

Concurrent request durations must not be added to estimate elapsed time. Request measurements
include response decoding and any administrator session renewal/retry; they do not isolate SQL
execution. Use backend request logs and database diagnostics for that distinction. State changes,
slow samples, periodic progress, and the second idle sample produce drain logs. Two empty-queue
lines alone do not mean the dissolution itself took the entire reported interval.

### Diagnose a workload with one command

Stop existing lab backends first, then run from the repository root:

```bash
npm run federation:test
```

Build the backend first with `npm run build:be`. The command checks build outputs,
purges leftover diagnostic artifacts from previous sessions, starts three instrumented backends on
freshly allocated ports with their own `soms_fed_diag_*` databases and the database
collector, waits for readiness, and runs the instrumented workload. Workload parameters
are defined in `package.json`, with a random seed resolved separately on every invocation.
To reuse a recorded seed:

```bash
npm run federation:test -- --seed=2874283404
```

The command stops its own backends and collector after success, failure, or Ctrl+C. It never stops or
touches an existing dev lab: every session uses its own ports and databases, so federation:test can
run while the lab is up. A kernel-held session lock allows only one federation:test at a time;
starting a second one fails immediately with instructions.
A missing build output or a failed collector, backend, or workload makes the command fail. Graceful shutdown can take
up to 65 seconds. This launcher uses POSIX process groups and is intended for the Linux lab.

Backend warnings, errors, and fatal records are mirrored to the terminal in real time,
including multiline details. Child stderr is also forwarded so startup failures and
collector errors remain visible. Complete stdout/stderr logs are still saved, and workload
progress continues to print normally.

All diagnostic files go into the printed `dev/federation-lab/diagnostic-runs/<timestamp>/` directory:
`backend.log`, `collector.log`, `workload.log`, `session.json`, and the process/database
JSONL samples. This directory survives `dev:reset`; each new `federation:test` startup purges it
together with every leftover `soms_fed_diag_*` database. The usual workload reports and `progress.jsonl`
still live under `runtime/p2p-runs/` and must be preserved before resetting. Set `SOMS_DIAGNOSTICS_DIR`
only when a custom output directory is needed.

The [database collector](diagnostics/collect.mjs) samples sessions, blockers, and operating-system
pressure. Each database session includes its PostgreSQL backend PID, blocking PIDs, and
`pg_stat_activity.query`: the current statement for an active session, or the last statement
for an idle transaction. PostgreSQL may truncate this text according to
`track_activity_query_size`. The collector does not collect bound parameter values, but
SQL literals can appear in the statement text; treat these local diagnostic files accordingly.
The [process preload](diagnostics/preload.mjs) records HTTP durations, event-loop delay,
CPU usage, and pool acquisition waits for the backends and workload. The unified command enables both;
there is no need to launch them separately. Backend business/access logging defaults to `info`.
Database activity is sampled once per second, so absence of a sampled lock wait does not prove
that no brief contention occurred. HTTP timings measure requests, not task execution time.

### Verify changes to the runner

```bash
node --test dev/federation-lab/p2p/*.spec.mjs
npm run test:e2e -- test/federation-lab-snapshot.e2e-spec.ts
```

The PostgreSQL regression test stays under `test/` to use the repository's isolated, migrated
E2E databases. It exercises the lab readers against the account/profile schema, including local
and mirrored groups, addressed members, request projections, and publisher-scoped profiles.
Runner queries must evolve with the schema: groups use `MessageThread` plus `GroupAccount` and
`Profile`; foreign members are addressed references, not local account rows.

## Group-join latency probe

[group-join-latency.mjs](group-join-latency.mjs) measures one scenario against two running lab
nodes: a user on the applicant node applies to a group owned on the owner node, the owner accepts
through `POST /group/join-request/accept`, and the probe reports, per node, when the accept
admission returns, when its durable task finishes, when the SSE wake-ups
(`THREAD_FEED_UPDATED` / `STATE_FEED_UPDATED`) arrive, and when the `GROUP_JOINED` system message
(with the local thread id) is served. Both participants hold a live `GET /api/v1/events` stream and
pull the feeds exactly like the shipped clients — only on a wake-up, never by polling.

```bash
npm run dev:be  # in another terminal; the probe attaches to the running backends
node dev/federation-lab/group-join-latency.mjs [--prefix=join] [--applicant=alpha]
    [--owner=bravo] [--window-timeout-ms=30000] [--poll-interval-ms=50]
```

The window is measured from the accept call. JSON artifacts (timeline, SSE frames, per-node
durable tasks, token-free) are written below `runtime/join-latency/`. Like the workload, the run
leaves its accounts and group behind; `npm run dev:reset` clears them. When the applicant node
serves the mirrored membership but no join notice within the window, the probe reports the gap as
a note instead of failing, because the member-authored federated application path does not write a
local `GROUP_JOINED` notice on the applicant's home node.

## Built assets and reset

To test prebuilt assets rather than frontend development servers, run:

```bash
npm run build:development
# Start in separate terminals:
npm run dev:be
npm run dev:fe:built
```

This builds the backend and both frontends with development source maps, packages the client update
bundle. The separate runtime commands serve the same three-node topology with `web/dist/web/browser` and `admin-web/dist`.
These assets retain content hashes. Use `npm run build:production` separately when validating
optimized, source-map-free deployment artifacts.

To start over, stop the lab and run:

```bash
npm run dev:reset
```

Reset permanently drops only the three explicitly named `soms_fed_lab_*` databases and removes the
lab runtime directory, including uploaded files and workload reports. It preserves `local/`,
including node identities and credentials. Both startup and reset copy any legacy credential files
from `runtime/<node>/data/` into `local/<node>/` only when the destination is absent. Existing local
files are never overwritten, and legacy copies remain until runtime is reset. The next backend
start creates fresh databases and applies migrations.

For a complete identity reset, stop the lab, run `npm run dev:reset`, then remove `local/` explicitly.
This is also required for old `*.local` identities: persisted federation identities cannot be renamed
in place.

## Browser sessions

Cookie scope does not include a port. Since this zero-DNS setup exposes all sites as `localhost`, use
three separate browser profiles (or separate browsers) for A, B, and C. Otherwise logging into one
port can replace the session cookie used by another port.

The admin console for each node is:

- `http://localhost:3101/admin/`
- `http://localhost:3102/admin/`
- `http://localhost:3103/admin/`

`ADMIN_BOOTSTRAP_PASSWORD` and other ordinary application settings are inherited from the repository
`.env`. The lab always overrides `NODE_ENV`, domain, database, ports, data paths, and development peer
routes. Deployment-only domain, WebAuthn, and direct-TLS values are removed only from the child
process environments; the repository `.env`, invoking shell, and system environment are not changed.

Never expose these ports outside a trusted development machine. The application itself also rejects
the insecure transport and static routing variables whenever `NODE_ENV=production`.

## Persistent local configuration

The Git-ignored `dev/federation-lab/local/alpha/`, `local/bravo/`, and `local/charlie/` directories
hold each node's `vapid-key.json`, `jwt-admin.key`, `password-pepper.key`, `2fa.key`,
`soms-s2s-key.json`, and optional `google-services.json` and `firebase-service-account.json`.
The backend reads these files directly through `SOMS_CONFIG_DIR`; missing application-owned keys
are generated there on first boot. Each node retains independent credentials. Root `data/` files
are never imported. Place optional Firebase files in the relevant node directory before startup.

Environment variables continue to come from the repository `.env`; per-node `.env` files are not
loaded. `SOMS_DATA_DIR` continues to point to runtime data, while `SOMS_CONFIG_DIR` points to local
configuration. Outside the lab, an unset `SOMS_CONFIG_DIR` defaults to `SOMS_DATA_DIR` (or `./data`).
Back up both directories when they are configured separately.
