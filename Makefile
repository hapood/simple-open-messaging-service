# SOMS Android APK builder — docker-based. Reuses the host's proxy env verbatim (no hardcoding).
#
#   make image   — (re)build the self-contained builder image (one-time, ~20 min cold).
#   make apk     — build the frontend (host npm) + emit a release APK inside the image.
#   make shell   — interactive shell in the builder (debugging).
#   make clean   — drop generated Android build outputs (keeps the gradle cache volume warm).
#   make help    — this list.
#
# Proxy: HTTP_PROXY / HTTPS_PROXY / NO_PROXY from your shell are forwarded to docker as-is — set
# them if you're behind a proxy, leave unset to go direct. Once `make image` and the first `make apk`
# have warmed the caches, later `make apk` runs need NO network at all (proxy or not).
#
# Host prerequisites: Docker (hard), Node (for the frontend `npm --prefix web run build`).

IMAGE      := soms-android-build:24.04
GRADLE_VOL := soms-gradle
WORK       := /work

# Forward the host proxy env to docker. The bare `--build-arg HTTP_PROXY` / `-e HTTP_PROXY` forms
# pull the value from the local environment (empty if unset, = direct). `--network host` lets a
# localhost proxy (e.g. 127.0.0.1:7892) be reached from the build/run container.
PROXY_BUILD_ARGS := --network host --build-arg HTTP_PROXY --build-arg HTTPS_PROXY --build-arg NO_PROXY
PROXY_RUN_FLAGS  := --network host -e HTTP_PROXY -e HTTPS_PROXY -e http_proxy -e https_proxy -e NO_PROXY -e no_proxy
# Clear any stale JAVA_TOOL_OPTIONS baked into an older image (gradle is Java and ignores HTTP_PROXY;
# without this it could try a dead proxy). A no-op on a clean image.
CLEAR_JAVA_PROXY := -e JAVA_TOOL_OPTIONS=

DOCKER_RUN := docker run --rm --user "$$(id -u):$$(id -g)" -e HOME=/tmp \
              $(PROXY_RUN_FLAGS) $(CLEAR_JAVA_PROXY) \
              -v "$(CURDIR):$(WORK)" -v $(GRADLE_VOL):/opt/gradle -w $(WORK)

.PHONY: help image apk shell clean
help:  ## show this help
	@awk 'BEGIN{FS":.*## "} /^[a-zA-Z_-]+:.*## /{printf "  \033[36m%-8s\033[0m %s\n",$$1,$$2}' $(MAKEFILE_LIST)

image:  ## (re)build the builder image (standard sources; reuses host proxy if set)
	docker build -t $(IMAGE) $(PROXY_BUILD_ARGS) src-tauri

apk:  ## build frontend + release APK (no proxy needed once caches are warm)
	npm --prefix web run build
	$(DOCKER_RUN) $(IMAGE) cargo tauri android build --apk --config '{"build":{"beforeBuildCommand":""}}'
	@echo "✓ APK:"; @ls -1 src-tauri/gen/android/app/build/outputs/apk/universal/release/*.apk 2>/dev/null | sed 's/^/    /'

shell:  ## interactive shell in the builder
	$(DOCKER_RUN) -it $(IMAGE) bash

clean:  ## drop generated Android build outputs (keeps the gradle cache volume warm)
	rm -rf src-tauri/gen/android/.gradle src-tauri/gen/android/build src-tauri/gen/android/app/build
