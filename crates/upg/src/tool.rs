//! The CLI tool being upgraded: identity constants only.

/// A CLI tool distributed through `sh.qntx.org`.
///
/// `name` is the catalog key (also the binary name); `version` is the
/// running binary's version (normally `env!("CARGO_PKG_VERSION")`);
/// `package` is the crates.io package name used in the cargo hint and
/// defaults to `name`.
#[derive(Debug, Clone, Copy)]
pub struct Tool {
    name: &'static str,
    version: &'static str,
    package: Option<&'static str>,
}

impl Tool {
    /// Create a tool descriptor.
    #[must_use]
    pub const fn new(name: &'static str, version: &'static str) -> Self {
        Self {
            name,
            version,
            package: None,
        }
    }

    /// Set the crates.io package name for the cargo-install hint.
    #[must_use]
    pub const fn package(self, package: &'static str) -> Self {
        Self {
            package: Some(package),
            ..self
        }
    }

    pub(crate) const fn name(self) -> &'static str {
        self.name
    }

    pub(crate) const fn version(self) -> &'static str {
        self.version
    }

    pub(crate) fn package_or_name(self) -> &'static str {
        self.package.map_or(self.name, |p| p)
    }
}
