// Desktop entry point. Desktop is not a supported deployment, but the shell
// still runs there so the Rust side can be checked and smoke-run without a
// phone. Mobile enters through `svastha_mobile_lib::run` instead.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    svastha_mobile_lib::run()
}
