# Self-contained Android APK release builder for the SOMS Tauri shell — STANDARD sources only.
#
# One-time `docker build` bakes in EVERYTHING the APK build needs: JDK, Android SDK/NDK, the Rust
# toolchain + 4 android targets, tauri-cli, and every Rust crate pre-fetched. Subsequent builds then
# `docker run` with ZERO Rust/SDK fetch (gradle deps are the one exception, cached in a persistent
# volume so fetched just once). This image IS the persistence layer; rebuild only when Cargo.lock /
# SDK versions change. scripts/build-apk.sh wraps "build image if missing, then run it".
#
# All sources are the official defaults (crates.io, static.rust-lang.org, dl.google.com,
# archive.ubuntu.com) — NO baked-in regional mirror, so the image is fully portable. To accelerate
# the one-time build on a slow link, the build script overlays a local HTTP proxy at runtime via
# `docker build --network host --build-arg HTTP_PROXY/HTTPS_PROXY=...` (curl/cargo/apt read those),
# plus a JAVA_TOOL_OPTIONS hook below for sdkmanager/gradle (Java ignores the env proxy vars).
#
# Scope: docker covers Android only. Windows EXE + macOS DMG are built natively — macOS CANNOT be
# cross-built on Linux (needs hdiutil/codesign + the macOS SDK).
#
# Android versions are pinned to what gen/android expects (from app/build.gradle.kts):
#   compileSdk/targetSdk = 36, minSdk 24, AGP 8.11.0, Kotlin 1.9.25, Gradle 8.14.3.
#   NDK r27c (27.1.12297006) — Tauri v2's required NDK. No webkit2gtk/gtk (android target is lean).

FROM ubuntu:24.04

ARG RUST_TOOLCHAIN=stable
# tauri-cli is versioned separately from the tauri lib and tops out one patch behind (lib 2.11.5 →
# cli 2.11.4); same 2.11 series, compatible.
ARG TAURI_CLI_VERSION=2.11.4
# Proxy hooks — all default empty (= direct, standard sources). The build script overlays a local
# HTTP proxy via `docker build --network host --build-arg HTTPS_PROXY=...`. curl/cargo read the
# uppercase predefined args; apt reads lowercase (hence the ENV mirror below); sdkmanager/gradle are
# Java and ignore env proxies entirely, so they take JAVA_TOOL_OPTIONS.
ARG HTTP_PROXY
ARG HTTPS_PROXY
ARG NO_PROXY
ARG JAVA_TOOL_OPTIONS=""

# Android versions (match gen/android).
ARG ANDROID_SDK_VERSION=36
ARG ANDROID_NDK_VERSION=27.1.12297006
ARG CMDLINE_TOOLS_ZIP=commandlinetools-linux-11076708_latest.zip

ENV DEBIAN_FRONTEND=noninteractive \
    CARGO_HOME=/cargo \
    RUSTUP_HOME=/rustup \
    PATH=/cargo/bin:${PATH} \
    JAVA_HOME=/usr/lib/jvm/java-17-openjdk-amd64 \
    JAVA_TOOL_OPTIONS=${JAVA_TOOL_OPTIONS} \
    http_proxy=${HTTP_PROXY} \
    https_proxy=${HTTPS_PROXY} \
    no_proxy=${NO_PROXY} \
    ANDROID_HOME=/opt/android-sdk \
    ANDROID_SDK_ROOT=/opt/android-sdk \
    ANDROID_NDK_HOME=/opt/android-sdk/ndk/${ANDROID_NDK_VERSION} \
    ANDROID_NDK_ROOT=/opt/android-sdk/ndk/${ANDROID_NDK_VERSION} \
    GRADLE_USER_HOME=/opt/gradle

# 1) System: JDK 17 (gradle/AGP 8.11 require it) + build tools. No webkit/gtk (android target).
RUN apt-get update \
    && apt-get install -y --no-install-recommends \
        ca-certificates curl unzip xz-utils git \
        pkg-config build-essential \
        openjdk-17-jdk \
    && rm -rf /var/lib/apt/lists/*

# 2a) Rust toolchain + the 4 android targets. Reads HTTPS_PROXY (predefined docker build-arg) when
#     the script overlays a proxy. Kept its own layer so a tauri-cli bump doesn't re-download it.
RUN curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs \
    | sh -s -- -y --default-toolchain ${RUST_TOOLCHAIN} --profile minimal \
    && rustup target add aarch64-linux-android armv7-linux-androideabi x86_64-linux-android i686-linux-android \
    && chmod -R 777 /cargo /rustup

# 2b) tauri-cli (version-matched to the lib). Separate layer — cheap to re-pin.
RUN cargo install tauri-cli --version ${TAURI_CLI_VERSION} --locked

# Put cmdline-tools on PATH (sdkmanager is at .../cmdline-tools/latest/bin). Set AFTER the rustup /
# tauri-cli layers so a change here doesn't invalidate their (expensive) cache.
ENV PATH=/cargo/bin:${ANDROID_HOME}/cmdline-tools/latest/bin:${ANDROID_HOME}/platform-tools:${PATH}

# 3a) Android SDK + NDK — the expensive, cacheable install (NDK r27b 27.1.12297006 + android-36 +
#     platform-tools). sdkmanager runs under the JAVA_TOOL_OPTIONS proxy hook. Split from the perm
#     fix so a later chmod tweak never re-downloads the SDK. build-tools are left for AGP to fetch on
#     first run (small, cached in the gradle volume).
RUN mkdir -p ${ANDROID_HOME}/cmdline-tools \
    && curl -sSf -o /tmp/cmdline-tools.zip \
        https://dl.google.com/android/repository/${CMDLINE_TOOLS_ZIP} \
    && unzip -q /tmp/cmdline-tools.zip -d ${ANDROID_HOME}/cmdline-tools \
    && mv ${ANDROID_HOME}/cmdline-tools/cmdline-tools ${ANDROID_HOME}/cmdline-tools/latest \
    && rm /tmp/cmdline-tools.zip \
    && unset JAVA_TOOL_OPTIONS http_proxy https_proxy \
    && yes | sdkmanager --licenses > /dev/null \
    && sdkmanager "platform-tools" "platforms;android-${ANDROID_SDK_VERSION}" "ndk;${ANDROID_NDK_VERSION}" \
    && chmod -R 777 ${ANDROID_HOME}

# 3b) GRADLE_USER_HOME — the gradle cache is bind-mounted here (named volume) at runtime. Must exist
#     + be world-writable so a non-root `docker run --user` and the first named-volume population work.
RUN mkdir -p /opt/gradle && chmod 777 /opt/gradle

# 4) Pre-fetch every Rust crate into /cargo/registry so the release build fetches nothing. Pinned to
#    this Cargo.lock — rebuild the image when deps change.
COPY Cargo.toml Cargo.lock /work/src-tauri/
# Copy the real src/ so the manifest parses (the [lib] target needs src/lib.rs to exist). This copy
# is only used to parse the manifest during `cargo fetch` — at runtime the live repo is mounted over
# /work, so source edits never require rebuilding the image.
COPY src/ /work/src-tauri/src/
WORKDIR /work/src-tauri
RUN cargo fetch --locked \
    && chmod -R 777 /cargo

WORKDIR /work
