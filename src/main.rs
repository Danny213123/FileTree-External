mod analytics;
mod audit;
mod cli;
mod diff;
mod dupes;
mod export;
mod io;
mod model;
mod preflight;
mod recycle;
mod scan;
mod server;
#[cfg(windows)]
mod settings;

fn main() {
    cli::run();
}
