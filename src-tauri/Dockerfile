# Self-contained Android APK release builder for the SOMS Tauri shell — STANDARD sources, reuses
# the host's proxy env vars (no hardcoding).
#
# One-time `make image` bakes in EVERYTHING the APK build needs: JDK, Android SDK/NDK, the Rust
# toolchain + 4 android targets, tauri-cli, every Rust crate pre-fetched, and node. Subsequent
# `make apk` runs then `docker run` with ZERO Rust/SDK fetch (gradle deps are the one exception,
# cached in the `soms-gradle` named volume after the first build). This image IS the persistence
# layer — rebuild only when Cargo.lock / SDK versions change.
#
# Proxy: the Makefile forwards the calling shell's HTTP_PROXY/HTTPS_PROXY/NO_PROXY straight through
# (`docker build --build-arg HTTPS_PROXY ...`, `docker run -e HTTPS_PROXY ...`). If your shell has a
# proxy, curl/cargo/apt use it; if not, everything goes direct. sdkmanager is Java and ignores env
# proxies anyway — it always goes direct (which is what we want: a proxy mangles its large NDK TLS
# transfer). No JAVA_TOOL_OPTIONS hook on purpose (that was the source of the gradle TLS failures).
#
# Scope: docker covers Android only. Windows EXE + macOS DMG are built natively — macOS CANNOT be
# cross-built on Linux (needs hdiutil/codesign + the macOS SDK).
#
# Android versions are pinned to what gen/android expects (from app/build.gradle.kts):
#   compileSdk/targetSdk = 36, minSdk 24, AGP 8.11.0, Kotlin 1.9.25, Gradle 8.14.3.
#   NDK r27b (27.1.12297006). No webkit2gtk/gtk (the android target compiles against the Android
#   WebView, not the Linux desktop stack — confirmed lean).

FROM ubuntu:24.04

ARG RUST_TOOLCHAIN=stable
# tauri-cli is versioned separately from the tauri lib and tops out one patch behind (lib 2.11.5 →
# cli 2.11.4); same 2.11 series, compatible.
ARG TAURI_CLI_VERSION=2.11.4

# Reuse the host proxy env (forwarded by the Makefile via --build-arg). Default empty = direct.
ARG HTTP_PROXY
ARG HTTPS_PROXY
ARG NO_PROXY

# Android versions (match gen/android).
ARG ANDROID_SDK_VERSION=36
ARG ANDROID_NDK_VERSION=27.1.12297006
ARG CMDLINE_TOOLS_ZIP=commandlinetools-linux-11076708_latest.zip

ENV DEBIAN_FRONTEND=noninteractive \
    CARGO_HOME=/cargo \
    RUSTUP_HOME=/rustup \
    PATH=/cargo/bin:${PATH} \
    JAVA_HOME=/usr/lib/jvm/java-17-openjdk-amd64 \
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

# 2a) Rust toolchain + the 4 android targets (curl/rustup read https_proxy from the ENV above).
#     Its own layer so a tauri-cli bump doesn't re-download the toolchain.
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
#     platform-tools). curl pulls cmdline-tools through the forwarded proxy; sdkmanager is Java and
#     ignores env proxies (goes direct — the proxy mangles its large NDK TLS transfer). Split from
#     the perm fix so a later chmod tweak never re-downloads the SDK. build-tools are left for AGP to
#     fetch on first APK build (small, cached in the gradle volume).
RUN mkdir -p ${ANDROID_HOME}/cmdline-tools \
    && curl -sSf -o /tmp/cmdline-tools.zip \
        https://dl.google.com/android/repository/${CMDLINE_TOOLS_ZIP} \
    && unzip -q /tmp/cmdline-tools.zip -d ${ANDROID_HOME}/cmdline-tools \
    && mv ${ANDROID_HOME}/cmdline-tools/cmdline-tools ${ANDROID_HOME}/cmdline-tools/latest \
    && rm /tmp/cmdline-tools.zip \
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

# Node.js — Tauri's Android gradle BuildTask (buildSrc/BuildTask.kt) runs the JS tauri CLI via
# `node tauri android android-studio-script`. This is independent of the frontend (pre-built on the
# host). Added as the last layer so adding it doesn't invalidate the expensive cached layers above.
RUN apt-get update \
    && apt-get install -y --no-install-recommends nodejs \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /work
