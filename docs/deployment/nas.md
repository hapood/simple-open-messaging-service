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

- Docker Engine with Docker Compose v2
- A registered domain whose DNS zone you control; a normal registrable domain is sufficient
- A DNS-01 provider credential; Cloudflare is the default example
- A publicly reachable deployment host: devices outside the home network must be able to connect to
  the NAS through a public IP address and the client and federation port, normally TCP and UDP `7667`

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

## 2. Copy the NAS Example

```bash
sudo mkdir -p /opt/soms
sudo cp -r deploy/nas/. /opt/soms/
cd /opt/soms
cp .env.example .env
```

Copy the directory contents so the hidden `.env.example` is included. The deployment directory will
contain `docker-compose.yml`, `.env`, and a generated `data/` directory. PostgreSQL uses the
Compose-managed `postgres-data` volume.

## 3. Configure `.env`

Set these values before the first start:

| Variable                   | Purpose                                                              |
| -------------------------- | -------------------------------------------------------------------- |
| `SOMS_DOMAIN`              | Federation identity used in handles such as `@alice@example.com`     |
| `SOMS_WEB_DOMAIN`          | Browser and native-client entry hostname; it may equal `SOMS_DOMAIN` |
| `PGPASSWORD`               | Password used to initialize PostgreSQL                               |
| `ADMIN_BOOTSTRAP_PASSWORD` | Creates the first `admin` account when none exists                   |
| `CLOUDFLARE_API_TOKEN`     | Default DNS-01 credential with `Zone:DNS:Edit` permission            |

Generate unique database and administrator passwords. Changing `PGPASSWORD` after PostgreSQL has
initialized its volume does not rotate the database role.

```dotenv
SOMS_DOMAIN=example.com
SOMS_WEB_DOMAIN=soms.example.com
SOMS_LAN_DOMAIN=soms-lan.example.com
SOMS_TLS_MODE=single-port
SOMS_ADMIN_ACCESS=lan
SOMS_PORT=7667
```

All configured domains must share a registrable DNS zone. Configure public or split-horizon DNS so
the LAN hostname reaches the NAS internally. Publish TCP and UDP for `SOMS_PORT` so internet clients
and federation peers can reach the service; administrator routes remain restricted to private-range
clients by `SOMS_ADMIN_ACCESS=lan`.

Point the public A and/or AAAA records for `SOMS_DOMAIN` and `SOMS_WEB_DOMAIN` at the publicly
reachable endpoint. If the public address changes, use a dynamic DNS updater supported by your DNS
provider.

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

For a DNS provider other than Cloudflare, set `CADDY_DNS_DIRECTIVE` and the provider credentials as
shown in the selected `.env.example`. Optional Firebase downloads use fixed paths—put the private
service-account credential at `data/firebase-service-account.json` and the Android client configuration
at `data/google-services.json`, then restart the app. Their paths cannot be overridden by environment
variables. TURN is external infrastructure and is configured through the documented `SOMS_STUN_*` and
`SOMS_TURN_*` settings.

## 4. Validate and Start

Run these commands from the copied deployment directory:

```bash
docker compose config
docker compose up -d
docker compose ps
docker compose logs -f migrate app
```

PostgreSQL starts first, the one-shot `migrate` service applies migrations, and the app starts only
after migration succeeds. First-time DNS-01 certificate issuance normally takes tens of seconds.
Caddy state persists in `data/`.

Once TLS is ready, open the configured web origin. Sign in at `/admin` with account `admin` and the
bootstrap password, then replace the credential. An empty `ADMIN_BOOTSTRAP_PASSWORD` permits startup
but does not create an administrator.

## Updates and Backups

Back up `data/` and PostgreSQL before updating. The following application-owned identity files are
generated on first use and reused on subsequent starts:

| File                       | Purpose                                    |
| -------------------------- | ------------------------------------------ |
| `data/soms-s2s-key.json`   | Federation server identity and signing key |
| `data/vapid-key.json`      | Web Push application-server identity       |
| `data/jwt-admin.key`       | Administration-session signing key         |
| `data/password-pepper.key` | Server-side password hashing secret        |
| `data/2fa.key`             | Encryption key for stored 2FA material     |

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
seen by existing peers and requires an explicit recovery procedure.
