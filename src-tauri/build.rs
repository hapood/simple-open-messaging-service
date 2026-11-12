fn main() {
    if std::env::var("CARGO_CFG_TARGET_OS").as_deref() == Ok("windows") {
        cc::Build::new()
            .cpp(true)
            .file("src/launch/windows.cpp")
            .flag("/utf-8")
            .flag("/std:c++17")
            .compile("soms_launch");
        println!("cargo:rustc-link-lib=gdiplus");
        println!("cargo:rustc-link-lib=comctl32");
        println!("cargo:rerun-if-changed=src/launch/windows.cpp");
        // Tauri embeds the application manifest in binaries, but not the library
        // test harness. Tests also link GUI APIs that require Common Controls v6.
        println!("cargo:rustc-link-arg=/MANIFEST:EMBED");
        // The application binary already receives its manifest as a Tauri
        // resource. Do not generate a second resource with the same ID.
        println!("cargo:rustc-link-arg-bins=/MANIFEST:NO");
        println!(
            "cargo:rustc-link-arg=/MANIFESTDEPENDENCY:type='win32' name='Microsoft.Windows.Common-Controls' version='6.0.0.0' processorArchitecture='*' publicKeyToken='6595b64144ccf1df' language='*'"
        );
    }
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
    let attributes = tauri_build::Attributes::new();
    #[cfg(target_os = "windows")]
    let attributes = attributes.windows_attributes(
        tauri_build::WindowsAttributes::new()
            .app_manifest(include_str!("src/launch/windows.manifest")),
    );
    tauri_build::try_build(attributes).expect("Tauri build setup failed");
}
