# NAS Deployment

> [!NOTE]
> This deployment profile and guide are currently in progress / under development. Public container images are not published yet. To run SOMS, build the Docker image locally from source as described in the [image build guide](../development/building-the-image.md).

This guide covers deployment on a NAS or another host inside a home LAN. Administrator
routes accept private-range clients only, while the web client and federation endpoint can be made
reachable from the internet through the configured public hostname and port.

The internet-facing server profile under [`deploy/public`](../../deploy/public/) is available for
development, but its deployment guide is still being written and is not part of the initial
published deployment documentation.

The NAS Docker Compose example runs PostgreSQL, applies database migrations, and starts the full SOMS
image containing the application and its Caddy TLS edge.

The example is a single-file launch template: all operator configuration lives in
`docker-compose.yml`. No `.env`, external Caddyfile, or `.conf` file is required; the image generates
its internal Caddyfile from the container environment. Copy the template to an operator-owned
directory so credentials, generated state, Firebase files, and backups remain outside the Git checkout.

The NAS profile publishes one HTTPS/federation port, normally `7667`, and obtains a trusted DNS-01
certificate. It can advertise a second real LAN hostname for networks without hairpin NAT; it does
not use a self-signed certificate.

## Requirements

- Docker Engine with Docker Compose v2
- A registered domain whose DNS zone you control; a normal registrable domain is sufficient
- A DNS-01 provider credential; Cloudflare is the default example
- A publicly reachable deployment host: devices outside the home network must be able to connect to
  the NAS through a public IP address and TCP `7667`; UDP `7667` additionally enables HTTP/3

The NAS does not need to own the public IP address directly. Public reachability can come from a
public IPv4 address with router port forwarding or from a publicly reachable IPv6 address with the
corresponding firewall rule. If the NAS is behind carrier-grade NAT (CGNAT) and has no reachable
IPv6 address, it does not meet this guide's network prerequisite because ordinary router port
forwarding cannot expose it.

Verify this prerequisite from outside the home network. Publishing a port in Docker Compose only
binds it on the NAS; it does not create router port forwarding, open an upstream firewall, or bypass
CGNAT.

## 1. The Image

The Compose file references the published registry image, pinned to an exact version:

```yaml
    image: ghcr.io/hapood/simple-open-messaging-service:v0.1.0-alpha.0
```

`docker compose up -d` pulls it automatically; `docker compose pull` fetches it ahead of time.
Versions track the repository's release tags (`v<version>`). The `migrate` and `app` services pin
the same version — set both lines together before the first start and on every update.

> **Not published yet.** No release tag exists so far, so the registry image is not available.
> Until the first release, build the image locally — see
> [Building the Docker image](../development/building-the-image.md) — and substitute your local
tag (for example `soms:latest`) in both `image:` lines.

## 2. Copy the NAS Example

```bash
sudo install -d -m 0750 -o "$(id -u)" -g "$(id -g)" /opt/soms
install -m 0600 deploy/nas/docker-compose.yml /opt/soms/docker-compose.yml
cd /opt/soms
sudo install -d -m 0750 -o 1000 -g 1000 data
```

The deployment directory will contain the private `docker-compose.yml` and a generated `data/`
directory. PostgreSQL uses the Compose-managed `postgres-data` volume. The app runs as UID/GID `1000:1000`; its bind-mounted
`data/` directory must be writable by that identity. Otherwise Docker can create a root-owned
directory on first start and the app cannot write keys or Caddy state. For rootless Docker or user
namespace remapping, use the corresponding mapped host ownership.

## 3. Configure `docker-compose.yml`

Edit the copied YAML, not the repository template. Set these values before the first start:

| Variable                   | Purpose                                                                                                     |
| -------------------------- | ----------------------------------------------------------------------------------------------------------- |
| `SOMS_DOMAIN`              | Federation identity used in handles such as `@alice@example.com`                                            |
| `SOMS_WEB_DOMAIN`          | Browser and native-client entry hostname; it may equal `SOMS_DOMAIN`                                        |
| `PGPASSWORD`               | Database password on the `x-database-environment` anchor line, shared by PostgreSQL, migrations, and the app; the shipped placeholder makes an unedited file refuse to start |
| `ADMIN_BOOTSTRAP_PASSWORD` | Creates the bootstrap `admin` account/role when it is absent; does not reset an existing password           |
| `CLOUDFLARE_API_TOKEN`     | Default DNS-01 credential with `Zone:Zone:Read` and `Zone:DNS:Edit` permissions for the managed zone        |

The Cloudflare permissions match the [Caddy Cloudflare provider requirements](https://github.com/caddy-dns/cloudflare#configuration).
Use lowercase hostnames without a scheme, port, or path for the domain fields. `SOMS_WEB_DOMAIN`
defaults to `SOMS_DOMAIN` when omitted; `SOMS_LAN_DOMAIN` is optional and can be removed when a
separate LAN entry is unnecessary. Application and DNS-provider settings belong under
`services.app.environment`, where both the startup renderer and Caddy can read them.

Database settings live under `x-database-environment`. YAML anchors reuse the database name, user,
and password for all three services; set each value only once. PostgreSQL receives them as
`POSTGRES_DB`, `POSTGRES_USER`, and `POSTGRES_PASSWORD`, while migrations and the app receive the
corresponding `PG*` variables. The template's `PGPASSWORD` line carries a required-variable
placeholder, so an unedited file refuses to start with a clear Compose error instead of
initializing a passwordless database: replace the line with the literal password (the recommended
form — the file stays the single source of truth) or export `SOMS_DB_PASSWORD` before
`docker compose`. An ambient `PGPASSWORD` from the host shell is deliberately not read.

Generate unique database and administrator passwords. Changing `PGPASSWORD` after PostgreSQL has
initialized its volume does not rotate the database role; changing only the YAML instead makes the
app and migration credentials disagree with PostgreSQL. Rotate the role password and update the
deployment configuration together. Treat the YAML as a secret: keep mode 0600 and do not commit or
share an operator-configured copy.

Quote string values. Compose interpolates dollar signs even inside single-quoted YAML strings:
write `$$` for each literal `$` in a password or token. For example, `'prefix$$suffix'` passes
`prefix$suffix` to the container. Native Caddy placeholders such as `{env.CLOUDFLARE_API_TOKEN}`
need no escaping. No shell environment variables or `.env` file are needed by this template.

The relevant app environment entries look like this:

```yaml
SOMS_DOMAIN: example.com
SOMS_WEB_DOMAIN: soms.example.com
SOMS_LAN_DOMAIN: soms-lan.example.com
SOMS_TLS_MODE: single-port
SOMS_ADMIN_ACCESS: lan
```

Keep `SOMS_TLS_MODE: single-port` and both published ports at `7667` for this profile. The
[client-origin code](../../src/common/origin.ts) advertises port 7667 for the native shell and
WebAuthn. Changing Docker's host mapping alone is not a supported custom-port deployment.
`standard` mode also needs published ports 80/443, which this NAS Compose file does not provide;
`disabled` is plain HTTP for local testing.

Other fields in the example:

| Variable                            | Meaning and example/default                                                                          |
| ----------------------------------- | ---------------------------------------------------------------------------------------------------- |
| `SOMS_ADMIN_ACCESS`                 | `lan` in this template; `public` removes the source-IP restriction but still requires authentication |
| `PGDATABASE`                        | Database name, `soms`                                                                                |
| `PGUSER`                            | PostgreSQL role, `timescale`; the image is ordinary PostgreSQL, not TimescaleDB                      |
| `DATABASE_POOL_MAX`                 | App connection-pool maximum, `10`; budget connections across all app replicas                        |
| `LOG_LEVEL`                         | `warn` in this template; use `debug` for execution measurements                                      |
| `EXECUTION_MEASUREMENT_SAMPLE_RATE` | `0` disables measurement; values in `(0, 1]` sample operations and need debug logging                |
| `CADDY_DNS_DIRECTIVE`               | Required for TLS; template uses `dns cloudflare {env.CLOUDFLARE_API_TOKEN}`                          |
| `SOMS_STUN_URLS`                    | Optional comma-separated STUN URLs                                                                   |
| `SOMS_TURN_URLS`                    | Optional comma-separated TURN URLs; requires `SOMS_TURN_REST_SECRET`                                 |
| `SOMS_TURN_REST_SECRET`             | Shared REST-authentication secret matching the external TURN server                                  |
| `SOMS_TURN_TTL`                     | TURN credential lifetime in seconds; use a positive value, default `3600`                            |

All configured domains must share a registrable DNS zone. Configure public or split-horizon DNS so
the LAN hostname reaches the NAS internally. Publish TCP and UDP port `7667` so internet clients
and federation peers can reach the service; administrator routes remain restricted to private-range
clients by `SOMS_ADMIN_ACCESS=lan`.

The LAN restriction uses the source IP seen by Caddy. Use the LAN hostname for administration and
verify that public access to `/admin/` and `/api/v1/admin` returns 403. An upstream proxy or router
that rewrites public source addresses to private ones can defeat this distinction.

Point the public A and/or AAAA records for `SOMS_DOMAIN` and `SOMS_WEB_DOMAIN` at the publicly
reachable endpoint. If the public address changes, use a dynamic DNS updater supported by your DNS
provider.

For Cloudflare, use DNS-only (gray-cloud) records for these direct endpoints. Port 7667 is not
supported by the [standard Cloudflare HTTP/HTTPS proxy](https://developers.cloudflare.com/fundamentals/reference/network-ports/).

To enable federation, also publish the mandatory SOMFP SRV record. Its target must be a hostname,
not an IP address, and its port must match the published port, `7667`. For the example configuration above:

```dns
_somfp._tcp.example.com. 300 IN SRV 0 0 7667 example.com.
example.com.             300 IN A   192.0.2.10
soms.example.com.        300 IN A   192.0.2.10
```

Replace the documentation address with the deployment's public IPv4 address, or publish AAAA
records for reachable IPv6 instead. The selected endpoint must present a trusted TLS certificate
valid for `SOMS_DOMAIN`. Omitting the SRV record means the server does not publish a Federation v1
service, although its web client can still be reachable.

Choose the DNS provider explicitly under `services.app.environment`. The Cloudflare example is:

```yaml
CADDY_DNS_DIRECTIVE: 'dns cloudflare {env.CLOUDFLARE_API_TOKEN}'
CLOUDFLARE_API_TOKEN: 'your-token'
```

Use native `{env.NAME}` references; the script validates that variables are set and Caddy reads their
values at runtime. Credentials are not inserted into the generated Caddyfile. Other providers have
commented examples in `docker-compose.yml`; their module must support the referenced environment
placeholders. Add their credential variables to the app environment, not to the migration service.

Optional Firebase downloads use fixed paths—put the private
service-account credential at `data/firebase-service-account.json` and the Android client configuration
at `data/google-services.json`, then restart the app. Make the files readable by UID 1000; keep the
private credential mode 0600. There are no per-file path overrides. The shared `SOMS_CONFIG_DIR`
override relocates all credential/identity files, and `SOMS_DATA_DIR` changes the default data root;
leave both unset with this Compose template so files remain in the mounted `/app/data` directory.
TURN is external infrastructure and is configured through the `SOMS_STUN_*` and `SOMS_TURN_*` settings
listed above.

## 4. Validate and Start

Run these commands from the copied deployment directory:

```bash
docker compose config --quiet
docker compose up -d
docker compose ps -a
docker compose logs -f migrate app
```

PostgreSQL starts first, the one-shot `migrate` service applies migrations, and the app starts only
after migration succeeds. First-time DNS-01 certificate issuance normally takes tens of seconds.
Caddy state persists in `data/`.

Use `config --quiet` for validation: plain `docker compose config` prints resolved credentials.
This checks Compose syntax, not whether required passwords, domains, or DNS credentials are filled
in and valid. Fill them before starting; the template leaves secrets empty intentionally.
After editing `docker-compose.yml`, run `docker compose up -d` to recreate affected containers;
`docker compose restart` alone does not reload their environment.

Once TLS is ready, open the configured web origin. Sign in at `/admin` with account `admin` and the
bootstrap password, then replace the credential. For this example the LAN admin URL is
`https://soms-lan.example.com:7667/admin/`. An empty `ADMIN_BOOTSTRAP_PASSWORD` permits startup
but does not create an administrator.

## Running a Second Instance on the Same Host

Each SOMS instance is one deployment directory with its own `docker-compose.yml`, its own `data/`
bind mount, and its own database. Only one instance can publish host port `7667`; give any
additional instance a distinct published host port (for example `7668`) while the container port
stays `7667`, and keep `SOMS_TLS_MODE: single-port`:

```yaml
    ports:
      - target: 7667
        published: '7668'
        protocol: tcp
      - target: 7667
        published: '7668'
        protocol: udp
```

The [client-origin code](../../src/common/origin.ts) advertises the canonical port 7667, so an
instance on a different published port must additionally override the WebAuthn origins to the
real port; regular sign-in and the web client are unaffected:

```yaml
      SOMS_WEBAUTHN_ALLOWED_ORIGINS: 'https://soms.example.org:7668,https://soms-lan.example.org:7668'
```

Give each instance independent database name, credentials, domains, and DNS-provider credentials;
the DNS-01 provider must be able to answer for each instance's zone.

## Sharing an External PostgreSQL Instance

The template can also deploy against an existing PostgreSQL container instead of starting its own.
Remove the `postgres` service and the `volumes:` block, point the database anchor at the shared
container, join both remaining services to the shared container's Docker network, and pin the
image so a registry is never consulted:

```yaml
x-database-environment: &database-environment
  PGHOST: shared-postgres         # the shared container's resolvable name on that network
  PGPORT: '5432'
  PGDATABASE: &database-name soms_instance2
  PGUSER: &database-user soms_instance2
  PGPASSWORD: &database-password '<password>'

services:
  migrate:
    image: soms:latest
    pull_policy: never
    environment:
      <<: *database-environment
    networks: [shared-db]
    command: ['node', 'dist/scripts/migrate-db.js', 'migrate']
    restart: 'no'
  app:
    image: soms:latest
    pull_policy: never
    environment:
      <<: *database-environment
      # ...domains, TLS, and app settings exactly as in the standard template...
    networks: [shared-db]
    # ...depends_on / volumes / ports / restart exactly as in the standard template...

networks:
  shared-db:
    external: true
    name: shared-postgres_default # the Docker network of the shared PostgreSQL container
```

Create the dedicated database and role once on the shared instance — one pair per SOMS deployment,
so instances share hardware but never rows:

```sql
CREATE ROLE soms_instance2 LOGIN PASSWORD '<password>';
CREATE DATABASE soms_instance2 OWNER soms_instance2;
```

The shared instance is outside this template's lifecycle: its updates, backups, port exposure, and
credential strength are the operator's responsibility and apply to every database it hosts.

## Migrating an Existing `.env` Deployment

Back up the existing configuration first. In the same deployment directory, merge the new Compose
template with the values from the old `.env`: database settings go under `x-database-environment`,
and application and DNS-provider settings go under `services.app.environment`. Preserve any extra
operator settings explicitly; they are no longer injected through `env_file`. Convert literal dollar
signs to `$$` when moving values into YAML, and keep the configured YAML mode 0600.

Keep the deployment directory, Compose project name, `data/` mount, and PostgreSQL volume unchanged
so the new configuration reuses existing state. Do not change the database credentials or run
`docker compose down -v`. Validate with `docker compose config --quiet`, then apply with
`docker compose up -d` and check the migration status and app logs. The old `.env` is no longer
needed after a successful migration; remove it from the deployment directory and protect any backup
as a secret. If it also contained Compose controls such as `COMPOSE_PROJECT_NAME`, preserve the
same project name explicitly on future invocations (for example with `docker compose -p <name>`).

## Updates and Backups

Back up the private `docker-compose.yml`, `data/`, and PostgreSQL before updating. The following application-owned identity files are
generated on first use and reused on subsequent starts:

| File                       | Purpose                                                      |
| -------------------------- | ------------------------------------------------------------ |
| `data/soms-s2s-key.json`   | Version-1 federation root identity and separate signing keys |
| `data/vapid-key.json`      | Web Push application-server identity                         |
| `data/jwt-admin.key`       | Administration-session signing key                           |
| `data/password-pepper.key` | Server-side password hashing secret                          |
| `data/2fa.key`             | Encryption key for stored 2FA material                       |

Treat these files as secrets and restore them together with the matching database snapshot. Losing
or replacing one changes the corresponding identity or makes protected data and sessions unusable;
do not regenerate keys as part of a routine update. The directory may also contain the
operator-provided `data/firebase-service-account.json` secret and public Android client configuration
at `data/google-services.json`, plus persistent Caddy state under `data/caddy/`.

After taking the backup, set both `image:` lines in the deployment's `docker-compose.yml` to the
new version, run `docker compose pull` and `docker compose up -d`, then check the migration exit
status and app logs.

During the alpha phase the SQL baseline may be rewritten between builds. When the existing
database predates such a rewrite, the migration guard stops the upgrade with
`applied migration was modified: 0000_base` — the checksum mismatch is exactly the situation the
guard exists for, and the migrate service offers no bypass. The supported alpha path is to reset
the database (`docker compose down -v`; identity files under `data/` are untouched, but all
database content is lost) and let the migrate service initialize the schema fresh. Snapshot the
database first when its content matters.

When templates change, merge their changes into the operator-owned `docker-compose.yml` while
preserving its credentials, domains, and other local settings. Do not overwrite it with an unconfigured
repository template. `docker compose down` retains PostgreSQL unless `-v` is supplied; never use
`down -v` for a normal update.

The [federation specification](../../spec/README.md) defines server identity, pinned keys, peer
recognition, synchronization, and recovery. Losing `data/soms-s2s-key.json` changes the server identity
seen by existing peers if a fresh identity is generated. With existing federation history or a
database identity anchor, the app disables federation when the file is missing or mismatched;
it does not silently regenerate it. Restore the original file with its matching database.
Legacy single-key files are not accepted by the current version-1 reader.
