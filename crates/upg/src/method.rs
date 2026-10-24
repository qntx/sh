//! Install-method detection: script-managed, cargo-managed, or unmanaged.
//!
//! Pure logic over an injected [`Env`] so tests can drive it with temp
//! directories on any host.

use std::path::{Path, PathBuf};

use crate::receipt::Receipt;

/// Everything detection needs from the environment.
#[derive(Debug, Clone)]
pub(crate) struct Env {
    /// Absolute path of the running binary.
    pub current_exe: PathBuf,
    /// `$HOME` on Unix, `%USERPROFILE%` on Windows.
    pub home: Option<PathBuf>,
    /// `$XDG_CONFIG_HOME` (Unix only).
    pub xdg_config_home: Option<PathBuf>,
    /// `%LOCALAPPDATA%` (Windows only).
    pub local_appdata: Option<PathBuf>,
    /// `$CARGO_HOME` when set.
    pub cargo_home: Option<PathBuf>,
    /// Whether to use Windows layout/receipt semantics.
    pub windows: bool,
}

/// How the running binary is managed.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) enum Method {
    /// Installed by the sh.qntx.org script; `dir` is the receipt's
    /// `install_dir` verbatim (what `--install-dir` is passed).
    Script { dir: String },
    /// Installed under `$CARGO_HOME/bin` (or `~/.cargo/bin`).
    Cargo,
    /// Neither.
    Unmanaged,
}

/// Canonicalize a path; unresolved paths compare by their literal form so
/// detection still works for directories that do not exist yet.
fn canon(p: &Path) -> PathBuf {
    p.canonicalize().unwrap_or_else(|_| p.to_path_buf())
}

fn cargo_bin(env: &Env) -> Option<PathBuf> {
    if let Some(c) = &env.cargo_home {
        return Some(c.join("bin"));
    }
    env.home.as_ref().map(|h| h.join(".cargo").join("bin"))
}

/// Detect how the running binary was installed.
pub(crate) fn detect(env: &Env, receipt: Option<&Receipt>) -> Method {
    let exe_dir = match env.current_exe.parent() {
        Some(p) => canon(p),
        None => return Method::Unmanaged,
    };

    if receipt.is_some_and(|r| canon(Path::new(&r.install_dir)) == exe_dir) {
        return Method::Script {
            dir: receipt.map_or_else(String::new, |r| r.install_dir.clone()),
        };
    }

    if cargo_bin(env).is_some_and(|cb| canon(&cb) == exe_dir) {
        return Method::Cargo;
    }

    Method::Unmanaged
}

#[cfg(test)]
mod tests {
    use std::fs;

    use super::*;

    fn env(exe: &Path, home: &Path) -> Env {
        Env {
            current_exe: exe.to_path_buf(),
            home: Some(home.to_path_buf()),
            xdg_config_home: None,
            local_appdata: None,
            cargo_home: None,
            windows: false,
        }
    }

    fn receipt(dir: &str) -> Receipt {
        Receipt {
            schema: 1,
            tool: "kobe".to_owned(),
            version: "6.0.0".to_owned(),
            install_dir: dir.to_owned(),
        }
    }

    // Tests run in parallel inside one process: each gets its own dir.
    fn tmp(name: &str) -> PathBuf {
        let d = std::env::temp_dir()
            .join(format!("upg-test-{}", std::process::id()))
            .join(name);
        let _ignored = fs::remove_dir_all(&d);
        fs::create_dir_all(&d).expect("mkdir");
        d
    }

    #[test]
    fn script_managed_via_receipt() {
        let d = tmp(concat!(file!(), "-", line!()));
        let bin = d.join("bin");
        fs::create_dir_all(&bin).expect("bin");
        let e = env(&bin.join("kobe"), &d);
        let r = receipt(&bin.display().to_string());
        assert_eq!(
            detect(&e, Some(&r)),
            Method::Script {
                dir: bin.display().to_string()
            }
        );
        fs::remove_dir_all(&d).ok();
    }

    #[test]
    fn script_managed_through_symlink() {
        let d = tmp(concat!(file!(), "-", line!()));
        let real = d.join("real");
        fs::create_dir_all(&real).expect("real");
        let link = d.join("link");
        #[cfg(unix)]
        std::os::unix::fs::symlink(&real, &link).expect("symlink");
        let e = env(&link.join("kobe"), &d);
        // Receipt records the real path; exe runs via the symlink — they
        // must still match after canonicalization.
        let r = receipt(&real.display().to_string());
        assert!(matches!(detect(&e, Some(&r)), Method::Script { .. }));
        fs::remove_dir_all(&d).ok();
    }

    #[test]
    fn cargo_managed() {
        let d = tmp(concat!(file!(), "-", line!()));
        let cb = d.join(".cargo").join("bin");
        fs::create_dir_all(&cb).expect("cargo bin");
        let e = env(&cb.join("kobe"), &d);
        assert_eq!(detect(&e, None), Method::Cargo);
        fs::remove_dir_all(&d).ok();
    }

    #[test]
    fn unmanaged_when_dirs_differ() {
        let d = tmp(concat!(file!(), "-", line!()));
        let bin = d.join("bin");
        fs::create_dir_all(&bin).expect("bin");
        let e = env(&bin.join("kobe"), &d);
        let r = receipt("/some/other/dir");
        assert_eq!(detect(&e, Some(&r)), Method::Unmanaged);
        fs::remove_dir_all(&d).ok();
    }
}
