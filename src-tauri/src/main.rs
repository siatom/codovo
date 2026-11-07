// Prevents additional console window on Windows in release, DO NOT REMOVE!!
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]
#![allow(linker_messages)]

fn main() {
    #[cfg(windows)]
    {
        let mut args = std::env::args_os().skip(1);
        if args.next().as_deref() == Some(std::ffi::OsStr::new("--codovo-acp-host")) {
            std::process::exit(codovo_lib::run_acp_host(args.collect()));
        }
    }
    codovo_lib::run()
}
