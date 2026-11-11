use super::Stage;
use std::ffi::c_void;

extern "C" {
    fn soms_windows_launch_install(window: *mut c_void, dark: bool) -> bool;
    fn soms_windows_launch_raise(window: *mut c_void);
    fn soms_windows_launch_present(window: *mut c_void, stage: i32, dark: bool, finished: bool);
}

// Native handles never leave the UI thread. The parent window owns the child
// launch page, including its cached bitmap. No platform timer owns readiness.
pub(super) fn install(window: *mut c_void, dark: bool) -> tauri::Result<()> {
    if unsafe { soms_windows_launch_install(window, dark) } {
        Ok(())
    } else {
        Err(std::io::Error::other("could not create Windows launch presentation").into())
    }
}
pub(super) fn raise(window: *mut c_void) {
    unsafe { soms_windows_launch_raise(window) };
}
pub(super) fn present(window: *mut c_void, stage: Stage, dark: bool, finished: bool) {
    let stage = match stage {
        Stage::Preparing => 0,
        Stage::Session => 1,
        Stage::Config => 2,
        Stage::Interface => 3,
        Stage::Slow => 4,
        Stage::Failed => 5,
    };
    unsafe { soms_windows_launch_present(window, stage, dark, finished) };
}

#[cfg(test)]
mod tests {
    use super::*;

    #[link(name = "user32")]
    extern "system" {
        fn CreateWindowExW(
            extended_style: u32,
            class: *const u16,
            title: *const u16,
            style: u32,
            x: i32,
            y: i32,
            width: i32,
            height: i32,
            parent: *mut c_void,
            menu: *mut c_void,
            instance: *mut c_void,
            parameter: *mut c_void,
        ) -> *mut c_void;
        fn DestroyWindow(window: *mut c_void) -> i32;
        fn GetPropW(window: *mut c_void, name: *const u16) -> *mut c_void;
        fn GetWindowLongW(window: *mut c_void, index: i32) -> i32;
        fn IsWindow(window: *mut c_void) -> i32;
        fn MoveWindow(
            window: *mut c_void,
            x: i32,
            y: i32,
            width: i32,
            height: i32,
            repaint: i32,
        ) -> i32;
        fn SendMessageW(window: *mut c_void, message: u32, wparam: usize, lparam: isize) -> isize;
        fn GetDC(window: *mut c_void) -> *mut c_void;
        fn ReleaseDC(window: *mut c_void, dc: *mut c_void) -> i32;
    }

    struct Parent(*mut c_void);
    impl Parent {
        fn new() -> Self {
            let class: Vec<u16> = "STATIC\0".encode_utf16().collect();
            let null = std::ptr::null_mut();
            let window = unsafe {
                CreateWindowExW(
                    0,
                    class.as_ptr(),
                    class.as_ptr(),
                    0,
                    0,
                    0,
                    800,
                    600,
                    null,
                    null,
                    null,
                    null,
                )
            };
            assert!(!window.is_null());
            Self(window)
        }
        fn page(&self) -> *mut c_void {
            let key: Vec<u16> = "SomsLaunchOverlay\0".encode_utf16().collect();
            unsafe { GetPropW(self.0, key.as_ptr()) }
        }
        fn paint(&self) {
            let page = self.page();
            unsafe {
                let dc = GetDC(page);
                assert!(!dc.is_null());
                // WM_PRINTCLIENT exercises the same cache as WM_PAINT without
                // showing a test window or depending on desktop message timing.
                SendMessageW(page, 0x0318, dc as usize, 0);
                ReleaseDC(page, dc);
            }
        }
    }
    impl Drop for Parent {
        fn drop(&mut self) {
            unsafe {
                DestroyWindow(self.0);
            }
        }
    }

    #[test]
    fn opaque_page_paints_resizes_and_hands_off_once() {
        let parent = Parent::new();
        install(parent.0, false).unwrap();
        let page = parent.page();
        assert!(!page.is_null());
        assert_eq!(unsafe { GetWindowLongW(page, -20) } & 0x0008_0000, 0); // No WS_EX_LAYERED.
        parent.paint();
        parent.paint(); // Reuse the backing bitmap.
        present(parent.0, Stage::Session, true, false);
        unsafe {
            MoveWindow(parent.0, 0, 0, 900, 700, 0);
        }
        parent.paint();
        present(parent.0, Stage::Slow, true, false);
        assert_eq!(parent.page(), page);
        present(parent.0, Stage::Interface, true, true);
        assert!(parent.page().is_null());
        assert_eq!(unsafe { IsWindow(page) }, 0);
        present(parent.0, Stage::Interface, true, true);
        raise(parent.0); // Late presentation calls are harmless.
    }

    #[test]
    fn closing_parent_releases_page_without_readiness() {
        let page = {
            let parent = Parent::new();
            install(parent.0, true).unwrap();
            present(parent.0, Stage::Failed, true, false);
            parent.paint();
            let page = parent.page();
            assert!(!page.is_null());
            page
        };
        assert_eq!(unsafe { IsWindow(page) }, 0);
    }
}
