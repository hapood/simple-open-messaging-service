# Deployment

Use the [Compose configuration generator](https://hapood.github.io/simple-open-messaging-service/#/deploy)
to deploy SOMS on a public server or a NAS. It produces one `docker-compose.yml` containing
PostgreSQL, automatic database migrations, the application, and its Caddy TLS edge.

All deployment settings live in the YAML file. An operator `.env` file, external Caddyfile, or
separate configuration file is not required. Configuration is generated locally in the browser;
inputs, preview, copy, and download all show the actual plaintext values.

## Requirements

- Docker Engine with Docker Compose v2
- A domain and control of its DNS zone
- Credentials for a DNS provider supported by the generator: Cloudflare, AliDNS, or Tencent Cloud DNS
- A deployment host reachable by the intended clients and federation peers

For a NAS behind a router, forward the selected ports to the host and allow them through the
firewall. Docker port publication does not configure the router or upstream firewall. A NAS behind
CGNAT needs another reachable route, such as public IPv6, for access from the internet.

## 1. Choose a Deployment Mode

The generator has exactly two modes. A custom published port is a NAS setting, not a third mode.

| Setting                       | Public Server (`public`)    | LAN / NAS (`nas`)                          |
| ----------------------------- | --------------------------- | ------------------------------------------ |
| TLS mode                      | `standard`                  | `single-port`                              |
| Browser and API entry         | `https://soms.example.com`  | `https://soms.example.com:7667` by default |
| Published TCP ports           | 80 and 443                  | Selected port, default 7667                |
| Published UDP port for HTTP/3 | 443                         | Selected port, default 7667                |
| Federation SRV port           | 443                         | Selected port, default 7667                |
| Default admin access          | Public, with login required | Private source IPs, with login required    |

Public mode redirects HTTP on port 80 to HTTPS on 443. The generated configuration serves both
client and federation traffic on HTTPS port 443; it does not require a separate published 7667 port.
NAS mode maps the selected host port to the container's single HTTPS port.

The admin restriction is independently configurable in either mode. With private-source access
selected, Caddy restricts `/admin/` and `/api/v1/admin` by the source IP it sees. A proxy or router
that rewrites public requests to a private source address can defeat that distinction.

## 2. Fill In the Configuration

Open the generator and enter the following values:

| Field                        | Purpose                                                                                       |
| ---------------------------- | --------------------------------------------------------------------------------------------- |
| Identity domain              | Stable server identity used in user addresses and federation discovery, such as `example.com` |
| Server hostname              | Browser entry and federation SRV target, such as `soms.example.com`                           |
| LAN hostname                 | Optional direct LAN entry, such as `soms-lan.example.com`                                     |
| Database password            | PostgreSQL connection credential; the generator supplies a random initial value               |
| Initial admin password       | Creates the initial `admin` account when absent                                               |
| DNS provider and credentials | Allow Caddy to obtain trusted certificates using DNS-01                                       |
| Image version                | Versioned application image shared by the app and migration services                          |

Use lowercase hostnames without a scheme, port, or path. All configured domains must share a
registrable DNS zone. The identity domain does not need its own A/AAAA record when discovery points
to a separate server hostname. Resolve the optional LAN hostname to the host's private address on
the local network; this supports networks without hairpin NAT.

Database and administrator passwords must each contain at least 16 characters. They are different
credentials: the database password connects services to PostgreSQL, while the initial admin
password signs into the administration console. Changing either value in the YAML does not rotate
an existing database role or reset an existing administrator password.

The generator and NAS template target the `v0.1.0-alpha.0` prerelease:

```text
ghcr.io/hapood/simple-open-messaging-service:v0.1.0-alpha.0
```

This image supports `linux/amd64` and `linux/arm64`; Docker selects the host architecture
automatically. Both the application and migration service use this exact version.
The public deployment template uses `ghcr.io/hapood/simple-open-messaging-service:latest` for both
services. Every published version, including alpha releases, updates `latest`; its first release
points to `v0.1.0-alpha.0`. Use an explicit version tag when upgrades must be selected individually.
The versioned image and `latest` become available when the release tag is
published from `main`; merging the pull request alone does not publish it.

Release availability and upgrade notes are listed on the
[GitHub Releases page](https://github.com/hapood/simple-open-messaging-service/releases).
The rolling `:dev` image is available for development testing and changes independently of releases.

For a locally built image, enter its local tag instead; see
[Building the Docker image](../development/building-the-image.md).

Download the configuration as `docker-compose.yml`. Editable values appear in the top-level
`x-settings` block and are shared with services through YAML anchors. For example, `app-image`
is reused by both the migration and application services. Keep the file private and outside the
source checkout.

The generator escapes YAML strings and literal dollar signs for Docker Compose. When manually
editing the file, write `$$` for a literal `$`; native Caddy placeholders such as
`{env.CLOUDFLARE_API_TOKEN}` need no dollar escaping.

## 3. Configure DNS and Network Access

Use the DNS records and ports shown in the generator's deployment checklist. Point the server
hostname's A/AAAA record at a reachable address, then publish the federation SRV record under the
identity domain. Use DNS-only records for the direct server endpoint.

For public mode:

```dns
soms.example.com.        300 IN A   192.0.2.10
_somfp._tcp.example.com. 300 IN SRV 10 0 443 soms.example.com.
```

For NAS mode on the default port:

```dns
soms.example.com.        300 IN A   192.0.2.10
_somfp._tcp.example.com. 300 IN SRV 10 0 7667 soms.example.com.
```

Replace the example address with the host's public IPv4 address, or use AAAA for reachable IPv6.
The SRV target must be a hostname. Its port must match the selected externally reachable HTTPS
port. Without the SRV record, the server does not advertise its Federation v1 service.

For a different NAS port, configure it in the generator before downloading, then use that port in
router forwarding, firewall rules, URLs, and the SRV record. The generator also sets WebAuthn origins
for the selected port. Native-client origin discovery still derives the canonical single-port origin
with port 7667; a custom host port does not change that advertised default. Use the default port
when relying on automatic native-client origin selection.

Caddy obtains trusted DNS-01 certificates using the selected provider. Keep the provider credentials
in the generated application environment; no manual Caddyfile is required.

## 4. Start SOMS

Save the downloaded YAML in a dedicated deployment directory:

```bash
mkdir soms && cd soms
# Place docker-compose.yml here.
sudo install -d -m 0750 -o 1000 -g 1000 data
docker compose up -d
docker compose logs -f app
```

PostgreSQL starts first. The one-shot `migrate` service applies migrations before `app` starts.
The app stores generated keys, media, logs, and Caddy state under the bind-mounted `data/` directory.
PostgreSQL stores its database in the separate Compose-managed `postgres-data` volume.

The application runs as UID/GID `1000:1000`; the bind-mounted `data/` directory must be writable by
that identity. For rootless Docker or user namespace remapping, use the corresponding mapped host
ownership instead of the numeric ownership above.

Open the configured HTTPS origin. Sign in at `/admin/` with account `admin` and the initial admin
password. In NAS mode, the default admin restriction requires a private source IP; use the LAN
hostname if configured.

After changing the YAML, run `docker compose up -d` to recreate affected containers.
`docker compose restart` alone does not reload container environment values.

## Runtime Logging and Optional Services

Log output starts at `error` on every backend restart. Change **Output level** under **Logs → Live
tail** in the administration console. The setting applies immediately to console, files, and live
logs, stays in memory, and resets on restart. Historical log search has a separate display filter.
Execution measurements additionally require a nonzero `EXECUTION_MEASUREMENT_SAMPLE_RATE` and
`debug` or `trace` output.

Optional Firebase downloads use fixed filenames under `data/`:

- `firebase-service-account.json`: private Firebase service-account credential for sending FCM pushes
- `google-services.json`: Android Firebase client configuration

Restart the app after adding or replacing these files. Leave `SOMS_CONFIG_DIR` and `SOMS_DATA_DIR`
unset to keep files under the mounted data directory.

TURN runs as external infrastructure. Configure `SOMS_STUN_URLS` as needed, and set both
`SOMS_TURN_URLS` and `SOMS_TURN_REST_SECRET` to enable TURN credentials. The REST secret must match
the external TURN server.

## Updates

In the deployed YAML, change the shared `app-image` anchor to the desired release, then run:

```bash
docker compose pull
docker compose up -d
```

For the public template using `:latest`, the same commands upgrade to the most recently published
version, which may be an alpha release. Pin both the `app` and `migrate` image references to an
explicit version if the deployment should remain on that version. A `:dev` push does not move `latest`.

Preserve the deployment directory, Compose project name, database volume, and `data/` mount.
When regenerating configuration, retain the existing credentials, domains, and other operator values;
do not replace a working configuration with freshly generated passwords. Do not use
`docker compose down -v` for a routine update, because it removes the database volume.

## Backup and Restore

Back up the configuration, application files, and PostgreSQL database together. Run these commands
from the deployment directory during a maintenance window. Store the backup outside that directory
with access restricted to its owner; it contains credentials, private keys, and user data.

```bash
backup_dir=$(mktemp -d ../soms-backup-XXXXXXXX)
docker compose stop app
docker compose exec -T postgres sh -c 'pg_dump -U "$POSTGRES_USER" -d "$POSTGRES_DB" --format=custom' > "$backup_dir/database.dump"
sudo tar -cpf "$backup_dir/deployment.tar" docker-compose.yml data
docker compose up -d app
```

Check that each command succeeds. If the database export or archive fails, retain the original data,
restart the app, and resolve the failure before treating the backup as usable. Keep the original
image reference with the backup.

To restore, use a separate deployment directory and a fresh PostgreSQL volume. Extract
`deployment.tar` there with `sudo tar -xpf`, preserving the ownership of `data/`, then start only
PostgreSQL and restore the database:

```bash
docker compose up -d --wait postgres
docker compose exec -T postgres sh -c 'pg_restore -U "$POSTGRES_USER" -d "$POSTGRES_DB" --no-owner --no-privileges --exit-on-error' < /path/to/backup/database.dump
docker compose up -d
```

Use the same image version for the first restore, verify login and existing data, then follow the
update procedure if needed. Do not point a test restore at the production database or reuse the
production Compose project name. Test backups periodically on an isolated host or network.
