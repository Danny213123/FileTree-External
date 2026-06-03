mod analytics;
mod archive;
mod audit;
mod cleanup;
mod cli;
mod diff;
mod dupes;
mod export;
mod io;
mod json;
mod model;
mod owner;
mod preflight;
mod recycle;
mod scan;
mod schedule;
mod server;
#[cfg(windows)]
mod settings;
mod smartfolders;
mod snapshots;
mod tags;
mod xlsx;

fn main() {
    cli::run();
}
