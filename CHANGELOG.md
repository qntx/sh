# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Changed

- **BREAKING**: sh.qntx.org rebuilt as a build-time-rendered static site.
  `catalog.json` + `releases.json` (cron-synced lock of the newest stable
  `vX.Y.Z` release per tool) render one script per tool; the runtime serves
  static assets only. Removed: the `/labs/<repo>` and repo-name routes, the
  global `UNINSTALL`/`DRY_RUN`/`HELP` env vars, and the old root behaviour of
  defaulting to the ovo installer (the root script now lists every tool and
  exits 1).
- Installers now verify a SHA-256 embedded at build time for the locked
  latest version (release `.sha256` for `--version` pins), self-check the
  binary before replacing anything, install atomically, write a receipt,
  and prefer musl builds on Linux when present.
- Linux release assets built on pinned `ubuntu-24.04`; musl targets supported.
