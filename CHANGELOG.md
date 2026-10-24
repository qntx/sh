# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- Monorepo restructure (Vite+ workspaces): `apps/sh` static site,
  `packages/github` shared client/release/lock helpers, `crates/` for the
  upcoming `upg` crate.
- `apps/sk` — sk.qntx.org: an agent-skills discovery endpoint serving
  hash-locked `SKILL.md` files synced from source repos (`qntx/kobe`).
- `upg` 0.1.0 — `crates/upg`: the shared `upgrade` subcommand for QuantX
  CLIs; re-runs the sh.qntx.org installer, detects script-/cargo-/unmanaged
  installs, and reports `Report`/`Action` outcomes.

### Changed

- **BREAKING**: sh.qntx.org rebuilt as a build-time-rendered static site.
  `apps/sh/catalog.json` + `apps/sh/releases.json` (cron-synced lock of the
  newest stable `vX.Y.Z` release per tool) render one script per tool; the
  runtime serves static assets only. Removed: the `/labs/<repo>` and
  repo-name routes, the global `UNINSTALL`/`DRY_RUN`/`HELP` env vars, and
  the old root behaviour of defaulting to the ovo installer (the root
  script now lists every tool and exits 1).
- **Breaking**: the sh.qntx.org catalog is reduced to `kobe` and `nosfry`;
  all other tool routes are removed.
- The repo is now dual-licensed MIT OR Apache-2.0 (replaces MIT-only
  LICENSE).
- Installers verify a SHA-256 embedded at build time for the locked latest
  version (release `.sha256` for `--version` pins), self-check the binary
  before replacing anything, install atomically, write a receipt, and
  prefer musl builds on Linux when present.

### Fixed

- Empty `SYNC_TOOL` env (GitHub workflow_dispatch default) now means "all
  tools" instead of a catalog miss.
- x86_64 Windows zips are selected correctly (suffix match on
  `-pc-windows-msvc`), and unrecognized `<bin>-<ver>-*` assets fail
  selection instead of being silently dropped.

### Removed

- `installer: "repo"` support (the bux path): catalog field, lock
  `installer` hashes, `tools/` copy logic, and the bux CI exemptions.
