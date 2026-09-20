# NAS Deployment

This published guide covers deployment on a NAS or another host inside a home LAN. Administrator
routes accept private-range clients only, while the web client and federation endpoint can be made
reachable from the internet through the configured public hostname and port.

The internet-facing server profile under [`deploy/public`](../../deploy/public/) is available for
development, but its deployment guide is still being written and is not part of the initial
published deployment documentation.

The NAS Docker Compose example runs PostgreSQL, applies database migrations, and starts the full SOMS
image containing the application and its Caddy TLS edge.

The example is a launch template. Copy it to an operator-owned directory so its `.env`, generated
state, Firebase files, and backups remain outside the Git checkout.

The NAS profile publishes one HTTPS/federation port, normally `7667`, and obtains a trusted DNS-01
certificate. It can advertise a second real LAN hostname for networks without hairpin NAT; it does
not use a self-signed certificate.

## Requirements

- Docker Engine with Docker Compose v2, Buildx Bake, and Node.js for the build script
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

## 1. Build the Image

From the repository root:

```bash
./scripts/build-image.sh
```

The script invokes the repository's Buildx Bake graph and creates `soms:<version>` and `soms:latest`.
The runtime and compiler bases are internal, cached build targets: they are rebuilt when their inputs
change and do not need to be published or preinstalled locally. The Compose example references
`soms:latest`; `docker compose up` does not build it automatically.

The script inherits exported `HTTP_PROXY`, `HTTPS_PROXY`, and `NO_PROXY` variables (and their
lowercase forms). It uses host networking so a proxy on the Docker host's loopback is reachable.
In Distrobox without a local Docker CLI, it invokes the host Docker CLI through `host-spawn` and
forwards these variables. No proxy address is built into the script.

## 2. Copy the NAS Example

```bash
sudo install -d -m 0750 -o "$(id -u)" -g "$(id -g)" /opt/soms
cp -r deploy/nas/. /opt/soms/
cd /opt/soms
cp .env.example .env
chmod 600 .env
sudo install -d -m 0750 -o 1000 -g 1000 data
```

Copy the directory contents so the hidden `.env.example` is included. The deployment directory will
contain `docker-compose.yml`, `.env`, and a generated `data/` directory. PostgreSQL uses the
Compose-managed `postgres-data` volume. The app runs as UID/GID `1000:1000`; its bind-mounted
`data/` directory must be writable by that identity. Otherwise Docker can create a root-owned
directory on first start and the app cannot write keys or Caddy state. For rootless Docker or user
namespace remapping, use the corresponding mapped host ownership.

## 3. Configure `.env`

Set these values before the first start:

| Variable                   | Purpose                                                                                              |
| -------------------------- | ---------------------------------------------------------------------------------------------------- |
| `SOMS_DOMAIN`              | Federation identity used in handles such as `@alice@example.com`                                     |
| `SOMS_WEB_DOMAIN`          | Browser and native-client entry hostname; it may equal `SOMS_DOMAIN`                                 |
| `PGPASSWORD`               | Password used to initialize PostgreSQL                                                               |
| `ADMIN_BOOTSTRAP_PASSWORD` | Creates the bootstrap `admin` account/role when it is absent; does not reset an existing password    |
| `CLOUDFLARE_API_TOKEN`     | Default DNS-01 credential with `Zone:Zone:Read` and `Zone:DNS:Edit` permissions for the managed zone |

The Cloudflare permissions match the [Caddy Cloudflare provider requirements](https://github.com/caddy-dns/cloudflare#configuration).
Use lowercase hostnames without a scheme, port, or path for the domain fields. `SOMS_WEB_DOMAIN`
defaults to `SOMS_DOMAIN` when omitted; `SOMS_LAN_DOMAIN` is optional and can be removed when a
separate LAN entry is unnecessary.

Generate unique database and administrator passwords. Changing `PGPASSWORD` after PostgreSQL has
initialized its volume does not rotate the database role; changing only `.env` instead makes the
app and migration credentials disagree with PostgreSQL. Rotate the role password and update the
deployment configuration together. Single-quote dotenv secrets containing `$` to prevent Compose
interpolation.

```dotenv
SOMS_DOMAIN=example.com
SOMS_WEB_DOMAIN=soms.example.com
SOMS_LAN_DOMAIN=soms-lan.example.com
SOMS_TLS_MODE=single-port
SOMS_ADMIN_ACCESS=lan
SOMS_PORT=7667
```

Keep `SOMS_TLS_MODE=single-port` and `SOMS_PORT=7667` for this profile. `SOMS_PORT` changes only
Docker's host mapping: the [client-origin code](../../src/common/origin.ts) still advertises port
7667 for the native shell and WebAuthn. Changing the mapping alone is not a supported custom-port
deployment. `standard` mode also needs published ports 80/443, which this NAS Compose file does not
provide; `disabled` is plain HTTP for local testing.

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
the LAN hostname reaches the NAS internally. Publish TCP and UDP for `SOMS_PORT` so internet clients
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
not an IP address, and its port must match `SOMS_PORT`. For the example configuration above:

```dns
_somfp._tcp.example.com. 300 IN SRV 0 0 7667 example.com.
example.com.             300 IN A   192.0.2.10
soms.example.com.        300 IN A   192.0.2.10
```

Replace the documentation address with the deployment's public IPv4 address, or publish AAAA
records for reachable IPv6 instead. The selected endpoint must present a trusted TLS certificate
valid for `SOMS_DOMAIN`. Omitting the SRV record means the server does not publish a Federation v1
service, although its web client can still be reachable.

Choose the DNS provider explicitly in `.env`. The Cloudflare example is:

```dotenv
CADDY_DNS_DIRECTIVE="dns cloudflare {env.CLOUDFLARE_API_TOKEN}"
CLOUDFLARE_API_TOKEN=your-token
```

Use native `{env.NAME}` references; the script validates that variables are set and Caddy reads their
values at runtime. Credentials are not inserted into the generated Caddyfile. Other providers have
examples in `.env.example`; their module must support the referenced environment placeholders.

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
After editing `.env`, run `docker compose up -d` to recreate affected containers; `docker compose
restart` alone does not reload their environment.

Once TLS is ready, open the configured web origin. Sign in at `/admin` with account `admin` and the
bootstrap password, then replace the credential. For this example the LAN admin URL is
`https://soms-lan.example.com:7667/admin/`. An empty `ADMIN_BOOTSTRAP_PASSWORD` permits startup
but does not create an administrator.

## Updates and Backups

Back up `.env`, `docker-compose.yml`, `data/`, and PostgreSQL before updating. The following application-owned identity files are
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

After taking the backup, pull the intended source revision, rebuild `soms:latest` with
`./scripts/build-image.sh`, and run `docker compose up -d` from the deployment directory. Check the
migration exit status and app logs.

Keep the copied `docker-compose.yml` aligned with the source revision when templates change, but
preserve secrets in `.env`. `docker compose down` retains PostgreSQL unless `-v` is supplied; never use
`down -v` for a normal update.

The [federation specification](../../spec/README.md) defines server identity, pinned keys, peer
recognition, synchronization, and recovery. Losing `data/soms-s2s-key.json` changes the server identity
seen by existing peers if a fresh identity is generated. With existing federation history or a
database identity anchor, the app disables federation when the file is missing or mismatched;
it does not silently regenerate it. Restore the original file with its matching database.
Legacy single-key files are not accepted by the current version-1 reader.
