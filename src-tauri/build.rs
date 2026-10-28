fn main() {
    #[cfg(target_os = "macos")]
    {
        if std::env::var("CARGO_CFG_TARGET_OS").as_deref() == Ok("macos") {
            cc::Build::new()
                .file("src/native_db/macos_notifications.m")
                .flag("-fobjc-arc")
                .flag("-fblocks")
                .compile("soms_notifications");
            println!("cargo:rustc-link-lib=framework=Foundation");
            println!("cargo:rustc-link-lib=framework=AppKit");
            println!("cargo:rustc-link-lib=framework=UserNotifications");
            println!("cargo:rerun-if-changed=src/native_db/macos_notifications.m");
        }
    }
    tauri_build::build();
}
