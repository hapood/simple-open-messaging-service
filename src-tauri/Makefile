# SOMS native client builder — Android (LINUX host, docker-based) + macOS (native Mac host). Sits next
# to the Dockerfile it builds and produces signed Android APKs on a Linux (Ubuntu/Debian) host; macOS
# .app/.dmg are built natively on a Mac (macOS can't be cross-built on Linux — needs hdiutil/codesign +
# the macOS SDK). Windows / Linux-desktop artifacts are NOT built here — each needs its own native host;
# they slot into dist/<platform>/ later.
#
#   make image      — (re)build the self-contained builder image (one-time, ~20 min cold).
# Build types (all land in dist/android/ as soms-<ver>[-debug]-<abi>.apk; future: apk-aab/AAB):
#   make apk        — RELEASE APKs, per-ABI + universal (release-signed via gen/android keystore.properties).
#   make apk-debug  — DEBUG APKs (stable debug key, no minify, dev web build w/ sourcemaps — fastest iteration).
#   make install    — adb install -r the newest built APK (dist/android/ preferred) onto a device.
#   make run        — install + launch the app on the connected device.
#   make shell      — interactive shell in the builder (debugging).
#   make clean      — drop generated Android build outputs (keeps the gradle cache volume warm).
#   make help       — this list.
# macOS desktop (native Mac host — no Docker):
#   make macos      — universal RELEASE .app + .dmg into dist/macos/ (ad-hoc signed; APPLE_SIGNING_IDENTITY for real).
#   make macos-run  — open the newest built SOMS.app.
#   make dev        — cargo tauri dev (hot-reload; beforeDevCommand runs ng serve on :4200).
#
# Variants: by default `make apk` builds ONE universal APK (bundles exactly MULTI_ABIS = aarch64
# armv7) → dist/android/soms-<ver>-universal.apk. The universal variant compiles every ABI in
# MULTI_ABIS, so it alone covers all real devices (x86/x86_64 are emulator-only and left out — keeps
# the universal ~half the size of a 4-ABI build). Set SPLIT=1 to ALSO emit per-ABI APKs
# (soms-<ver>-arm64-v8a.apk / -armeabi-v7a.apk) for Play-Store-style per-device distribution;
# ABI=<arch> builds just that one.
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
CARGO_VOL  := soms-cargo
WORK       := /work

# Per-ABI variants built by the default `make apk`. The universal variant bundles EXACTLY these
# (repeated --target), so this list is the single knob for the whole variant set — override e.g.
# `make apk MULTI_ABIS="aarch64"` for arm64-only (the universal then degenerates to arm64 too).
MULTI_ABIS := aarch64 armv7
# Build variants: ABI=<arch> → just that one; otherwise default to ONE universal APK (bundles exactly
# MULTI_ABIS) — enough for sideloading + most distribution, and 3× fewer gradle assembles than per-ABI
# splits + universal (the universal variant already compiles every ABI in MULTI_ABIS, so per-ABI
# variants only add redundant packaging). Set SPLIT=1 to ALSO emit per-ABI APKs (arm64-v8a /
# armeabi-v7a) for Play-Store-style per-device distribution.
VARIANTS   := $(if $(ABI),$(ABI),$(if $(SPLIT),$(MULTI_ABIS) universal,universal))
# Skip the merged-SPA `ng build` when it is already built (WEB_BUILD=0). The APK bundles the SPA
# (frontendDist → web/dist/web/browser); OTA bundle updates are downloaded + sha256-verified at runtime.
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

# Mount the cargo registry cache (CARGO_HOME=/cargo, baked in the image) on a named volume so the
# registry index + downloaded .crate sources PERSIST across the ephemeral --rm runs. Without this,
# every `make apk` re-fetches the index + any crate whose version changed since the image was built —
# the image's baked /cargo is seeded into the volume on first attach (Docker named-volume init), then
# updated in place. THIS is what makes a warm `make apk` genuinely network-free: the image alone can't,
# because --rm discards each run's fetches. Mirrors the soms-gradle volume. Only the FIRST build after
# a Cargo.lock change touches the network — set HTTP_PROXY=http://localhost:7892 (or your mirror) for
# that one; later warm builds need neither proxy nor network.
DOCKER_RUN := docker run --rm --user "$$(id -u):$$(id -g)" -e HOME=/tmp \
              $(PROXY_RUN_FLAGS) $(CLEAR_JAVA_PROXY) \
              -v "$(ROOT):$(WORK)" -v $(CARGO_VOL):/cargo -v $(GRADLE_VOL):/opt/gradle -w $(WORK)

.PHONY: help image apk apk-debug shell install run clean macos macos-run dev
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
	@# Frontend build (host-side): the merged SPA (frontendDist → web/dist/web/browser). The APK bundles
	@# it as the baseline; OTA bundle updates are downloaded + sha256-verified at runtime (built +
	@# packaged server-side by scripts/package-web-bundle.mjs in the Docker image, served from
	@# app_data_dir/web/<active>/ via Context::set_assets). Run on the HOST (the builder container has only
	@# bare nodejs), then blank beforeBuildCommand in-container (cargo line below) so tauri doesn't re-run
	@# npm. tauri.conf.json stays the spec. Debug builds compile the SPA in the Angular "development"
	@# configuration (sourcemaps on, unminified) so the webview JS is debuggable; release uses "production".
	$(if $(filter 1,$(WEB_BUILD)),npm --prefix $(ROOT)/web run build -- --configuration $(if $(filter debug,$(1)),development,production))
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
	  $(DOCKER_RUN) $(IMAGE) cargo tauri android build --apk $$dbflag $$targs --config '{"build":{"beforeBuildCommand":""}}' >/dev/null; \
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
	@# Also clear app/src/main/jniLibs: tauri symlinks target/<abi>/libsoms_client_lib.so there per build,
	@# so ABIs from prior multi-arch builds linger across a single-arch `make apk ABI=…`. Harmless (gradle's
	@# --target filters at packaging — verified the APK reads ABIs:[arm64-v8a] despite stale siblings) but
	@# tidy to reset. Tauri recreates the dir on the next build; the .so are gitignored.
	rm -rf $(ROOT)/src-tauri/gen/android/.gradle $(ROOT)/src-tauri/gen/android/build \
	  $(ROOT)/src-tauri/gen/android/app/build $(ROOT)/src-tauri/gen/android/app/src/main/jniLibs

# ─── macOS desktop (native host — no Docker; macOS can't be cross-built on Linux) ──────────────
# Universal binary (Intel x86_64 + Apple Silicon aarch64) via `--target universal-apple-darwin`
# (Tauri compiles each arch then lipo-merges into ONE .app + .dmg). Requires both Apple rust targets
# (rustup target add aarch64-apple-darwin x86_64-apple-darwin) + Xcode Command Line Tools. Runs straight
# on the host — no container (unlike the Android path), so beforeBuildCommand (ng build) runs natively.
#
# Signing: config defaults to ad-hoc ("-" — launches locally + on Apple Silicon, no Apple cert needed).
# Real distribution just exports APPLE_SIGNING_IDENTITY="Developer ID Application: …", which OVERRIDES
# the config value (Tauri env-vars ref). Notarization additionally needs APPLE_ID + APPLE_PASSWORD +
# APPLE_TEAM_ID — intentionally NOT set for personal/local use.
#
# macOS find is BSD and lacks -printf (the Android recipes use GNU find inside their Linux container);
# artifact discovery here uses `ls -t` instead — safe because bundle filenames have no spaces.
MAC_DIST_DIR := $(MAKE_DIR)dist/macos
MAC_BUNDLE   := $(MAKE_DIR)target/universal-apple-darwin/release/bundle

define do_macos
	@# Version gate — same single-source-of-truth assertion as the Android do_build.
	@if [ "$(VERSION)" != "$(CARGO_VER)" ]; then echo "✗ version drift: tauri.conf.json=$(VERSION) vs Cargo.toml=$(CARGO_VER) — set both (tauri.conf.json is the SoT)."; exit 1; fi
	@# Both Apple targets must be installed (universal-apple-darwin compiles each, then lipo-merges).
	@for t in aarch64-apple-darwin x86_64-apple-darwin; do \
	  rustup target list --installed 2>/dev/null | grep -qx "$$t" || { echo "✗ missing rust target $$t — run: rustup target add aarch64-apple-darwin x86_64-apple-darwin"; exit 1; }; \
	done
	@# Ad-hoc ("-", the committed signingIdentity) by default — launches locally AND on Apple Silicon
	@# without a Developer cert (arm64 needs at least ad-hoc signing to run). Real distribution just
	@# exports APPLE_SIGNING_IDENTITY="Developer ID Application: ...", which OVERRIDES the config value.
	@# Notarization additionally needs APPLE_ID + APPLE_PASSWORD + APPLE_TEAM_ID — unset for local use.
	@if [ -n "$$APPLE_SIGNING_IDENTITY" ]; then echo "▶ macOS universal · signing with APPLE_SIGNING_IDENTITY ($$APPLE_SIGNING_IDENTITY)"; \
	 else echo "▶ macOS universal · ad-hoc signing (signingIdentity \"-\" — local/personal use)"; fi
	@# beforeBuildCommand (npm --prefix web run build) runs natively on this host, so (unlike the Android
	@# container) we let Tauri run it directly — EXCEPT WEB_BUILD=0 blanks it (dev: web served live).
	@cfg=; [ "$(WEB_BUILD)" != 1 ] && cfg='--config {"build":{"beforeBuildCommand":""}}'; \
	cargo tauri build --target universal-apple-darwin $$cfg
	@mkdir -p $(MAC_DIST_DIR); set -e; \
	dmg=$$(ls $(MAC_BUNDLE)/dmg/*.dmg 2>/dev/null | head -1); \
	app=$$(ls -d $(MAC_BUNDLE)/macos/*.app 2>/dev/null | head -1); \
	test -f "$$dmg" -a -d "$$app" || { echo "  ✗ no .app/.dmg produced under $(MAC_BUNDLE)"; exit 1; }; \
	bin=$$(find "$$app/Contents/MacOS" -type f | head -1); \
	archs=$$(lipo -archs "$$bin"); \
	echo "✓ universal arches: $$archs"; \
	case "$$archs" in *x86_64*arm64*|*arm64*x86_64*) ;; *) echo "  ✗ not universal: $$archs"; exit 1;; esac; \
	cp -R "$$app" "$(MAC_DIST_DIR)/SOMS-$(VERSION)-universal.app"; \
	cp "$$dmg" "$(MAC_DIST_DIR)/SOMS-$(VERSION)-universal.dmg"; \
	echo "✓ $(MAC_DIST_DIR)/:"; ls -lh $(MAC_DIST_DIR)/*.dmg 2>/dev/null | awk '{print "    "$$5"  "$$NF}'
endef

macos:  ## build universal macOS .app + .dmg into dist/macos/ (ad-hoc; APPLE_SIGNING_IDENTITY for real)
	$(call do_macos)

macos-run:  ## open the newest built SOMS.app (dist/macos/ preferred, else raw bundle)
	@APP=$$(ls -dt $(MAC_DIST_DIR)/*.app $(MAC_BUNDLE)/macos/*.app 2>/dev/null | head -1); \
	test -n "$$APP" || { echo "No SOMS.app found — run 'make macos' first."; exit 1; }; \
	echo "opening: $$APP"; open "$$APP"

dev:  ## run the desktop app in dev mode (cargo tauri dev — ng serve on :4200 + hot-reload)
	cargo tauri dev
