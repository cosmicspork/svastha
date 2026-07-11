//! Thin CLI wrapper around `svastha_devtool::run`. See the crate doc comment
//! (`lib.rs`) and `.env.example` at the repo root for what this does and how
//! to configure it. Run via `just decrypt`.

use std::path::PathBuf;

use anyhow::{anyhow, Context, Result};
use svastha_devtool::{run, Config};

fn main() -> Result<()> {
    let mnemonic = std::env::var("SVASTHA_MNEMONIC").map_err(|_| {
        anyhow!("SVASTHA_MNEMONIC is not set — copy .env.example to .env and fill it in")
    })?;
    let relay_url = std::env::var("SVASTHA_RELAY_URL").map_err(|_| {
        anyhow!("SVASTHA_RELAY_URL is not set — copy .env.example to .env and fill it in")
    })?;
    let out_dir = match std::env::var("SVASTHA_DECRYPT_OUT") {
        Ok(dir) => PathBuf::from(dir),
        Err(_) => PathBuf::from("private/decrypt"),
    };

    let summary = run(&Config {
        relay_url,
        mnemonic,
        out_dir,
    })
    .context("decrypt failed")?;

    println!("{summary}");
    Ok(())
}
