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
packages/github/  @qntx/github — private: minimal GitHub client, release selection, lock I/O
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

Preview a deploy (no traffic switch):

```bash
cd apps/sh && npx wrangler versions upload
```

## Deploy

`sh.qntx.org` is deployed from `main` via Cloudflare Workers static
assets; `bun run build` must be green before deploy.

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
