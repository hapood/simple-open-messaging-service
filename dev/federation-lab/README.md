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
create the three lab databases. The normal development entry point builds the backend, starts both
frontend development servers with HMR, and starts the lab:

```bash
npm run dev
```

This mode uses unhashed frontend module names and source maps. The shared dev servers are
implementation details; browse through the `310x` edge URLs so each session reaches the intended
backend node.

For independent restarts, run the process groups in separate terminals:

```bash
npm run dev:backend
npm run dev:frontend
```

The backend command builds before starting all three Node processes. The frontend command starts
Angular, Vite, and Caddy without connecting to PostgreSQL.

Use `Ctrl+C` to stop all six child processes. Data persists under
`dev/federation-lab/runtime/<node>/`; starting again reuses identities and databases.

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
