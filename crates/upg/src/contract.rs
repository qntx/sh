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

fn run_script(
    script: &Path,
    args: &[String],
    home: &Path,
    extra_env: &[(String, String)],
) -> std::process::Output {
    let src = std::fs::read_to_string(script).expect("read installer");
    std::process::Command::new("sh")
        .arg("-c")
        .arg(&src)
        .arg("sh")
        .args(args)
        .env("HOME", home)
        .env("XDG_CONFIG_HOME", home.join(".config"))
        .envs(extra_env.iter().map(|(k, v)| (k, v)))
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
    let out = run_script(&script, &["--check".to_owned()], &home, &[]);
    assert!(out.status.success(), "check failed");
    let version = String::from_utf8_lossy(&out.stdout);
    assert!(
        semver::Version::parse(version.trim()).is_ok(),
        "--check output is not semver: {version}"
    );

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
        &[],
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
        &[],
    );
    assert!(rerun.status.success(), "idempotent rerun failed");

    std::fs::remove_dir_all(&home).expect("remove temp dir");
}

const FAKE_UNAME: &str = "#!/bin/sh\ncase \"$1\" in\n    -s) echo Linux ;;\n    -m) echo x86_64 ;;\n    *) exec /usr/bin/uname \"$@\" ;;\nesac\n";
const FAKE_GETCONF: &str = "#!/bin/sh\necho 'glibc 2.0'\n";

fn write_stub(path: &Path, body: &str) {
    use std::os::unix::fs::PermissionsExt;

    std::fs::write(path, body).expect("write stub");
    std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o755)).expect("chmod stub");
}

// A host reporting glibc 2.0 is below every locked gnu floor: the
// installer must exit 3 (Error::Unsupported for upg) without touching
// the install dir or the receipt.
#[test]
#[ignore = "needs UPG_CONTRACT_GLIBC_SCRIPT=apps/sh/dist/nosfry.sh"]
fn glibc_below_floor_exits_unsupported() {
    let Some(script) = std::env::var_os("UPG_CONTRACT_GLIBC_SCRIPT").map(PathBuf::from) else {
        return;
    };
    let home = tmp();
    let dir = home.join("bin");
    std::fs::create_dir_all(&dir).expect("bin dir");
    let stub = home.join("stub");
    std::fs::create_dir_all(&stub).expect("stub dir");
    write_stub(&stub.join("uname"), FAKE_UNAME);
    write_stub(&stub.join("getconf"), FAKE_GETCONF);
    let bin = script
        .file_stem()
        .expect("script stem")
        .to_str()
        .expect("script stem utf8")
        .to_owned();
    let path = format!(
        "{}:{}",
        stub.display(),
        std::env::var("PATH").expect("PATH")
    );

    let out = run_script(
        &script,
        &[
            "--install-dir".to_owned(),
            dir.display().to_string(),
            "--no-modify-path".to_owned(),
            "--quiet".to_owned(),
        ],
        &home,
        &[("PATH".to_owned(), path)],
    );

    assert_eq!(out.status.code(), Some(3), "expected exit 3: {out:?}");
    let stderr = String::from_utf8_lossy(&out.stderr);
    assert!(stderr.contains("needs glibc >="), "stderr: {stderr}");
    assert!(
        stderr.contains("this host has glibc 2.0"),
        "stderr: {stderr}"
    );
    assert!(
        stderr.contains(&format!("cargo install {bin} --locked")),
        "stderr: {stderr}"
    );
    assert!(!dir.join(&bin).exists(), "nothing installed");
    let receipt = home.join(format!(".config/qntx/receipts/{bin}.json"));
    assert!(!receipt.exists(), "no receipt");

    std::fs::remove_dir_all(&home).expect("remove temp dir");
}
