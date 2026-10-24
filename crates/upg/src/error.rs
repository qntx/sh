//! Error type for [`crate::run`].

/// Everything [`crate::run`] can fail with.
#[derive(Debug, thiserror::Error)]
#[non_exhaustive]
pub enum Error {
    /// The running binary was not installed by the installer script and is
    /// not cargo-managed either.
    #[error("{tool} was not installed by sh.qntx.org at {dir}; install with: {install_command}")]
    Unmanaged {
        /// Catalog key of the tool.
        tool: &'static str,
        /// Directory containing the running binary.
        dir: String,
        /// One-line install command to hand the user.
        install_command: String,
    },

    /// The installer reported that no prebuilt binary exists for this
    /// platform (exit code 3).
    #[error("no prebuilt binary for this platform; install from source: {install_command}")]
    Unsupported {
        /// `cargo install <package> --locked` hint.
        install_command: String,
    },

    /// The installer exited non-zero.
    #[error("installer exited with {}", code.map_or_else(|| "signal".to_owned(), |c| c.to_string()))]
    Installer {
        /// Exit code, or `None` when the process was killed by a signal.
        code: Option<i32>,
    },

    /// Fetching the installer script failed.
    #[error("{program}: {detail}")]
    Fetch {
        /// `curl` or `wget`.
        program: &'static str,
        /// Human-readable detail.
        detail: String,
    },

    /// The install receipt could not be parsed or is unsupported.
    #[error("receipt: {0}")]
    Receipt(String),

    /// A version string could not be parsed.
    #[error("invalid version {0:?}: {1}")]
    Version(String, semver::Error),

    /// An underlying I/O error.
    #[error("{0}")]
    Io(#[from] std::io::Error),
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn unsupported_display_includes_install_command() {
        let e = Error::Unsupported {
            install_command: "cargo install kobe-cli --locked".to_owned(),
        };
        assert_eq!(
            e.to_string(),
            "no prebuilt binary for this platform; install from source: cargo install kobe-cli --locked"
        );
    }
}
