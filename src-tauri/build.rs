fn main() {
    if std::env::var("CARGO_CFG_TARGET_OS").as_deref() == Ok("android") {
        // NDK r27 and older linkers otherwise use 4 KB ELF LOAD alignment.
        // Android shared libraries must also load on devices with 16 KB pages.
        println!("cargo:rustc-link-arg-cdylib=-Wl,-z,max-page-size=16384");
    }
    #[cfg(target_os = "macos")]
    {
        if std::env::var("CARGO_CFG_TARGET_OS").as_deref() == Ok("macos") {
            cc::Build::new()
                .file("src/native_db/macos_notifications.m")
                .flag("-fobjc-arc")
                .flag("-fblocks")
                .compile("soms_notifications");
            cc::Build::new()
                .file("src/launch/macos.m")
                .flag("-fobjc-arc")
                .flag("-fblocks")
                .compile("soms_launch");
            println!("cargo:rustc-link-lib=framework=QuartzCore");
            println!("cargo:rerun-if-changed=src/launch/macos.m");
            println!("cargo:rustc-link-lib=framework=Foundation");
            println!("cargo:rustc-link-lib=framework=AppKit");
            println!("cargo:rustc-link-lib=framework=UserNotifications");
            println!("cargo:rerun-if-changed=src/native_db/macos_notifications.m");
        }
    }
    tauri_build::build();
}
