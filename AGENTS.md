# AGENTS.md

- Do not preserve backward compatibility. Remove obsolete paths instead of adding compatibility layers, fallbacks, or migrations.
- Choose the simplest implementation that fully meets the current requirements. Avoid speculative abstractions, configuration, and indirection.
- Grow the system in layers. Start from the smallest version that works end to end, and add each new capability on top of a product that already works. Never trade a working product for unfinished complexity.
- Keep components modular and concerns clearly separated.
- Prefer established, well-maintained libraries when they reduce overall complexity or improve reliability. Do not reimplement common functionality without a clear reason.
- Lean on the dependencies already in the project before writing your own implementation or adding packages. Do not assume a library lacks a capability without checking its documentation and types.
- Make architectural decisions for the long term. Do not accept a stopgap that only works for now and is meant to be replaced later.

## Architecture invariants

- Vite+ (vp) monorepo: `apps/sh` is the sh.qntx.org static site;
  `packages/github` is a private shared package (never published).
- Static site: `bun run build` renders `apps/sh/dist/` offline and
  deterministically from `catalog.json` (human) + `releases.json`
  (sync-generated lock) + `templates/`. Nothing runs at request time.
- Only the sync task (`bun run sync` in `apps/sh`, cron every 15 min)
  calls the GitHub API, via `@qntx/github`; it locks the newest stable
  `vX.Y.Z` tag, verifies every asset's `.sha256` (plus the API `digest`
  when present), inspects archives, and refuses a shrinking target set
  unless forced. Failures are atomic: nothing is written.
- The installer contract (flags, env vars, exit codes 0/1/2/3, receipt
  JSON) is public and additive-only. `apps/sh/templates/install.sh` is
  POSIX — no `eval`, no `local`; scripts and generated dist output are
  pure ASCII; secrets never appear in the scripts.
- Code uses Node-standard APIs only (`node:fs`, `node:path`, `node:crypto`,
  `node:child_process`, `node:url`, global `fetch`) so it runs under both
  Bun (scripts) and `vp test` (vitest). No `Bun.*` APIs.
- Runtime dependencies: none. Every devDependency is exact-pinned and at
  least 7 days old at adoption. TOML is formatted by taplo
  (`.taplo.toml`, aligned `=`).

## Commands

Local gate before a pull request:

```bash
bun install --frozen-lockfile
bun run lint          # vp check + taplo fmt --check
bun run typecheck
bun run build         # offline render into apps/sh/dist/
bun run test
for f in apps/sh/dist/*.sh; do shellcheck -s sh "$f"; done
shellcheck -s sh apps/sh/tests/e2e/unix.sh
for f in apps/sh/dist/*.sh; do shfmt -i 4 -ci -d "$f"; done
shfmt -i 4 -ci -d apps/sh/tests/e2e/unix.sh
sh apps/sh/tests/e2e/unix.sh apps/sh/dist/kobe.sh   # e2e on Unix
# on Windows runners:
#   powershell -NoProfile -ExecutionPolicy Bypass -File apps/sh/tests/e2e/windows.ps1
#   pwsh -NoProfile -File apps/sh/tests/e2e/windows.ps1
#   Invoke-ScriptAnalyzer on apps/sh/dist/*.ps1 + apps/sh/tests/e2e/windows.ps1
npx --yes markdownlint-cli2@0.23.3 "*.md" "docs/**/*.mdx"
```

Sync the release lock (needs `GITHUB_TOKEN`, e.g. `$(gh auth token)`):

```bash
cd apps/sh && bun run sync          # SYNC_TOOL=<key> SYNC_FORCE=true
```

Preview a deploy (no traffic switch):

```bash
cd apps/sh && npx wrangler versions upload
```
