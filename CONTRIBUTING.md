# Contributing

## Prerequisites

- **Bun 1.4** — package manager, scripts, and tests.
- **Rust 1.99** — via `rust-toolchain.toml`; **cargo-deny** for the supply-chain check.
- **Optional**: `shellcheck`, `shfmt` (3.14.1), PowerShell 7 (`pwsh`) and
  PSScriptAnalyzer 1.25.0 to run the shell/PowerShell gates locally.

## Repository layout

```text
apps/sh/          "sh" — the sh.qntx.org static site (templates, sync, build, dist/)
apps/sk/          "sk" — the sk.qntx.org skills service (sources, sync, build, dist/)
packages/sync/  @qntx/sync — private: minimal GitHub client, release selection, lock I/O
crates/upg/       upg — shared `upgrade` subcommand crate
docs/             public docs tree mirrored to docs.qntx.org
```

## Local gate

Run before opening a pull request:

```bash
bun install --frozen-lockfile
bun run lint          # vp check + taplo fmt --check
bun run typecheck
bun run build         # renders apps/sh/dist/ offline
bun run test
for f in apps/sh/dist/*.sh; do shellcheck -s sh "$f"; done
shellcheck -s sh apps/sh/tests/e2e/unix.sh
for f in apps/sh/dist/*.sh; do shfmt -i 4 -ci -d "$f"; done
shfmt -i 4 -ci -d apps/sh/tests/e2e/unix.sh
sh apps/sh/tests/e2e/unix.sh apps/sh/dist/kobe.sh
PIN_VERSION=0.3.0 VARIANT=onion VARIANT_VERSION=0.4.0 sh apps/sh/tests/e2e/unix.sh apps/sh/dist/nosfry.sh
npx --yes markdownlint-cli2@0.23.3 "*.md" "docs/**/*.mdx"
bun run test:contract
cargo fmt --all --check
cargo clippy --workspace --all-targets --all-features -- -D warnings
cargo clippy --workspace --all-targets --no-default-features -- -D warnings
cargo test --workspace --all-features
cargo deny check
```

Sync the release lock (needs `GITHUB_TOKEN`, e.g. `$(gh auth token)`):

```bash
cd apps/sh && bun run sync          # SYNC_TOOL=<key> SYNC_FORCE=true
cd apps/sk && bun run sync          # SYNC_SOURCE=<repo>
```

The `Sync` workflow runs hourly and also syncs `apps/sk`; each app's
sync is atomic per tool/source — a failure keeps that entry's previous
lock state while everything else syncs, then the run fails. To sync one
tool/source immediately, dispatch it:
`gh workflow run sync.yml -R qntx/sh -f tool=<key>` (or `-f
source=<owner/repo>`); needs a token with `actions: write` on qntx/sh.
Every failing entry gets a `sync`-labelled tracking issue that is
updated by each failing run and closed automatically when it syncs
again.

## Deploy

- **sh.qntx.org** — the `sh` Worker is connected to this repository by
  Cloudflare Workers Builds: every push to `main` builds `apps/sh` and
  deploys it to production within about a minute, whether or not CI ran
  for that commit, let alone passed. Its build and deploy commands are
  configured in the Cloudflare dashboard, not in this repository; each
  push gets a `Workers Builds: sh` check run.
- **sk.qntx.org** — the `sk` Worker is not connected to Workers Builds.
  It changes only when someone deploys it, so after a `Sync` commit that
  touches `apps/sk/` or a merged `apps/sk` change, run
  `cd apps/sk && bun run build && bun run deploy`.

Because a push to `main` is a production deploy of sh.qntx.org, `main`
must only receive commits that already passed CI or an equivalent gate:

- merges of pull requests whose CI is green (Dependabot's automatic
  merges included — they merge only green pull requests), and
- the `Sync` job's lock commit, which the same job builds offline
  (`bun run build`) before it pushes.

Never push to `main` directly. Commits pushed with `GITHUB_TOKEN` (the
Sync commit, automatic Dependabot merges) trigger no `push` workflow, so
the gate is the pull request's CI or the Sync job's build — not a CI run
on `main`. CI also runs on `main` daily (05:41 UTC, after the Dependabot
merges) and on `workflow_dispatch`, so `main` always has a current
result.

Preview a deploy (no traffic switch) from an app dir:

```bash
cd apps/sh && bunx wrangler versions upload
```

## Commits

English Conventional Commits: `type(scope): subject` (`feat`, `fix`,
`docs`, `style`, `refactor`, `perf`, `test`, `chore`, `ci`, `build`,
`revert`), subject in imperative mood, no period, ≤ 50 chars;
`BREAKING CHANGE:` footer for breaking changes.

## Documentation policy

`docs/` is public documentation mirrored to docs.qntx.org. Local-only
design material must never be committed.

## License

Contributions are dual-licensed under MIT OR Apache-2.0.
