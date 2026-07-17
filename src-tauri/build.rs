fn main() {
    tauri_build::build();
    fail_closed_on_release_dev_signing_key();
}

/// Fail-closed guard for the web-bundle signing contract.
///
/// The downloaded web SPA is Ed25519-verified against a pubkey pinned in the shell (`WEB_PUBKEY` in
/// lib.rs). The DEFAULT is a deterministic DEV keypair whose seed is public (it is derived from a fixed
/// marker in scripts/sign-web-bundle.mjs) so dev/debug iteration works with zero key setup. A RELEASE
/// shell that ships with that dev pubkey is an RCE hole: anyone can sign a bundle the shell will accept,
/// because the "secret" is public. So a release build (debug_assertions OFF) MUST override the pubkey via
/// `SOMS_WEB_PUBKEY_B64` (base64 32 bytes) — refusing to compile here is the only way to guarantee a
/// release shell never silently trusts the dev key.
///
/// `CARGO_CFG_DEBUG_ASSERTIONS` is set by cargo for build scripts exactly when debug_assertions is on
/// (debug profile: apk-debug) and unset for release ([profile.release] leaves debug_assertions at its
/// default false: apk). The Makefile's release `apk` target must therefore pass SOMS_WEB_PUBKEY_B64 into
/// the container cargo env; debug builds are exempt (the dev key is intentional there).
fn fail_closed_on_release_dev_signing_key() {
    let is_debug = std::env::var_os("CARGO_CFG_DEBUG_ASSERTIONS").is_some();
    let has_release_pubkey = std::env::var_os("SOMS_WEB_PUBKEY_B64")
        .map(|v| !v.is_empty())
        .unwrap_or(false);
    if !is_debug && !has_release_pubkey {
        panic!(
            "\n  ✗ RELEASE build of the SOMS shell refused: SOMS_WEB_PUBKEY_B64 is not set.\n    \
             The default web-bundle signing key is the PUBLIC dev keypair (its seed is in \
             scripts/sign-web-bundle.mjs) — a release shell trusting it would accept any bundle, RCE \
             included.\n    Generate a release Ed25519 keypair, then set:\n      \
             - SOMS_WEB_PUBKEY_B64=<base64 of the 32-byte pubkey> in the cargo/APK build env, AND\n      \
             - SHOMS_WEB_SIGNING_KEY=<base64 of the 32-byte seed> as the server image-build secret.\n    \
             (Debug/apk-debug builds are exempt — they intentionally use the dev key.)\n"
        );
    }
}
