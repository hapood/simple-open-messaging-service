# SOMS Android APK builder — LINUX host, docker-based. Sits next to the Dockerfile it builds and
# produces the Android release APK on a Linux (Ubuntu/Debian) host. macOS / Windows desktop artifacts
# are NOT built here — macOS can't be cross-built on Linux (needs hdiutil/codesign + the macOS SDK).
#
#   make image   — (re)build the self-contained builder image (one-time, ~20 min cold).
#   make apk     — build the frontend (host npm) + emit a release APK inside the image.
#   make shell   — interactive shell in the builder (debugging).
#   make clean   — drop generated Android build outputs (keeps the gradle cache volume warm).
#   make help    — this list.
#
# Invoke from anywhere — paths anchor to this file's location, so all of these are equivalent:
#   make -C src-tauri apk          # from the repo root
#   cd src-tauri && make apk       # from inside src-tauri
#   make -f src-tauri/Makefile apk # explicit path
#
# Proxy: HTTP_PROXY / HTTPS_PROXY / NO_PROXY from your shell are forwarded to docker as-is — set
# them if you're behind a proxy, leave unset to go direct. Once `make image` and the first `make apk`
# have warmed the caches, later `make apk` runs need NO network at all (proxy or not).
#
# Host prerequisites: Docker (hard), Node (for the frontend `npm run build` in ../web).

# Anchor every path to this Makefile's own location so it runs identically regardless of CWD:
# MAKE_DIR = the directory holding this file (.../src-tauri/), ROOT = the repo root.
MAKE_DIR := $(dir $(abspath $(lastword $(MAKEFILE_LIST))))
ROOT     := $(abspath $(MAKE_DIR)..)

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
              -v "$(ROOT):$(WORK)" -v $(GRADLE_VOL):/opt/gradle -w $(WORK)

.PHONY: help image apk shell clean
help:  ## show this help
	@awk 'BEGIN{FS":.*## "} /^[a-zA-Z_-]+:.*## /{printf "  \033[36m%-8s\033[0m %s\n",$$1,$$2}' $(MAKEFILE_LIST)

image:  ## (re)build the builder image (standard sources; reuses host proxy if set)
	docker build -t $(IMAGE) $(PROXY_BUILD_ARGS) $(MAKE_DIR)

apk:  ## build frontend + release APK (no proxy needed once caches are warm)
	npm --prefix $(ROOT)/web run build
	$(DOCKER_RUN) $(IMAGE) cargo tauri android build --apk --config '{"build":{"beforeBuildCommand":""}}'
	@echo "✓ APK:"; @ls -1 $(ROOT)/src-tauri/gen/android/app/build/outputs/apk/universal/release/*.apk 2>/dev/null | sed 's/^/    /'

shell:  ## interactive shell in the builder
	$(DOCKER_RUN) -it $(IMAGE) bash

clean:  ## drop generated Android build outputs (keeps the gradle cache volume warm)
	rm -rf $(ROOT)/src-tauri/gen/android/.gradle $(ROOT)/src-tauri/gen/android/build $(ROOT)/src-tauri/gen/android/app/build
