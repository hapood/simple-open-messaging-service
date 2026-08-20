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

The lab reads the existing backend, Angular, and admin build outputs. The two frontend applications
are served by three lightweight local edges without being rebuilt when the lab starts. Each edge
serves the web SPA at `/`, the admin SPA at `/admin/`, and proxies API/uploads to its node. Both
backend ports `3201`–`3203` and browser-facing ports `3101`–`3103` bind to `0.0.0.0`, so another device
on the LAN can use `http://<development-machine-ip>:3101` (and the corresponding other ports).

## Run

Install the repository, web, and admin dependencies first, and configure a reachable PostgreSQL
`DATABASE_URL` in the repository `.env`. The configured PostgreSQL user must be able to create the
three lab databases.

```bash
npm run build
npm run build --prefix web
npm run build --prefix admin-web
npm run federation:lab
```

Use `Ctrl+C` to stop all six child processes. Data persists under
`dev/federation-lab/runtime/<node>/`; starting again reuses identities and databases.

For frontend debugging, build either frontend independently with source maps and without
optimization/minification, then restart the lab:

```bash
npm run build:debug --prefix web
npm run build:debug --prefix admin-web
npm run federation:lab
```

Only rebuild the application whose source changed. The lab runs `dist/src/main.js`, serves
`web/dist/web/browser`, and serves `admin-web/dist`; it does not run any build command itself.

To start over, stop the lab and run:

```bash
npm run federation:lab:reset
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
