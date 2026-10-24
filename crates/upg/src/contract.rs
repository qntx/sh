//! Contract test against a real rendered installer script.
//!
//! Ignored unless `UPG_CONTRACT_SCRIPT` points at a rendered installer
//! (e.g. `apps/sh/dist/kobe.sh`). HOME is redirected to a temp dir so the
//! real receipt directory is never touched. Unix only — the rendered
//! script is POSIX sh.

#![cfg(unix)]

use std::path::{Path, PathBuf};

fn tmp() -> PathBuf {
    let d = std::env::temp_dir().join(format!("upg-contract-{}", std::process::id()));
    let _ignored = std::fs::remove_dir_all(&d);
    std::fs::create_dir_all(&d).expect("create temp dir");
    d
}

fn run_script(script: &Path, args: &[String], home: &Path) -> std::process::Output {
    let src = std::fs::read_to_string(script).expect("read installer");
    std::process::Command::new("sh")
        .arg("-c")
        .arg(&src)
        .arg("sh")
        .args(args)
        .env("HOME", home)
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped())
        .output()
        .expect("spawn sh")
}

#[test]
#[ignore = "needs UPG_CONTRACT_SCRIPT=apps/sh/dist/kobe.sh"]
fn check_returns_semver_and_install_roundtrips() {
    let Some(script) = std::env::var_os("UPG_CONTRACT_SCRIPT").map(PathBuf::from) else {
        return;
    };
    let home = tmp();
    let dir = home.join("bin");
    std::fs::create_dir_all(&dir).expect("bin dir");

    // --check prints a semver on stdout and touches nothing.
    let out = run_script(&script, &["--check".to_owned()], &home);
    assert!(out.status.success(), "check failed");
    let version = String::from_utf8_lossy(&out.stdout);
    let latest = semver::Version::parse(version.trim()).expect("--check output is semver");

    // Install through the same runner invocation the crate uses.
    let install = run_script(
        &script,
        &[
            "--install-dir".to_owned(),
            dir.display().to_string(),
            "--no-modify-path".to_owned(),
            "--quiet".to_owned(),
        ],
        &home,
    );
    assert!(install.status.success(), "install failed: {install:?}");
    assert!(dir.join("kobe").exists(), "binary installed");

    // The receipt lands under the redirected HOME.
    let receipt = home.join(".config/qntx/receipts/kobe.json");
    assert!(receipt.exists(), "receipt written");

    // A second run reports up to date (exit 0, no re-download).
    let rerun = run_script(
        &script,
        &[
            "--install-dir".to_owned(),
            dir.display().to_string(),
            "--no-modify-path".to_owned(),
            "--quiet".to_owned(),
        ],
        &home,
    );
    assert!(rerun.status.success(), "idempotent rerun failed");

    let _latest = latest;
    let _done = std::fs::remove_dir_all(&home);
}
