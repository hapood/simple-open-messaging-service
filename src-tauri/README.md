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

## Build host requirements (NOT satisfiable on Kylin V10 SP1)

Tauri v2 needs **`libwebkit2gtk-4.1`**, which only ships on Ubuntu 22.04+ / Kylin V10 SP2 / macOS /
Windows. The Kylin V10 SP1 dev box (20.04-based) only has `4.0`, so the binary must be built on a
22.04+ host. The system-deps install script lives at `../scripts/install-tauri-deps.sh` (proxy
baked in); run it on the build host:

```bash
sudo bash ../scripts/install-tauri-deps.sh   # prints whether 4.1 (v2 OK) or 4.0 (need newer OS)
```

Plus the Rust toolchain (`rustup` or `conda install -n easy-chart -c conda-forge rust`) and the
Tauri CLI: `cargo install tauri-cli --version "^2"`.

### China mirror / proxy (cargo)

Cargo fetches crates; to route through the local proxy or the Tsinghua sparse mirror, create
`~/.cargo/config.toml` on the build host:

```toml
[http]
proxy = "http://192.168.88.8:8080"

[registries.crates-io]
# Or use the mirror instead of (or alongside) the proxy:
# sparse = "https://mirrors.tuna.tsinghua.edu.cn/crates.io-index/"
```

## One-time: generate the bundle icons

`cargo tauri` requires icons under `icons/`. Generate all required sizes/formats from the source SVG:

```bash
cargo tauri icon ../public/logo.svg   # creates icons/{32x32,128x128,128x128@2x}.png, icon.icns, icon.ico
```

## Run

```bash
# Dev: starts `ng serve` (../web on :4200) via beforeDevCommand, then opens the webview against it.
SOMS_API_ORIGIN=http://localhost:3000 cargo tauri dev

# Release: runs `ng build` via beforeBuildCommand, bundles ../web/dist/web/browser as assets.
cargo tauri build
```

The NestJS backend must be running and reachable at `SOMS_API_ORIGIN`. No CORS configuration is
needed — the backend reflects any Origin:

```bash
npm run start:prod
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
