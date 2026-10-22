# Building the Docker Image

The [deployment guide](../deployment/deployment.md) uses versioned registry images. This page is
for maintainers and contributors who build an image for local testing or development. Select the
local image tag in the Compose generator when deploying a locally built image.

## Build

From the repository root:

```bash
./scripts/build-image.sh
```

The script invokes the repository's Buildx Bake graph and creates `soms:<version>` and `soms:latest`.
The runtime and compiler bases are internal, cached build targets: they are rebuilt when their
inputs change and do not need to be published or preinstalled locally.

`scripts/build-base.sh` and `scripts/build-build-base.sh` build the two base layers directly; they
exist for inspection and debugging — the unified graph builds both automatically when needed.
`Dockerfile.base` pins the Caddy version and compiles it with xcaddy plus the bundled DNS-01
providers; `NODE_IMAGE` and `CADDY_BUILDER_IMAGE` override the base images when Docker Hub is
unreachable. All three scripts take no command-line arguments; configuration is via the
environment variables documented in their headers.

## Network and Proxies

The build pulls base images from Docker Hub and downloads npm, Debian, and Go module dependencies,
so it needs outbound internet access. Exported `HTTP_PROXY`, `HTTPS_PROXY`, and `NO_PROXY`
variables (and their lowercase forms) are forwarded verbatim into the build containers; no address
is rewritten. Because builds run on Docker's isolated default bridge network, a proxy must be
reachable from build containers: a loopback address works only with `BUILD_NETWORK=host` —
otherwise use an address the containers can reach (for example the proxy host's address on the LAN
or the Docker bridge gateway). Machines that need a proxy export the variables in the invoking
environment — for example from a personal wrapper script. In Distrobox without a local Docker CLI,
the scripts invoke the host Docker CLI through `host-spawn` and forward these variables.

## Release Publishing

Tag pushes (`v*`) trigger the container image workflow, which builds `linux/amd64` and `linux/arm64`
images and publishes them to `ghcr.io/hapood/simple-open-messaging-service` under the tag name.
The Compose generator and NAS template target `v0.1.0-alpha.0`; the public template uses `latest`.
Publish the version tag
from `main` after the release pull request is approved and squash-merged; the image is available
after the tag workflow succeeds. Every version release, including alpha, updates `latest`.
Development branch builds only update `dev` and commit tags.

For an existing generated deployment, update the shared `app-image` anchor when selecting a new
release. See [Publishing container images](publishing-images.md) for tags and registry access.
