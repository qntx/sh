//! Upgrade outcome: machine-readable report plus one-line display.

use serde::Serialize;

/// What [`crate::run`] did or found.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(tag = "action", rename_all = "snake_case")]
#[non_exhaustive]
pub enum Action {
    /// Already on the latest (or requested) release.
    UpToDate,
    /// A newer release exists; reported only because `--check` was given.
    Available,
    /// The installer upgraded the tool.
    Upgraded {
        /// Version that was installed.
        version: semver::Version,
    },
    /// The tool is cargo-managed; upgrading is the package manager's job.
    Cargo {
        /// Command the user should run instead.
        command: String,
    },
}

/// Result of a successful [`crate::run`].
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct Report {
    /// Catalog key of the tool.
    pub tool: String,
    /// Version of the running binary.
    pub current: semver::Version,
    /// Latest stable release seen by the installer.
    pub latest: semver::Version,
    /// `latest > current`.
    pub update_available: bool,
    /// What happened.
    pub action: Action,
}

impl std::fmt::Display for Report {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match &self.action {
            Action::UpToDate => write!(f, "{} {} is up to date", self.tool, self.current),
            Action::Available => write!(
                f,
                "{} {} -> {} available",
                self.tool, self.current, self.latest
            ),
            Action::Upgraded { version } => {
                write!(f, "{} upgraded to {}", self.tool, version)
            }
            Action::Cargo { command } => {
                write!(
                    f,
                    "{} was installed with cargo; run: {}",
                    self.tool, command
                )
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn rep(action: Action) -> Report {
        Report {
            tool: "kobe".to_owned(),
            current: semver::Version::new(6, 0, 0),
            latest: semver::Version::new(7, 0, 0),
            update_available: true,
            action,
        }
    }

    #[test]
    fn display_lines() {
        assert_eq!(
            rep(Action::Available).to_string(),
            "kobe 6.0.0 -> 7.0.0 available"
        );
        let mut up = rep(Action::UpToDate);
        up.latest = up.current.clone();
        up.update_available = false;
        assert_eq!(up.to_string(), "kobe 6.0.0 is up to date");
        assert_eq!(
            rep(Action::Upgraded {
                version: semver::Version::new(7, 0, 0)
            })
            .to_string(),
            "kobe upgraded to 7.0.0"
        );
        assert_eq!(
            rep(Action::Cargo {
                command: "cargo install kobe-cli --locked --force".to_owned()
            })
            .to_string(),
            "kobe was installed with cargo; run: cargo install kobe-cli --locked --force"
        );
    }

    #[test]
    fn json_shapes() {
        let j = |a: Action| serde_json::to_string(&rep(a)).map_err(|e| e.to_string());
        assert_eq!(
            j(Action::UpToDate),
            Ok(r#"{"tool":"kobe","current":"6.0.0","latest":"7.0.0","update_available":true,"action":{"action":"up_to_date"}}"#.to_owned())
        );
        assert_eq!(
            j(Action::Available),
            Ok(r#"{"tool":"kobe","current":"6.0.0","latest":"7.0.0","update_available":true,"action":{"action":"available"}}"#.to_owned())
        );
        assert_eq!(
            j(Action::Upgraded {
                version: semver::Version::new(7, 0, 0)
            }),
            Ok(r#"{"tool":"kobe","current":"6.0.0","latest":"7.0.0","update_available":true,"action":{"action":"upgraded","version":"7.0.0"}}"#.to_owned())
        );
        assert_eq!(
            j(Action::Cargo {
                command: "x".to_owned()
            }),
            Ok(r#"{"tool":"kobe","current":"6.0.0","latest":"7.0.0","update_available":true,"action":{"action":"cargo","command":"x"}}"#.to_owned())
        );
    }
}
