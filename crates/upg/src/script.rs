//! Fetch and execute the official installer script.
//!
//! upg never downloads archives or verifies hashes itself — the installer
//! does all of that. This module only fetches the script text (Unix) and
//! spawns it, or delegates the whole flow to powershell.exe (Windows).

use std::io::ErrorKind;
use std::process::{Command, Output, Stdio};

use semver::Version;

use crate::error::Error;
use crate::tool::Tool;

const BASE: &str = "https://sh.qntx.org";
const MAX_SCRIPT: u64 = 1024 * 1024;

fn sh_url(tool: &Tool) -> String {
    format!("{BASE}/{}", tool.name())
}

fn ps_url(tool: &Tool) -> String {
    format!("{BASE}/{}/ps", tool.name())
}

/// The installer, fetched once per [`crate::run`]. On Unix it holds the
/// script text; on Windows it holds the `/ps` URL (powershell fetches it
/// itself, so a "fetch" is just the URL).
pub(crate) enum Installer {
    Sh { script: String },
    Ps { url: String },
}

impl Installer {
    /// Fetch the installer for `tool`. Unix: one network round-trip whose
    /// result is reused for both `--check` and the install.
    pub(crate) fn fetch(tool: &Tool, windows: bool) -> Result<Self, Error> {
        if windows {
            return Ok(Self::Ps { url: ps_url(tool) });
        }
        Ok(Self::Sh {
            script: fetch_sh(tool)?,
        })
    }

    /// Test-only: wrap an already-fetched script.
    #[cfg(test)]
    pub(crate) const fn from_script(script: String) -> Self {
        Self::Sh { script }
    }

    /// Run the installer's `--check`/`-Check` and parse the reported version.
    pub(crate) fn check(&self) -> Result<Version, Error> {
        let text = match self {
            Self::Sh { script } => capture(sh_cmd(script, &["--check".to_owned()]), "sh")?,
            Self::Ps { url } => {
                let cmd =
                    format!("& ([scriptblock]::Create((irm '{url}'))) -Check; exit $LASTEXITCODE");
                capture(powershell_cmd(&cmd), "powershell.exe")?
            }
        };
        let trimmed = text.trim();
        Version::parse(trimmed).map_err(|e| Error::Version(trimmed.to_owned(), e))
    }

    /// Run the installer for an actual install; returns its exit code.
    pub(crate) fn install(
        &self,
        dir: &str,
        version: Option<&Version>,
        force: bool,
    ) -> Result<Option<i32>, Error> {
        match self {
            Self::Sh { script } => {
                let mut args = vec![
                    "--install-dir".to_owned(),
                    dir.to_owned(),
                    "--no-modify-path".to_owned(),
                ];
                if let Some(v) = version {
                    args.push("--version".to_owned());
                    args.push(v.to_string());
                }
                if force {
                    args.push("--force".to_owned());
                }
                run_status(sh_cmd(script, &args))
            }
            Self::Ps { url } => {
                let mut params = format!("-InstallDir '{}' -NoModifyPath", ps_quote(dir));
                if let Some(v) = version {
                    params.push_str(" -Version '");
                    params.push_str(&ps_quote(&v.to_string()));
                    params.push('\'');
                }
                if force {
                    params.push_str(" -Force");
                }
                let cmd = format!(
                    "& ([scriptblock]::Create((irm '{url}'))) {params}; exit $LASTEXITCODE"
                );
                run_status(powershell_cmd(&cmd))
            }
        }
    }
}

/// Windows PowerShell single-quoted literal contents: `'` doubles to `''`.
pub(crate) fn ps_quote(s: &str) -> String {
    s.replace('\'', "''")
}

fn powershell_cmd(command: &str) -> Command {
    let mut c = Command::new("powershell.exe");
    c.args([
        "-NoProfile",
        "-NonInteractive",
        "-ExecutionPolicy",
        "Bypass",
        "-Command",
        command,
    ]);
    c
}

fn sh_cmd(script: &str, args: &[String]) -> Command {
    let mut c = Command::new("sh");
    c.arg("-c").arg(script).arg("sh").args(args);
    c
}

fn curl_cmd(url: &str) -> Command {
    let mut c = Command::new("curl");
    c.args([
        "--proto",
        "=https",
        "--tlsv1.2",
        "-fsSL",
        "--retry",
        "3",
        "--max-filesize",
        &MAX_SCRIPT.to_string(),
        url,
    ]);
    c
}

/// Download the script with curl (preferred) or wget. curl refuses anything
/// over 1 MiB itself; wget output is length-checked after the fact.
fn fetch_sh(tool: &Tool) -> Result<String, Error> {
    let url = sh_url(tool);
    match capture(curl_cmd(&url), "curl") {
        Ok(text) => return checked_script(&text),
        Err(e) if is_missing(&e) => {}
        Err(e) => return Err(e),
    }
    let mut c = Command::new("wget");
    c.args(["-q", "-O", "-", &url]);
    let text = capture(c, "wget")?;
    checked_script(&text)
}

fn is_missing(e: &Error) -> bool {
    matches!(e, Error::Io(io) if io.kind() == ErrorKind::NotFound)
}

fn checked_script(text: &str) -> Result<String, Error> {
    if text.len() as u64 > MAX_SCRIPT {
        return Err(Error::Fetch {
            program: "wget",
            detail: format!("installer script exceeds {MAX_SCRIPT} bytes"),
        });
    }
    Ok(text.to_owned())
}

/// Last <=5 non-empty stderr lines for the error detail.
fn stderr_tail(stderr: &[u8]) -> String {
    let text = String::from_utf8_lossy(stderr);
    let tail: Vec<&str> = text
        .lines()
        .filter(|l| !l.trim().is_empty())
        .rev()
        .take(5)
        .collect::<Vec<_>>()
        .into_iter()
        .rev()
        .collect();
    tail.join("\n")
}

/// Spawn `cmd`, capture stdout as a String; the child's stderr is captured
/// and its tail is included in the error detail on failure.
fn capture(mut cmd: Command, program: &'static str) -> Result<String, Error> {
    cmd.stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    let out: Output = cmd.output().map_err(Error::Io)?;
    if !out.status.success() {
        let tail = stderr_tail(&out.stderr);
        let detail = if tail.is_empty() {
            format!("exited with {}", out.status)
        } else {
            format!("exited with {}: {tail}", out.status)
        };
        return Err(Error::Fetch { program, detail });
    }
    String::from_utf8(out.stdout).map_err(|e| Error::Fetch {
        program,
        detail: format!("output is not UTF-8: {e}"),
    })
}

/// Spawn `cmd` for an install: stdin null, the child's stdout mapped onto
/// our stderr (callers may print JSON on their own stdout), stderr
/// inherited. Returns the exit code.
fn run_status(mut cmd: Command) -> Result<Option<i32>, Error> {
    cmd.stdin(Stdio::null())
        .stdout(Stdio::from(std::io::stderr()))
        .stderr(Stdio::inherit());
    let status = cmd.status().map_err(Error::Io)?;
    Ok(status.code())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ps_quote_doubles_single_quotes() {
        assert_eq!(ps_quote("a'b"), "a''b");
        assert_eq!(ps_quote("plain"), "plain");
        assert_eq!(ps_quote("''"), "''''");
    }

    #[test]
    #[cfg(unix)]
    fn capture_surfaces_stderr_tail() {
        let mut c = Command::new("sh");
        c.args(["-c", "echo one >&2; echo two >&2; echo boom >&2; exit 7"]);
        let err = capture(c, "sh").map_err(|e| e.to_string());
        let msg = err.unwrap_err();
        assert!(msg.contains("boom"), "{msg}");
        assert!(msg.contains('7'), "{msg}");
    }

    #[test]
    #[cfg(unix)]
    fn installer_reuses_one_script_for_check_and_install() {
        // The injected script counts its invocations in a file: check and
        // install each run it once, proving the text is reused.
        let dir = std::env::temp_dir().join(format!("upg-inst-{}", std::process::id()));
        let counter = dir.join("count");
        let _ignored = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).expect("mkdir");
        let script = format!(
            "echo x >> '{}'; for a in \"$@\"; do [ \"$a\" = \"--check\" ] && echo '1.2.3'; done; exit 0",
            counter.display()
        );
        let inst = Installer::from_script(script);
        let v = inst.check().expect("check");
        assert_eq!(v, Version::new(1, 2, 3));
        let code = inst.install(dir.to_str().expect("utf8 dir"), None, false);
        assert!(matches!(code, Ok(Some(0))));
        let runs = std::fs::read_to_string(&counter).map_or(0, |c| c.lines().count());
        assert_eq!(runs, 2, "check + install ran the same script twice");
        let _done = std::fs::remove_dir_all(&dir);
    }
}
