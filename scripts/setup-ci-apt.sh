#!/usr/bin/env bash
# Configure GitHub-hosted Ubuntu runners before any apt or Playwright installation.
set -euo pipefail

source /etc/os-release
if [[ "$ID" != ubuntu || "$(dpkg --print-architecture)" != amd64 ]]; then
  echo 'This setup supports Ubuntu amd64 runners only.' >&2
  exit 1
fi

# Probe every pocket: a mirror serving the base release may lack security updates.
# APT still authenticates all metadata with the runner's Ubuntu archive keyring.
selected=''
for mirror in \
  https://archive.ubuntu.com/ubuntu \
  https://mirrors.edge.kernel.org/ubuntu \
  https://mirrors.mit.edu/ubuntu; do
  available=true
  for pocket in "$VERSION_CODENAME" "$VERSION_CODENAME-updates" "$VERSION_CODENAME-security" "$VERSION_CODENAME-backports"; do
    if ! curl --fail --silent --show-error --location --connect-timeout 5 --max-time 15 \
      --output /dev/null "$mirror/dists/$pocket/InRelease"; then
      available=false
      break
    fi
  done
  if "$available"; then
    selected="$mirror"
    break
  fi
done
if [[ -z "$selected" ]]; then
  echo 'No Ubuntu archive mirror is reachable; refusing to use stale package indexes.' >&2
  exit 1
fi

# Keep the runner's source definitions and signing settings; replace only its mirror list.
if [[ ! -f /etc/apt/apt-mirrors.txt ]]; then
  echo 'Expected GitHub runner APT mirror list is missing.' >&2
  exit 1
fi
printf '%s\n' "$selected" | sudo tee /etc/apt/apt-mirrors.txt
printf '%s\n' \
  'Acquire::Retries "2";' \
  'Acquire::http::Timeout "30";' \
  'Acquire::https::Timeout "30";' \
  'APT::Update::Error-Mode "any";' \
  | sudo tee /etc/apt/apt.conf.d/80-soms-ci
sudo apt-get update
