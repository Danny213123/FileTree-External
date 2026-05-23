#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod analytics;
mod cli;
mod diff;
mod export;
mod io;
mod model;
mod scan;
mod server;

fn main() {
    cli::run();
}

#[cfg(windows)]
mod desktop;
