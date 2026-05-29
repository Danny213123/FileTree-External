mod analytics;
mod cli;
mod diff;
mod dupes;
mod export;
mod io;
mod model;
mod scan;
mod server;
#[cfg(windows)]
mod settings;

fn main() {
    cli::run();
}
