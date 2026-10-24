# Changelog

All notable changes to this repository will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).
`v*.*.*` tags release the `upg` crate; the apps deploy continuously.

## [Unreleased]

### Changed

- Deployment is local again via the Wrangler CLI (`bun run deploy`); the
  `Deploy` GitHub workflow was removed and `sync.yml` is commit-only.
- `packages/github` renamed to `packages/sync` (`@qntx/sync`): GitHub
  client, stable-release selection, lock I/O, plus shared `isRecord` and
  `sha256Hex` helpers now used by both apps.
- Lock model moved out of the catalog module: `apps/sh/src/lock.ts` owns
  the `releases.json` schema/ops and `apps/sk/src/lock.ts` owns the
  `skills.lock.json` schema.
- tsconfig strictness aligned with qntx/spark (`erasableSyntaxOnly`,
  `verbatimModuleSyntax`, `vite.config.ts` in each workspace's program,
  root `tsconfig.json` covering `bump.config.ts`).

### Removed

- Obsolete `oxfmt.config.ts`/`oxlint.config.ts` root files (vite.config.ts
  owns format/lint) and duplicated semver/JSON/hash helpers in the apps.

## [0.1.0] - 2026-10-24

First tagged state of the repository.

### Added

- `apps/sh` — [sh.qntx.org](https://sh.qntx.org): a static, build-time
  rendered installer service for QuantX CLIs (`kobe`, `nosfry`). POSIX sh
  and PowerShell 5.1+/7 installers from `catalog.json` + the sync-locked
  `releases.json`; deterministic `bun run build` into `dist/`; exit codes
  0/1/2/3; per-tool JSON receipts; archive + binary SHA-256 verification.
- `apps/sk` — [sk.qntx.org](https://sk.qntx.org): a static agent-skills
  discovery service serving hash-locked `SKILL.md` files synced from
  source repos (`qntx/kobe`), with a
  `/.well-known/agent-skills/index.json` discovery index.
- `crates/upg` — `upg` 0.1.0: the shared `upgrade` subcommand crate for
  QuantX CLIs; re-runs the official sh.qntx.org installer, detects
  script-/cargo-/unmanaged installs, and reports `Report`/`Action`
  outcomes.
- `packages/sync` — `@qntx/github`: the shared GitHub REST client,
  `vX.Y.Z` stable-release selection, and deterministic lock-file
  serialization used by the sync tasks.

### Changed

- The repository is a Vite+ (vp) monorepo (`apps/`, `packages/`,
  `crates/`); `SYNC_TOOL=""` and `SYNC_SOURCE=""` mean "all".

### Removed

- The `bux` tool and the `installer: "repo"` catalog mode; the catalog is
  `kobe` + `nosfry`.
