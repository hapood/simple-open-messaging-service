# Three-node manual federation lab

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

The normal development entry point builds the backend, starts both frontend development servers with
HMR, and starts the lab:

```bash
npm run dev
```

This mode uses unhashed frontend module names and source maps. The shared dev servers are
implementation details; browse through the `310x` edge URLs so each session reaches the intended
backend node.

For independent restarts, run the process groups in separate terminals:

```bash
npm run dev:be
npm run dev:fe
```

The backend command builds before starting all three Node processes. The frontend command starts
Angular, Vite, and Caddy without connecting to PostgreSQL.

Use `Ctrl+C` to stop all six child processes. Starting the backend recreates all three lab databases
before applying migrations. Node identity files and workload reports persist under
`dev/federation-lab/runtime/`, while database records always start empty.

The federation consistency workload attaches to these same running backends. Its administrator and user
actors live only in the workload process, while every account and session is created through the real
HTTP API and persists in the lab databases. A workload does not stop or reset the lab when it exits,
so its final state remains available through the three browser URLs for manual inspection.

The runner provisions and OTP-authenticates 5 users on each node. Half of the seeded users receive
an initial biography and avatar. It then makes 5 seeded owner selections per node and creates 5
groups there, half with an initial description and avatar. Each round samples 3 ordinary users and 3
groups, restricting user-to-group selection to that 3×3 state window. When those users already have
membership, intent, or manager-request state with a group, one randomly ordered stateful group is
retained in the window and the remaining group slots stay uniformly random. At most one operation per
group uses a round snapshot. Each online decision first gives a unary user-or-group profile update 5%
probability. Otherwise the binary selector always picks a user first, then gives user and group targets
equal weight. Stateful combinations in the window are considered before untouched combinations, while
the final action is still selected only from the operations legal in the observed facts. A P2P direction retains the existing friend
request/accept/reject/revoke state machine. A user-to-group direction derives its legal actions from a
fresh database snapshot of the roster, both relationship intents, manager request projections,
friendships, and authored messages.

An active group member enters the message branch with 90% probability. That branch withdraws one of
the actor's live authored workload messages with 5% probability (or sends when none exists); 5% of new
sends are FILE or two-part GALLERY messages. The remaining 10% chooses uniformly among the membership
and role operations the actor may actually perform. Non-members use invitation/application actions.
The owner never leaves directly and the workload never dissolves a group. At most one operation for a
given group is admitted in one round, so roster-dependent decisions from the same snapshot cannot
invalidate each other inside that round.

Admissions are globally paced at 10 operation starts per second by default, with slow requests allowed
to overlap. The runner polls the administrator task list for `PENDING`, `PROCESSING`, and
`ASYNC_PROCESSING` activity. After the round barrier is idle, it polls the incremental Oracle until
the round's federated state converges before observing the next state:

```bash
npm run federation:p2p
# Equivalent, clearer name for the expanded workload:
npm run federation:consistency
```

`ADMIN_BOOTSTRAP_PASSWORD` must match the bootstrap administrator used by the running lab. The runner
temporarily changes the OTP login rate-limit policy and request-quota defaults through the admin API,
restores the previous configuration before exiting, and writes token-free reports below
`dev/federation-lab/runtime/p2p-runs/`. The journal contains no credentials, OTPs, cookies, or session
tokens. After operations stop, the final auditor repeatedly reads all three databases. It compares P2P
active pairs and directed intents, group directed intents and every materialized roster, and all
non-system workload messages on nodes that host final roster members. Every live message must have
integer `seq` and `originSeq`, identical content, and no unexplained sequence gap. Withdrawn messages
must have a tombstone and are the only permitted gaps. FILE/GALLERY assets must have successful
transfer state, a live `MediaAsset`, and a physical CAS shard on every compared node. The complete
oracle also resolves every positive profile reference through the same authorization-scoped client
API used by the UI. It compares the exact revision's name and biography, requires every referenced
avatar file to exist and compares its exact SHA-256 digest. Accepted avatars are stored and federated
byte-for-byte, so any transformation or corruption is a consistency failure. Current P2P
display falls back to its effective relationship reference when there is no later message; group
member display selects the latest member-authored message reference and otherwise the current roster
reference; the group thread profile follows the latest Group Meta group-profile reference. The oracle
must pass for the configured number of consecutive samples. Console output includes
provisioning, per-round selections, admission throughput, active task IDs, convergence samples, audit
differences, the random seed, and artifact paths.
Add `--verbose` to print every successful operation.
The default baseline uses three nodes with 5 users and 5 groups each. It does not stop the lab or remove its
data. Run it against a fresh lab; repeating the same account prefix correctly fails with an
already-existing account. Smaller diagnostic runs may be used while developing the harness, but do
not replace the 3-by-5-user/5-group acceptance run.

To test prebuilt assets rather than frontend development servers, run:

```bash
npm run dev:built
```

This builds the backend and both frontends with development source maps, packages the client update
bundle, then runs the same three-node topology with `web/dist/web/browser` and `admin-web/dist`.
These assets retain content hashes. Use `npm run build:production` separately when validating
optimized, source-map-free deployment artifacts.

To start over, stop the lab and run:

```bash
npm run dev:reset
```

Reset permanently drops only the three explicitly named `soms_fed_lab_*` databases and removes the
lab runtime directory.

If the runtime was created by a version of the lab that used `*.local` identities, reset it before
starting this version. Federation identities are persisted and cannot be renamed in place.

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
