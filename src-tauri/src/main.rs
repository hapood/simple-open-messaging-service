// Prevents an additional command window from popping up on Windows in release builds.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    soms_app_lib::run()
}
