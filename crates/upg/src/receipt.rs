//! Install receipt: the JSON marker the installer scripts write.
//!
//! Path: `${XDG_CONFIG_HOME:-$HOME/.config}/qntx/receipts/<tool>.json` on
//! Unix (`XDG_CONFIG_HOME` counts only when absolute, per the spec),
//! `%LOCALAPPDATA%\\qntx\\receipts\\<tool>.json` on Windows.

use std::path::{Path, PathBuf};

use serde::Deserialize;

use crate::error::Error;

/// Parsed install receipt.
#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[non_exhaustive]
pub(crate) struct Receipt {
    /// Must be `1`.
    pub schema: u32,
    /// Catalog key of the installed tool.
    pub tool: String,
    /// Installed version string (kept verbatim for the lock check).
    pub version: String,
    /// Install directory recorded at install time.
    pub install_dir: String,
}

/// Resolve the receipt path for `tool` in the given environment.
///
/// `windows` selects the Windows layout; it is a parameter (not
/// `cfg!(windows)`) so the mapping is unit-testable on any host.
pub(crate) fn receipt_path(
    tool: &str,
    windows: bool,
    home: Option<&Path>,
    xdg_config_home: Option<&Path>,
    local_appdata: Option<&Path>,
) -> PathBuf {
    let base = if windows {
        local_appdata.map_or_else(|| PathBuf::from("%LOCALAPPDATA%"), Path::to_path_buf)
    } else {
        match xdg_config_home {
            Some(p) if p.is_absolute() => p.to_path_buf(),
            _ => home.map_or_else(|| PathBuf::from("$HOME"), |h| h.join(".config")),
        }
    };
    base.join("qntx")
        .join("receipts")
        .join(format!("{tool}.json"))
}

/// Parse receipt contents; validates schema and tool name.
pub(crate) fn parse_receipt(tool: &str, contents: &str) -> Result<Receipt, Error> {
    let receipt: Receipt =
        serde_json::from_str(contents).map_err(|e| Error::Receipt(e.to_string()))?;
    if receipt.schema != 1 {
        return Err(Error::Receipt(format!(
            "unsupported receipt schema {}",
            receipt.schema
        )));
    }
    if receipt.tool != tool {
        return Err(Error::Receipt(format!(
            "receipt is for {:?}, not {tool:?}",
            receipt.tool
        )));
    }
    Ok(receipt)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn p(s: &str) -> PathBuf {
        PathBuf::from(s)
    }

    #[test]
    fn path_unix_xdg_absolute() {
        let got = receipt_path("kobe", false, Some(&p("/h")), Some(&p("/xdg")), None);
        assert_eq!(got, p("/xdg/qntx/receipts/kobe.json"));
    }

    #[test]
    fn path_unix_xdg_relative_ignored() {
        let got = receipt_path("kobe", false, Some(&p("/h")), Some(&p("rel")), None);
        assert_eq!(got, p("/h/.config/qntx/receipts/kobe.json"));
    }

    #[test]
    fn path_unix_no_xdg() {
        let got = receipt_path("kobe", false, Some(&p("/h")), None, None);
        assert_eq!(got, p("/h/.config/qntx/receipts/kobe.json"));
    }

    #[test]
    fn path_windows() {
        let got = receipt_path("kobe", true, None, None, Some(&p("C:/App")));
        assert_eq!(got, p("C:/App/qntx/receipts/kobe.json"));
    }

    #[test]
    fn parse_valid() {
        let r = parse_receipt(
            "kobe",
            r#"{"schema":1,"tool":"kobe","version":"6.0.0","install_dir":"/d"}"#,
        )
        .map_err(|e| e.to_string());
        assert!(r.is_ok(), "{r:?}");
    }

    #[test]
    fn parse_schema2_fails() {
        assert!(
            parse_receipt(
                "kobe",
                r#"{"schema":2,"tool":"kobe","version":"6.0.0","install_dir":"/d"}"#,
            )
            .is_err()
        );
    }

    #[test]
    fn parse_wrong_tool_fails() {
        assert!(
            parse_receipt(
                "kobe",
                r#"{"schema":1,"tool":"nosfry","version":"0.3.0","install_dir":"/d"}"#,
            )
            .is_err()
        );
    }

    #[test]
    fn parse_malformed_fails() {
        assert!(parse_receipt("kobe", "{not json").is_err());
        assert!(matches!(
            parse_receipt("kobe", "{}"),
            Err(Error::Receipt(_))
        ));
    }
}
