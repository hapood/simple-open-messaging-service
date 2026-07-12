#!/usr/bin/env bash
# Image ENTRYPOINT (both `runtime` and `full` stages). Loads the init-generated environment, if present,
# then execs the command (CMD). The `init` one-shot service writes /soms/run/app.env from soms.conf
# (docker/init.sh): DATABASE_URL (constructed from POSTGRES_PASSWORD), SOMS_DOMAIN, and any pass-through.
#
# When /soms/run/app.env is absent this is a plain `exec "$@"` — that covers: the `init` service itself,
# the slim image run standalone (operator provides env directly), and any `docker compose run app …`
# escape hatch. So nothing here is allowed to fail the boot if the file is missing.
set -euo pipefail

if [ -f /soms/run/app.env ]; then
  set -a
  # shellcheck disable=SC1091
  . /soms/run/app.env
  set +a
fi

exec "$@"
