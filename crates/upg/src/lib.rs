//! # `upg` — self-upgrade helper for `QuantX` CLIs
//!
//! Every qntx CLI exposes an identical `upgrade` subcommand that re-runs the
//! official `sh.qntx.org` installer. `upg` contains no HTTP/TLS/archive
//! code: it spawns `curl`/`wget` (Unix) or `powershell.exe` (Windows), and
//! the installer script performs all downloading, hashing, and replacing.
//!
//! ## Integration (clap)
//!
//! ```no_run
//! # #[cfg(feature = "clap")] {
//! use clap::Subcommand;
//!
//! const TOOL: upg::Tool = upg::Tool::new("kobe", env!("CARGO_PKG_VERSION"))
//!     .package("kobe-cli");
//!
//! #[derive(Subcommand)]
//! enum Commands {
//!     /// Upgrade to the latest (or a pinned) release via sh.qntx.org.
//!     #[command(visible_alias = "update")]
//!     Upgrade(upg::Args),
//! }
//!
//! fn dispatch(cmd: Commands) -> Result<(), Box<dyn std::error::Error>> {
//!     match cmd {
//!         Commands::Upgrade(args) => {
//!             println!("{}", upg::run(&TOOL, &args)?);
//!             Ok(())
//!         }
//!     }
//! }
//! # }
//! ```
//!
//! Nothing network- or process-related happens at import time or during
//! construction; work only happens inside [`run`].

mod args;
mod error;
mod method;
mod receipt;
mod report;
mod script;
mod tool;

use std::path::PathBuf;

use semver::Version;

pub use args::Args;
pub use error::Error;
pub use report::{Action, Report};
pub use tool::Tool;

use crate::script::Installer;
use method::{Env, Method};

/// Run the upgrade flow for `tool`.
///
/// 1. Resolves the running binary's version and queries the installer for
///    the latest stable release.
/// 2. With `check`, reports `Available`/`UpToDate` for any install method.
/// 3. Otherwise detects the install method: script-managed tools are
///    re-installed in place; cargo-managed tools get the cargo command;
///    anything else fails with [`Error::Unmanaged`].
///
/// # Errors
/// [`Error::Unmanaged`] for a foreign binary, [`Error::Unsupported`] when
/// the platform has no prebuilt binary, [`Error::Installer`] on installer
/// failure, plus receipt/parse/I/O variants.
pub fn run(tool: &Tool, args: &Args) -> Result<Report, Error> {
    let current =
        Version::parse(tool.version()).map_err(|e| Error::Version(tool.version().to_owned(), e))?;
    let installer = Installer::fetch(tool, cfg!(windows))?;
    let latest = installer.check()?;
    let update_available = latest > current;

    if args.check {
        let action = if update_available {
            Action::Available
        } else {
            Action::UpToDate
        };
        return Ok(report(tool, current, latest, action));
    }

    let env = current_env()?;
    let receipt = load_receipt(&env, tool.name())?;
    match method::detect(&env, receipt.as_ref()) {
        Method::Script { dir } => {
            let pinned = args.version.as_ref();
            if pinned.is_none() && !args.force && !update_available {
                return Ok(report(tool, current, latest, Action::UpToDate));
            }
            let code = installer.install(&dir, pinned, args.force)?;
            match code {
                Some(0) => Ok(report(
                    tool,
                    current,
                    latest.clone(),
                    Action::Upgraded {
                        version: pinned.map_or_else(|| latest.clone(), Version::clone),
                    },
                )),
                Some(3) => Err(Error::Unsupported {
                    install_command: format!("cargo install {} --locked", tool.package_or_name()),
                }),
                other => Err(Error::Installer { code: other }),
            }
        }
        Method::Cargo => Ok(report(
            tool,
            current,
            latest,
            Action::Cargo {
                command: format!("cargo install {} --locked --force", tool.package_or_name()),
            },
        )),
        Method::Unmanaged => Err(Error::Unmanaged {
            tool: tool.name(),
            dir: exe_dir(&env),
            install_command: install_command(tool),
        }),
    }
}

fn report(tool: &Tool, current: Version, latest: Version, action: Action) -> Report {
    let update_available = latest > current;
    Report {
        tool: tool.name().to_owned(),
        current,
        latest,
        update_available,
        action,
    }
}

fn install_command(tool: &Tool) -> String {
    if cfg!(windows) {
        format!("irm https://sh.qntx.org/{}/ps | iex", tool.name())
    } else {
        format!("curl -fsSL https://sh.qntx.org/{} | sh", tool.name())
    }
}

fn exe_dir(env: &Env) -> String {
    env.current_exe
        .parent()
        .map_or_else(|| "<unknown>".to_owned(), |p| p.display().to_string())
}

fn current_env() -> Result<Env, Error> {
    Ok(Env {
        current_exe: std::env::current_exe().map_err(Error::Io)?,
        home: home_dir(),
        xdg_config_home: std::env::var_os("XDG_CONFIG_HOME").map(PathBuf::from),
        local_appdata: std::env::var_os("LOCALAPPDATA").map(PathBuf::from),
        cargo_home: std::env::var_os("CARGO_HOME").map(PathBuf::from),
        windows: cfg!(windows),
    })
}

fn home_dir() -> Option<PathBuf> {
    std::env::var_os("HOME")
        .or_else(|| std::env::var_os("USERPROFILE"))
        .map(PathBuf::from)
}

#[cfg(test)]
mod contract;

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    #[cfg(unix)]
    fn load_receipt_surfaces_io_errors() {
        use std::os::unix::fs::PermissionsExt;

        let dir = std::env::temp_dir().join(format!("upg-receipt-{}", std::process::id()));
        let receipts = dir.join(".config/qntx/receipts");
        let _ignored = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&receipts).expect("receipts dir");
        let receipt = receipts.join("kobe.json");
        std::fs::write(&receipt, "{}").expect("write");
        std::fs::set_permissions(&receipt, std::fs::Permissions::from_mode(0o000)).expect("chmod");

        let env = Env {
            current_exe: dir.join("kobe"),
            home: Some(dir.clone()),
            xdg_config_home: None,
            local_appdata: None,
            cargo_home: None,
            windows: false,
        };
        let r = load_receipt(&env, "kobe");
        assert!(matches!(r, Err(Error::Io(_))), "{r:?}");

        std::fs::set_permissions(&receipt, std::fs::Permissions::from_mode(0o644))
            .expect("chmod back");
        let _done = std::fs::remove_dir_all(&dir);
    }
}

fn load_receipt(env: &Env, tool: &str) -> Result<Option<receipt::Receipt>, Error> {
    let path = receipt::receipt_path(
        tool,
        env.windows,
        env.home.as_deref(),
        env.xdg_config_home.as_deref(),
        env.local_appdata.as_deref(),
    );
    let contents = match std::fs::read_to_string(&path) {
        Ok(c) => c,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(e) => return Err(Error::Io(e)),
    };
    Ok(Some(receipt::parse_receipt(tool, &contents)?))
}
