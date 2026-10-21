#!/usr/bin/env bash
# Image entrypoint. Compose injects container environment variables; for the default app supervisor,
# render and validate its internal Caddyfile before either child process starts. One-shot commands such
# as database migrations do not need Caddy configuration.
set -euo pipefail

if [ "${1:-}" = "/app/supervisor.sh" ]; then
  export CADDYFILE="${CADDYFILE:-/tmp/soms/Caddyfile}"
  /app/init.sh
fi

exec "$@"
