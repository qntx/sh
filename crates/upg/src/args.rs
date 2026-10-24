//! Upgrade arguments: a clap-ready options struct.

/// Options accepted by the `upgrade` subcommand.
#[derive(Debug, Clone, Default)]
#[cfg_attr(feature = "clap", derive(clap::Args))]
pub struct Args {
    /// Only report whether a newer release is available; install nothing.
    #[cfg_attr(feature = "clap", arg(long))]
    pub check: bool,
    /// Install this version instead of the latest release.
    #[cfg_attr(feature = "clap", arg(long, value_name = "X.Y.Z"))]
    pub version: Option<semver::Version>,
    /// Reinstall even when already up to date.
    #[cfg_attr(feature = "clap", arg(long))]
    pub force: bool,
}
