# Docker Deployment

SOMS includes two Docker Compose examples under [`deploy/`](../deploy/). They run PostgreSQL, apply
database migrations, and start the full SOMS image containing the application and its Caddy TLS edge.

The examples are launch templates. Copy one to an operator-owned directory so its `.env`, generated
state, Firebase files, and backups remain outside the Git checkout.

## Choose a Profile

| Profile                              | Use it when                                 | Network behavior                                                                                             |
| ------------------------------------ | ------------------------------------------- | ------------------------------------------------------------------------------------------------------------ |
| [`deploy/public`](../deploy/public/) | The server is internet-facing               | Publishes HTTP `80`, HTTPS `443`, and federation `7667`; administrator routes are public but authenticated   |
| [`deploy/nas`](../deploy/nas/)       | The server runs on a NAS or private network | Publishes one HTTPS/federation port, normally `7667`; administrator routes accept private-range clients only |

Both profiles obtain trusted DNS-01 certificates. The NAS profile can advertise a second real LAN
hostname for networks without hairpin NAT; it does not use a self-signed certificate.

## Requirements

- Docker Engine with Docker Compose v2
- A domain whose DNS zone you control
- A DNS-01 provider credential; Cloudflare is the default example
- The host ports required by the selected profile

## 1. Build the Image

From the repository root:

```bash
./scripts/build-image.sh
```

The script invokes the repository's Buildx Bake graph and creates `soms:<version>` and `soms:latest`.
The runtime and compiler bases are internal, cached build targets: they are rebuilt when their inputs
change and do not need to be published or preinstalled locally. The Compose examples reference
`soms:latest`; `docker compose up` does not build it automatically.

## 2. Copy an Example

For a public server:

```bash
sudo mkdir -p /opt/soms
sudo cp -r deploy/public/. /opt/soms/
cd /opt/soms
cp .env.example .env
```

Use `deploy/nas/.` instead for a NAS. Copy the directory contents so the hidden `.env.example` is
included. The deployment directory will contain `docker-compose.yml`, `.env`, and a generated `data/`
directory. PostgreSQL uses the Compose-managed `postgres-data` volume.

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

### Public profile

```dotenv
SOMS_DOMAIN=example.com
SOMS_WEB_DOMAIN=soms.example.com
SOMS_TLS_MODE=standard
SOMS_ADMIN_ACCESS=public
SOMS_HTTP_PORT=80
SOMS_HTTPS_PORT=443
SOMS_FEDERATION_PORT=7667
```

Point the hostnames at the server and allow TCP `80`, TCP/UDP `443`, and TCP/UDP `7667` through the
firewall.

### NAS profile

```dotenv
SOMS_DOMAIN=example.com
SOMS_WEB_DOMAIN=soms.example.com
SOMS_LAN_DOMAIN=soms-lan.example.com
SOMS_TLS_MODE=single-port
SOMS_ADMIN_ACCESS=lan
SOMS_PORT=7667
```

All configured domains must share a registrable DNS zone. Configure public or split-horizon DNS so
the LAN hostname reaches the NAS internally, and publish TCP and UDP for `SOMS_PORT`.

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

| File                       | Purpose                                      |
| -------------------------- | -------------------------------------------- |
| `data/soms-s2s-key.json`   | Federation server identity and signing key   |
| `data/vapid-key.json`      | Web Push application-server identity         |
| `data/jwt-admin.key`       | Administration-session signing key           |
| `data/password-pepper.key` | Server-side password hashing secret           |
| `data/2fa.key`             | Encryption key for stored 2FA material       |

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

Read the [federated deployment guide](overview/federation-protocol.md) for DNS discovery, pinned keys,
peer recognition, and recovery. Losing `data/soms-s2s-key.json` changes the server identity seen by
existing peers and requires an explicit recovery procedure.
