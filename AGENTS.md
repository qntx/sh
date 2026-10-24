# AGENTS.md

- Do not preserve backward compatibility. Remove obsolete paths instead of adding compatibility layers, fallbacks, or migrations.
- Choose the simplest implementation that fully meets the current requirements. Avoid speculative abstractions, configuration, and indirection.
- Grow the system in layers. Start from the smallest version that works end to end, and add each new capability on top of a product that already works. Never trade a working product for unfinished complexity.
- Keep components modular and concerns clearly separated.
- Prefer established, well-maintained libraries when they reduce overall complexity or improve reliability. Do not reimplement common functionality without a clear reason.
- Lean on the dependencies already in the project before writing your own implementation or adding packages. Do not assume a library lacks a capability without checking its documentation and types.
- Make architectural decisions for the long term. Do not accept a stopgap that only works for now and is meant to be replaced later.

## Architecture invariants

- Static site: `bun run build` renders `dist/` offline and deterministically
  from `catalog.json` (human) + `releases.json` (sync-generated lock) +
  `templates/`. Nothing runs at request time.
- Only the sync task (`bun run sync`, cron every 15 min) calls the GitHub
  API; it locks the newest stable `vX.Y.Z` tag, verifies every asset's
  `.sha256` (plus the API `digest` when present), inspects archives, and
  refuses a shrinking target set unless forced. Failures are atomic:
  nothing is written.
- The installer contract (flags, env vars, exit codes 0/1/2/3, receipt JSON)
  is public and additive-only. `templates/install.sh` is POSIX — no `eval`,
  no `local`; secrets never appear in the scripts.
- `installer: "repo"` tools (bux) sync `install.sh`/`install.ps1` from the
  locked tag into `tools/<key>/` with sha256 recorded in the lock; `bun run
  build` fails if they drift.
- Runtime dependencies: none. Every devDependency is exact-pinned and at
  least 7 days old at adoption.

## Commands

Local gate before a pull request:

```bash
bun install --frozen-lockfile
bun run lint          # oxfmt --check && oxlint
bun run typecheck
bun run build         # offline render into dist/
bun run test
for f in dist/*.sh; do [ "$f" != dist/bux.sh ] && shellcheck -s sh "$f"; done
shellcheck -s sh -S error tools/bux/install.sh dist/bux.sh   # upstream-owned
for f in dist/*.sh; do [ "$f" != dist/bux.sh ] && shfmt -i 4 -ci -d "$f"; done
npx markdownlint-cli2 "*.md" "docs/*.mdx" "skills/**/*.md"
```

Sync the release lock (needs `GITHUB_TOKEN`, e.g. `$(gh auth token)`):

```bash
bun run sync          # SYNC_TOOL=<key> SYNC_FORCE=true for manual control
```

Preview a deploy (no traffic switch):

```bash
npx wrangler versions upload
```
