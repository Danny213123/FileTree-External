mod analytics;
mod audit;
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
mod xlsx;

fn main() {
    cli::run();
}
