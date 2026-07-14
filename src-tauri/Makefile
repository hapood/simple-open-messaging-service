# SOMS Android APK builder — LINUX host, docker-based. Sits next to the Dockerfile it builds and
# produces signed Android APKs on a Linux (Ubuntu/Debian) host. macOS / Windows / Linux-desktop
# artifacts are NOT built here — macOS can't be cross-built on Linux (needs hdiutil/codesign + SDK),
# and desktop bundles need a native host (webkit2gtk-4.1); they slot into dist/<platform>/ later.
#
#   make image      — (re)build the self-contained builder image (one-time, ~20 min cold).
# Build types (all land in dist/android/ as soms-<ver>[-debug|-dev]-<abi>.apk; future: apk-aab/AAB):
#   make apk        — RELEASE APKs, per-ABI + universal (release-signed via gen/android keystore.properties).
#   make apk-debug  — DEBUG APKs (stable debug key, no minify — fastest iteration).
#   make apk-dev    — DEBUG APK loading a frontend dev server at runtime (on-device HMR; DEV_URL=).
#                     apk-dev == apk-debug with DEV_URL set — kept as a discoverable alias.
#   make install    — adb install -r the newest built APK (dist/android/ preferred) onto a device.
#   make run        — install + launch the app on the connected device.
#   make shell      — interactive shell in the builder (debugging).
#   make clean      — drop generated Android build outputs (keeps the gradle cache volume warm).
#   make help       — this list.
#
# Variants: by default `make apk` builds ONE apk per ABI in MULTI_ABIS (aarch64 armv7) PLUS a
# universal that bundles exactly those ABIs — so dist/android/ ends up with:
#   soms-<ver>-arm64-v8a.apk   soms-<ver>-armeabi-v7a.apk   soms-<ver>-universal.apk
# arm64-v8a + armeabi-v7a cover ~every real Android device; x86/x86_64 are emulator-only and left
# out (keeps the universal ~half the size of a 4-ABI build). All three reuse the cached rust targets
# inside the image, so a warm multi-variant run is just N gradle assembles.
#
# Single-arch fast build: `make apk ABI=aarch64` builds ONLY that variant (~4× faster/smaller than
# the full set). Valid ABI values: aarch64 armv7 i686 x86_64. Example: `make apk-debug ABI=aarch64 run`.
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

# Builder image. Its baked tauri-cli (Dockerfile TAURI_CLI_VERSION) MUST match web/package.json's
# @tauri-apps/cli — move them together or the container CLI and the host `tauri dev` CLI diverge.
IMAGE      := soms-android-build:24.04
GRADLE_VOL := soms-gradle
WORK       := /work

# Per-ABI variants built by the default `make apk`. The universal variant bundles EXACTLY these
# (repeated --target), so this list is the single knob for the whole variant set — override e.g.
# `make apk MULTI_ABIS="aarch64"` for arm64-only (the universal then degenerates to arm64 too).
MULTI_ABIS := aarch64 armv7
# Build variants: ABI=<arch> → just that one; otherwise per-ABI + universal.
VARIANTS   := $(if $(ABI),$(ABI),$(MULTI_ABIS) universal)
# Optional frontend dev-server URL for `apk-dev`: baked into the APK as the compiled-in default
# (Rust option_env!("SOMS_DEFAULT_DEV_URL"), read at boot — see src-tauri/src/lib.rs) so a freshly
# installed dev APK goes straight to the dev server with zero config. Empty for apk/apk-debug.
# Example: make apk-dev ABI=aarch64 DEV_URL=http://192.168.2.7:4200
DEV_URL    ?=
# Skip the production `ng build` when the frontend is served LIVE by `ng serve` elsewhere (dev-shell
# testing): ng build and ng serve share .angular/cache and concurrent runs can corrupt it. The bundled
# frontend stays as-is from the last full build (the dev shell loads the dev server, not the bundle).
# WEB_BUILD=0 to skip.
WEB_BUILD  ?= 1
# Versioned APKs (gitignored) land under dist/<platform>/ — Android here (dist/android/). Raw gradle
# output stays under gen/android/app/build (ignored in-tree by gen/android/.gitignore). Future desktop
# builds slot into dist/{linux,windows,macos}/ without touching this Makefile's Android recipes.
DIST_DIR   := $(MAKE_DIR)dist/android
# Version: tauri.conf.json is the single source of truth (gen/android/.../tauri.properties is
# auto-generated from it). CARGO_VER mirrors Cargo.toml [package].version; do_build asserts equality
# so the two can't silently drift.
VERSION    := $(shell sed -n 's/.*"version"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' $(MAKE_DIR)tauri.conf.json)
CARGO_VER  := $(shell sed -n 's/^version[[:space:]]*=[[:space:]]*"\([^"]*\)".*/\1/p' $(MAKE_DIR)Cargo.toml | head -1)
# Raw gradle APK output (single shared path regardless of --target — every variant overwrites it,
# so do_build copies each to a versioned dist/ name before the next variant builds).
RAW_APK_DIR := $(ROOT)/src-tauri/gen/android/app/build/outputs/apk
# Used by install/run to locate the newest APK across raw output AND dist/.
APK_FIND := find $(RAW_APK_DIR) $(DIST_DIR) -name '*.apk'

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

.PHONY: help image apk apk-debug apk-dev shell install run clean
help:  ## show this help
	@awk 'BEGIN{FS=":.*## "} /^[a-zA-Z_-]+:.*## /{printf "  \033[36m%-12s\033[0m %s\n",$$1,$$2}' $(MAKEFILE_LIST)

image:  ## (re)build the builder image (standard sources; reuses host proxy if set)
	docker build -t $(IMAGE) $(PROXY_BUILD_ARGS) $(MAKE_DIR)

# apk_abis <apk-path> -> prints the native ABIs actually bundled inside an APK, read from its
# lib/<abi>/ entries (e.g. "x86_64", or "arm64-v8a armeabi-v7a"). Recipe-side (no $(shell)) so it
# runs in the same shell context that already holds the APK path.
#
# WHY this exists: Tauri's gradle build always uses the "universal" product flavor for BOTH debug
# and release, so every APK lands at .../apk/universal/<buildtype>/app-universal-<buildtype>.apk
# regardless of which `--target` ABIs were passed to `cargo tauri android build`. That --target
# filters at the cargo/NDK level (which native libs get compiled), NOT at gradle's split-APK level —
# so `make apk-debug ABI=x86_64` produces app-universal-debug.apk that bundles ONLY lib/x86_64/.
# The "universal" label on both the directory and the filename is then a lie for any single-ABI
# build, and `find -name 'app-x86_64-debug.apk'` finds nothing. The dist/ copy IS named honestly
# (soms-<ver>-debug-x86_64.apk); only the raw outputs/ path is misleading. We therefore read the
# truth back out of the APK and print it beside every path we surface, so a single-arch build can
# never be mistaken for a true universal regardless of the flavor/directory name.
define apk_abis
$$(unzip -l "$(1)" | grep -oE 'lib/[^/]+/' | sed 's#lib/##; s#/##' | sort -u | tr '\n' ' ' | sed 's/ $$//')
endef

# Shared variant-builder body for apk/apk-debug. $(1) = buildtype (release|debug). For each variant
# in VARIANTS it runs one tauri build (universal = --target repeated over MULTI_ABIS), then copies
# the newest APK of this buildtype from the raw gradle output into dist/ as
# soms-<version>[-debug]-<tag>.apk. Rust targets are cached in the image, so a warm run is just N
# gradle assembles. NOTE: no `@` after `;` — `@` is only a make quiet-prefix at line start; mid-line
# it is passed to the shell as a literal and fails with "command not found".
define do_build
	@# Single source of truth gate: tauri.conf.json version (VERSION) must equal Cargo.toml [package]
	@# version (CARGO_VER). Drift => the APK's embedded version disagrees with the Rust crate version.
	@if [ "$(VERSION)" != "$(CARGO_VER)" ]; then echo "✗ version drift: tauri.conf.json=$(VERSION) vs Cargo.toml=$(CARGO_VER) — set both (tauri.conf.json is the SoT)."; exit 1; fi
	@# Frontend build (host-side). Mirrors tauri.conf.json's beforeBuildCommand (npm --prefix web run
	@# build) — the SAME command — but runs on the HOST because the builder container has only bare
	@# nodejs (no web/node_modules). do_build then blanks beforeBuildCommand in-container (see the
	@# cargo line below) so tauri doesn't re-run npm inside the container. tauri.conf.json stays the spec.
	$(if $(filter 1,$(WEB_BUILD)),npm --prefix $(ROOT)/web run build,@true)
	@# Stable debug keystore (one-time): gitignored in-tree (gen/android/.gitignore: *.keystore) +
	@# host-mounted, so it persists across --rm builds and pins the debug signature (no more
	@# uninstall-per-rebuild). No-op once present.
	@ks=$(MAKE_DIR)gen/android/debug.keystore; \
	if [ ! -f "$$ks" ]; then \
	  echo "  generating stable debug keystore (one-time): gen/android/debug.keystore"; \
	  $(DOCKER_RUN) $(IMAGE) keytool -genkeypair -v \
	    -keystore $(WORK)/src-tauri/gen/android/debug.keystore \
	    -alias androiddebugkey -keyalg RSA -keysize 2048 -validity 10000 \
	    -storepass android -keypass android \
	    -dname "CN=Android Debug,O=Android,C=US" >/dev/null; \
	fi
	@mkdir -p $(DIST_DIR); set -e; \
	dbflag=; dsuffix=; [ "$(1)" = debug ] && { dbflag=--debug; dsuffix=-debug; }; \
	devUrlEnv=; capsArg=; \
	if [ -n "$(DEV_URL)" ]; then \
	  dsuffix=-dev; \
	  devUrlEnv="-e SOMS_DEFAULT_DEV_URL=$(DEV_URL)"; \
	  capsArg='--config {"app":{"security":{"capabilities":["default","dev-remote"]}}}'; \
	  echo "  dev shell -> frontend dev server: $(DEV_URL) (baked via SOMS_DEFAULT_DEV_URL)"; \
	  echo "  dev shell -> remote IPC enabled via 'dev-remote' capability (debug-only; release keeps [default])"; \
	fi; \
	for v in $(VARIANTS); do \
	  case "$$v" in \
	    aarch64)   tag=arm64-v8a;   targs="--target aarch64";; \
	    armv7)     tag=armeabi-v7a; targs="--target armv7";; \
	    i686)      tag=x86;         targs="--target i686";; \
	    x86_64)    tag=x86_64;      targs="--target x86_64";; \
	    universal) tag=universal;   targs="$(addprefix --target ,$(MULTI_ABIS))";; \
	    *) echo "  ✗ unknown variant: $$v"; exit 1;; \
	  esac; \
	  echo "▶ building [$(1)] $$tag"; \
	  $(DOCKER_RUN) $$devUrlEnv $(IMAGE) cargo tauri android build --apk $$dbflag $$targs --config '{"build":{"beforeBuildCommand":""}}' $$capsArg >/dev/null; \
	  built=$$(find $(RAW_APK_DIR) -name '*$(1).apk' -printf '%T@ %p\n' 2>/dev/null | sort -rn | head -1 | cut -d' ' -f2-); \
	  test -n "$$built" || { echo "  ✗ no APK produced for $$tag"; exit 1; }; \
	  out=$(DIST_DIR)/soms-$(VERSION)$$dsuffix-$$tag.apk; \
	  cp "$$built" "$$out"; \
	  echo "✓ $$(basename $$out)  ($$(du -h "$$built" | cut -f1))  ABIs: [$(call apk_abis,$$built)]"; \
	done
	@echo "✓ $(DIST_DIR)/:"; ls -lh $(DIST_DIR)/*.apk 2>/dev/null | awk '{print "    "$$5"  "$$NF}'
endef

apk:  ## build per-ABI + universal RELEASE APKs into dist/android/. ABI=aarch64 → one fast variant.
	$(call do_build,release)

apk-debug:  ## build DEBUG variants (debug-signed, no minify — fastest iteration).
	$(call do_build,debug)

apk-dev:  ## build a DEBUG APK that loads a frontend dev server at runtime (on-device HMR). Pass DEV_URL=http://host:port.
	$(call do_build,debug)

shell:  ## interactive shell in the builder
	$(DOCKER_RUN) -it $(IMAGE) bash

install:  ## adb install -r the newest built APK (dist/android/ preferred) onto a connected device
	@APK=$$($(APK_FIND) -printf '%T@ %p\n' 2>/dev/null | sort -rn | head -1 | cut -d' ' -f2-); \
	test -n "$$APK" || { echo "No APK found — run 'make apk' first."; exit 1; }; \
	echo "Installing: $$APK  ABIs: [$(call apk_abis,$$APK)]"; adb install -r "$$APK"

run: install  ## install then launch the app on the connected device
	@adb shell monkey -p com.soms.client -c android.intent.category.LAUNCHER 1 >/dev/null \
		&& echo "✓ launched com.soms.client"

clean:  ## drop generated Android build outputs (keeps the gradle cache volume warm)
	rm -rf $(ROOT)/src-tauri/gen/android/.gradle $(ROOT)/src-tauri/gen/android/build $(ROOT)/src-tauri/gen/android/app/build
