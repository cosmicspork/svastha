//! Thin CLI wrapper around `svastha_devtool`. Three subcommands; see the crate
//! doc comment (`lib.rs`) and `.env.example` at the repo root.
//!
//! `decrypt` and `import` share `SVASTHA_MNEMONIC` + `SVASTHA_RELAY_URL`;
//! `accuracy` shares neither, and uses `SVASTHA_DEVTOOL_*` instead — it never
//! touches a relay or a real vault.
//!
//! - no args: pull and decrypt this identity's relay blobs (`just decrypt`).
//! - `import [--dry-run]`: re-derive events from the relay's stored source
//!   documents and push only the new ones (`just import-derive`).
//! - `accuracy [--json] [--vision] [--only <substr>]`: score the page readers
//!   against the fixture pages (`just accuracy`). See `crates/devtool/README.md`.

use std::path::PathBuf;

use anyhow::{anyhow, bail, Context, Result};
use svastha_devtool::accuracy::{self, AccuracyConfig};
use svastha_devtool::{import_run, run, Config, ImportConfig};

fn main() -> Result<()> {
    let args: Vec<String> = std::env::args().skip(1).collect();
    match args.first().map(String::as_str) {
        None => decrypt(),
        Some("import") => import(&args[1..]),
        Some("accuracy") => accuracy_cmd(&args[1..]),
        Some(other) => bail!(
            "unknown subcommand {other:?} — use `import` or `accuracy`, or no args to decrypt"
        ),
    }
}

fn accuracy_cmd(args: &[String]) -> Result<()> {
    let mut config = AccuracyConfig {
        json: false,
        vision: false,
        only: None,
    };
    let mut rest = args.iter();
    while let Some(arg) = rest.next() {
        match arg.as_str() {
            "--json" => config.json = true,
            "--vision" => config.vision = true,
            "--only" => {
                config.only = Some(
                    rest.next()
                        .ok_or_else(|| anyhow!("--only needs a fixture-name substring"))?
                        .clone(),
                )
            }
            other => bail!(
                "unknown flag {other:?} for `accuracy` — supported: --json, --vision, --only <substr>"
            ),
        }
    }

    let report = accuracy::run(&config)?;
    if config.json {
        println!("{}", serde_json::to_string_pretty(&report)?);
    } else {
        print!("{}", report.render());
    }

    // A failed gate is a failed run: the exit code is what stops this being
    // pasted into a PR as evidence without anyone reading the verdict line.
    if !report.all_gates_pass() {
        std::process::exit(1);
    }
    Ok(())
}

fn decrypt() -> Result<()> {
    let (mnemonic, relay_url) = env()?;
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

fn import(args: &[String]) -> Result<()> {
    let mut dry_run = false;
    for arg in args {
        match arg.as_str() {
            "--dry-run" => dry_run = true,
            other => bail!("unknown flag {other:?} for `import` — only `--dry-run` is supported"),
        }
    }

    let (mnemonic, relay_url) = env()?;
    let summary = import_run(&ImportConfig {
        relay_url,
        mnemonic,
        dry_run,
    })
    .context("import failed")?;

    println!("{summary}");
    Ok(())
}

fn env() -> Result<(String, String)> {
    let mnemonic = std::env::var("SVASTHA_MNEMONIC").map_err(|_| {
        anyhow!("SVASTHA_MNEMONIC is not set — copy .env.example to .env and fill it in")
    })?;
    let relay_url = std::env::var("SVASTHA_RELAY_URL").map_err(|_| {
        anyhow!("SVASTHA_RELAY_URL is not set — copy .env.example to .env and fill it in")
    })?;
    Ok((mnemonic, relay_url))
}
