# SOMS desktop shell (Tauri v2)

A thin native shell around the Angular consumer client in `../web`. Same frontend, talking to a
remote backend over the network instead of being served same-origin by NestJS.

## How it fits together

| Concern | Mechanism |
|---|---|
| Where the API is | `SOMS_API_ORIGIN` env (default `http://localhost:3000`). Injected into the webview as `window.__SOMS_API_ORIGIN__` by an initialization script **before Angular boots**; read once at module load by `web/src/app/services/runtime.ts` → `constants.ts` → every `apiPrefix`/`sseUrl`. |
| API + SSE auth | Bearer `Authorization` header (the Angular `AuthInterceptor` + the SSE worker already send it). The backend's CORS is fully open (reflects any Origin), so the cross-origin webview is admitted without configuration. |
| `/uploads/*` media auth | A `media://localhost` custom URI scheme registered in `src/lib.rs` proxies to `${SOMS_API_ORIGIN}/uploads/*`, injecting `Authorization: Bearer`. The frontend rewrites bare `/uploads/...` URLs to `media://localhost/...` via `assetUrl()` (browser path unchanged). Bare `<img src>`/CSS `url()` can't set headers and the `media_token` cookie is `SameSite=Strict` (no cross-origin), so the proxy is the only correct path. |
| Token handoff | The frontend calls `window.__TAURI__.core.invoke('set_access_token', { token })` on login/renew and `clear_access_token` on logout (see `AuthService`). Stored in `ProxyState` for the proxy. |

## Android build (primary client target)

The Android APK is built via `src-tauri/Makefile` directly on a Linux host (no Docker — it uses the
host's own JDK / Android SDK / NDK / Rust toolchain). Run `make help` for the full surface; the
build-type taxonomy (all land in `dist/android/`):

| Command | Output |
|---|---|
| `make apk` | release APKs → `dist/android/soms-<ver>-<abi>.apk` (release-signed when `keystore.properties` present) |
| `make apk-debug` | debug APKs (stable debug key, no minify — fastest iteration) |
| `make install` / `make run` | `adb install -r` (+ launch) the newest APK |

Artifacts land under `dist/<platform>/` (`dist/android/` and `dist/macos/` now; `dist/{linux,windows}/`
slot in when those desktop hosts are wired). The build runs natively, so the cargo (`~/.cargo`) and
gradle (`~/.gradle`) caches persist across runs; the first build after a `Cargo.lock` change fetches
crates (set `HTTP_PROXY`/`HTTPS_PROXY` or a `~/.cargo/config.toml` mirror if behind a proxy), and later
warm builds need no network. Gradle is Java and ignores the `*_proxy` env vars; if your shell has a
proxy, apply it to Gradle via a `~/.gradle/init.d/` init script that reads `$HTTPS_PROXY` (the host is
set up this way) — the Makefile hardcodes no proxy.

### Android one-time host prerequisites

The build runs on the host, so the toolchain must be installed locally (all on `PATH`):

```bash
rustup target add aarch64-linux-android armv7-linux-androideabi x86_64-linux-android i686-linux-android
# JDK 17, Android SDK (ANDROID_HOME), NDK r27b (27.1.12297006) — via Android Studio or sdkmanager
cargo install tauri-cli --version 2.11.4 --locked        # PIN to web/package.json @tauri-apps/cli
npm --prefix web install                                  # so beforeBuildCommand (ng build) works
```

`tauri-cli` here is the `cargo tauri` binary. Pin it to `2.11.4` to match `web/package.json`'s
`@tauri-apps/cli` — the same version-drift guard the Makefile's host-toolchain check enforces.
### `gen/android` is tracked; signing keys are secrets

`gen/android/` — the customized Android Studio project (FCM, Kotlin bridges, the dev shell, signing
config) — **is version-controlled** (Tauri's default; only `gen/schemas` is gitignored), so a fresh
clone builds without `tauri android init`. **Signing keys are NOT committed** (gitignored in-tree via
`gen/android/.gitignore`):

- **Debug** keystore auto-generates on first `make apk-debug` (stable across rebuilds → `adb install -r`
  works; a one-time uninstall is needed only when the debug key changes).
- **Release** keystore + `gen/android/keystore.properties` are **secrets** — back them up out-of-band
  and restore them to `gen/android/` on a fresh clone.

The tag-triggered GitHub Release workflow builds signed `arm64-v8a`, `armeabi-v7a`, and `x86_64`
APKs. Configure these repository Actions secrets before creating a `v<package.version>` tag:

- `ANDROID_KEYSTORE_BASE64`: base64 encoding of the release keystore file
- `ANDROID_KEYSTORE_PASSWORD`: keystore password
- `ANDROID_KEY_ALIAS`: signing key alias
- `ANDROID_KEY_PASSWORD`: signing key password

The workflow reconstructs the ignored signing files only inside its temporary runner, publishes the
three APKs plus `SHA256SUMS`, and never uploads the keystore.

See `FCM_ANDROID_PATCH.md` for the native-side (FCM, bridges, dev shell) details.

## macOS desktop build (wired)

The universal macOS bundle (`.app` + `.dmg`, covers Intel x86_64 + Apple Silicon aarch64) is built
natively on a Mac via `src-tauri/Makefile` — no Docker, because macOS can't be cross-built on Linux
(needs `hdiutil`/`codesign` + the macOS SDK). It reuses the same pipeline discipline as Android: version
gate, `WEB_BUILD`, versioned artifacts under `dist/<platform>/` (`dist/macos/` here).

| Command | Output |
|---|---|
| `make macos` | universal `.app` + `.dmg` → `dist/macos/SOMS-<ver>-universal.{app,dmg}` (ad-hoc signed; export `APPLE_SIGNING_IDENTITY` for a real Developer ID) |
| `make macos-run` | open the newest built `SOMS.app` |
| `make dev` | `cargo tauri dev` — hot-reload (`ng serve` on :4200) |
| `SOMS_API_ORIGIN=http://host:3000 make dev` | dev against a non-local backend |

Ad-hoc signing (`bundle.macOS.signingIdentity: "-"` in `tauri.conf.json`) launches locally and on Apple
Silicon with no Apple Developer cert — arm64 requires at least ad-hoc signing to run. For public
distribution, export `APPLE_SIGNING_IDENTITY`, `APPLE_ID`, `APPLE_PASSWORD` (app-specific), and
`APPLE_TEAM_ID`, then `make macos` — Tauri notarizes automatically. See the Tauri v2 macOS signing guide.

### macOS one-time prerequisites

```bash
xcode-select --install                                      # clang, codesign, hdiutil, lipo
cargo install tauri-cli --version "^2.11.4" --locked        # PIN to web/package.json @tauri-apps/cli
rustup target add aarch64-apple-darwin x86_64-apple-darwin   # both arches for universal-apple-darwin
npm --prefix web install                                    # so beforeBuildCommand (ng build) works
```

`tauri-cli` here is the `cargo tauri` binary (NOT the `src-tauri/tauri.js` node shim, which is
Android-gradle-only). Pin it to `^2.11.4` to match `web/package.json`'s `@tauri-apps/cli` — the same
version-drift guard the Android host-toolchain check enforces.

## Linux / Windows desktop build (future — not wired)

> Linux (deb/appimage) and Windows (msi/exe) bundles remain **future** work — each needs its own native
> host (neither can be cross-built from the macOS host) and is not yet orchestrated. The industry-standard
> path is a `tauri-apps/tauri-action` CI matrix.

Tauri v2 desktop needs **`libwebkit2gtk-4.1`** (Ubuntu 22.04+ / Kylin V10 SP2). The Kylin V10 SP1 dev box
(20.04-based) only has `4.0`, so a Linux desktop build must run on a 22.04+ host. Install the system deps
there (`libwebkit2gtk-4.1-dev`, `libsoup-3.0-dev`, `libgtk-3-dev`, `libayatana-appindicator3-dev`), plus
the Rust toolchain and Tauri CLI (`cargo install tauri-cli --version "^2"`).

### China mirror / proxy (cargo)

Cargo fetches crates; to route through the local proxy or the Tsinghua sparse mirror, create
`~/.cargo/config.toml` on the build host:

```toml
[http]
proxy = "http://127.0.0.1:8080"

[registries.crates-io]
# Or use the mirror instead of (or alongside) the proxy:
# sparse = "https://mirrors.tuna.tsinghua.edu.cn/crates.io-index/"
```

## One-time: generate the bundle icons

`cargo tauri` requires icons under `icons/`. Generate all required sizes/formats from the source SVG:

```bash
cargo tauri icon ../public/logo.svg   # creates icons/{32x32,128x128,128x128@2x}.png, icon.icns, icon.ico
```

`cargo tauri icon` also resets the Android adaptive-icon foreground and XML
(`gen/android/.../ic_launcher_foreground.png`), but it scales the source SVG
**full-bleed** onto the 108dp canvas — it ignores the adaptive safe zone, so the
artwork without respecting the 66dp safe area, resets the background to white,
and drops the themed-icon layer. Restore all Android-specific assets afterwards:

```bash
icons/gen-android-foreground.sh   # needs rsvg-convert (librsvg)
```

## Run

```bash
# Dev: starts `ng serve` (../web on :4200) via beforeDevCommand, then opens the webview against it.
SOMS_API_ORIGIN=http://localhost:3000 cargo tauri dev

# Release: runs `npm --prefix web run build:native` via beforeBuildCommand,
# bundles ../web/dist/native/browser as assets (AOT, no runtime Angular compiler).
cargo tauri build
```

The NestJS backend must be running and reachable at `SOMS_API_ORIGIN`. No CORS configuration is
needed — the backend reflects any Origin:

```bash
node dist/src/main.js
```

## Known caveats

- **Capability permission errors.** The app-defined commands (`get_api_origin`, `set_access_token`,
  `clear_access_token`) are registered in `invoke_handler`. If `invoke(...)` from the frontend
  returns a permission error, add them to `capabilities/default.json` under `permissions` (e.g.
  `"allow-set-access-token"`) — the exact identifier depends on the Tauri version. `core:default`
  is enough on current v2.
- **CSP.** `connect-src` is intentionally broad (`https: http:`) because the backend origin is
  user-configurable at runtime; tighten it if you ship with a fixed backend URL.
- **Media proxy is `/uploads/*` only.** Non-upload origins passed to `assetUrl()` pass through
  unchanged (data:/blob:/http(s):).
