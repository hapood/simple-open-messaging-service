# Publishing Container Images

The [Container image workflow](../../.github/workflows/image.yml) publishes the application to
`ghcr.io/hapood/simple-open-messaging-service` independently of Android signing and APK releases.
It reuses the [application verification workflow](../../.github/workflows/verify.yml) and builds
and checks each architecture on a native GitHub-hosted runner in parallel. Only after application
verification and both architectures pass does it assemble and update the multi-platform tags.

## Tags

| Trigger                        | Published multi-platform tags                        |
| ------------------------------ | ---------------------------------------------------- |
| Push to `dev`                  | `dev`, `sha-<full commit SHA>`                       |
| Push `v<package.json version>` | Exact version tag, `sha-<full commit SHA>`, `latest` |

Version releases, including prereleases such as `v0.1.0-alpha.0`, update `latest`. Development
branch pushes never update `latest`. Every image includes `linux/amd64` and
`linux/arm64`. Per-architecture staging tags use `sha-<full commit SHA>-amd64` and
`sha-<full commit SHA>-arm64`; deployment configurations should use a multi-platform tag.

The build checks Caddy, FFmpeg, native Argon2 and Sharp modules, compiled server and migration
entry points, and both frontend bundles. Version tags must match all repository version manifests.
Development images carry a version containing the source commit to distinguish them from releases.

The workflow can also be run manually with `dev` or an existing matching version tag selected.
It rejects publication from other branches. Publishing a version tag does not require Android
signing secrets, and an Android release failure does not block container publication.

## Registry Access

GitHub Actions authenticates using its repository-scoped `GITHUB_TOKEN` with `packages: write`.
No personal access token or Docker Hub account is required. The image source label links the
package to its GitHub repository.

For the first publication, a package administrator must open the
[package settings](https://github.com/users/hapood/packages/container/simple-open-messaging-service/settings)
and set **Change visibility → Public**. A public repository alone does not make a newly created
GHCR package public. See [GitHub's container registry documentation](https://docs.github.com/en/packages/working-with-a-github-packages-registry/working-with-the-container-registry).

Verify public access without using locally saved registry credentials:

```bash
docker_config=$(mktemp -d)
docker --config "$docker_config" pull ghcr.io/hapood/simple-open-messaging-service:dev
rm -r "$docker_config"
```

The Compose generator and NAS template default to
`ghcr.io/hapood/simple-open-messaging-service:v0.1.0-alpha.0`; the public template uses `:latest`.
Publish that tag from `main` after
the release pull request has been approved and squash-merged. Versioned images become available
after the tag workflow succeeds; merging to `main` alone does not publish them.

Use `:dev` explicitly for development testing. Pin an image digest when a deployment needs an
immutable image reference, and keep the migration and application services on the same reference.
The first alpha release also publishes `:latest`, and subsequent version releases update it.
The GitHub Release remains marked as a prerelease for alpha versions; that designation is separate
from the container registry's `latest` tag.
