<!-- markdownlint-disable MD033 MD041 MD036 -->

# sh

Install-script proxy for [qntx](https://github.com/qntx) GitHub projects. Every repo gets a `curl | sh` endpoint with zero per-repo boilerplate. Deployed at **[sh.qntx.org](https://sh.qntx.org)** as a Cloudflare Worker.

## Usage

```sh
# Install
curl -fsSL https://sh.qntx.org/<repo> | sh
irm https://sh.qntx.org/<repo>/ps | iex

# Uninstall
curl -fsSL https://sh.qntx.org/<repo> | sh -s -- --uninstall
$env:UNINSTALL=1; irm https://sh.qntx.org/<repo>/ps | iex

# Preview without mutating disk / PATH (may still call GitHub API for latest version)
curl -fsSL https://sh.qntx.org/<repo> | sh -s -- --dry-run
$env:DRY_RUN=1; irm https://sh.qntx.org/<repo>/ps | iex
```

### Routes

| Path           | Target                                       |
| -------------- | -------------------------------------------- |
| `/`            | `qntx/ovo`, shell                            |
| `/ps`          | `qntx/ovo`, PowerShell                       |
| `/{repo}`      | `qntx/{repo}`, shell                         |
| `/{repo}/ps`   | `qntx/{repo}`, PowerShell                    |
| `/labs/{repo}` | `qntx-labs/{repo}` (optionally suffix `/ps`) |

A trailing path segment `ps` always selects the PowerShell installer (including `/ps` → default repo). A repository literally named `ps` cannot be served as a shell installer via that path shape.

### Configuration

`<BIN>` is the uppercased binary name (dashes → underscores).

| Variable            | Purpose                                                                 | Default                                                 |
| ------------------- | ----------------------------------------------------------------------- | ------------------------------------------------------- |
| `<BIN>_VERSION`     | Pin a specific version (no `v` prefix)                                  | latest release                                          |
| `<BIN>_INSTALL_DIR` | Install directory (absolute; Unix: safe path chars only)                | `~/.local/bin` (Unix), `%LOCALAPPDATA%\<bin>` (Windows) |
| `UNINSTALL=1`       | Remove the binary (and platform-specific PATH cleanup — see below)      | —                                                       |
| `DRY_RUN=1`         | Print planned actions without writing files or changing PATH            | —                                                       |
| `HELP=1`            | Show installer usage and exit (Unix also accepts `-h` / `--help`)       | —                                                       |
| `NO_COLOR`          | Disable colored output (Unix only)                                      | —                                                       |
| `GITHUB_PATH`       | When set (GitHub Actions), append install dir; skip shell/user PATH     | —                                                       |

**Uninstall PATH behavior**

- **Unix:** deletes the binary and the fish `conf.d` snippet when present. Does **not** rewrite `.zshrc` / `.bashrc` / etc. PATH lines (left in place with a note).
- **Windows:** deletes the binary; removes the install directory from the user `PATH` only when that directory is empty afterward (shared install dirs keep their PATH entry).

```sh
SKILLS_VERSION=0.1.0 sh -c "$(curl -fsSL https://sh.qntx.org/skill)"
```

## How it works

```text
curl sh.qntx.org/<repo>
 └─ GET raw/<org>/<repo>/main/install.{sh,ps1}
     ├─ 200 → serve verbatim (repo fully controls its installer)
     └─ 404 ↓
        ├─ GET raw/qntx/sh/main/install.{sh,ps1}   (template)
        ├─ GET raw/<org>/<repo>/main/install.bin   (optional BIN override)
        └─ render __REPO__ / __BIN__ → serve
```

BIN defaults to the repo name when that name is a valid binary identifier. Repo names that are not valid BIN values (e.g. containing `.`) require a one-line `install.bin` at the repo root; otherwise the Worker returns 502.

Each downstream repo adds **zero to two files** depending on customization:

| Scenario                                  | Files at repo root                         |
| ----------------------------------------- | ------------------------------------------ |
| `BIN` matches repo name, default template | *nothing*                                  |
| `BIN` differs from repo name              | `install.bin` — single line, e.g. `skills` |
| Completely custom installer               | `install.sh` and/or `install.ps1`          |

### Release artifact convention

The default template expects each GitHub release to contain:

- Unix: `<bin>-<version>-<target>.tar.gz`
- Windows: `<bin>-<version>-<target>.zip`

where `<target>` is a Rust target triple such as `x86_64-unknown-linux-gnu`, `aarch64-apple-darwin`, or `x86_64-pc-windows-msvc`. The archive root must contain the executable `<bin>` (`<bin>.exe` on Windows); an optional single top-level directory is tolerated. This matches the default output of [`cargo-dist`](https://opensource.axo.dev/cargo-dist/) and `GoReleaser`.

### Template features

The default `install.{sh,ps1}` ships with:

- **Network retry** with exponential backoff, up to 3 attempts
- **Multi-shell PATH** — writes `.zshrc`, `.bashrc`, `.bash_profile`, `.profile`, and `~/.config/fish/conf.d/` when present (Unix; skipped when `GITHUB_PATH` is set)
- **Safe install dir** — absolute only; Unix rejects paths with shell-metacharacters before embedding in rc files
- **POSIX sh isolation** — installer helpers use prefixed names (no `local`); never clobber the install-dir variable
- **Input validation** — `REPO` / `BIN` / version strings must be safe identifiers
- **musl detection** on Linux (picks `unknown-linux-musl` vs `unknown-linux-gnu`)
- **Rosetta 2 override** on Apple Silicon
- **`WM_SETTINGCHANGE` broadcast** on Windows via P/Invoke so new shells pick up PATH immediately
- **GitHub Actions integration** — appends to `$GITHUB_PATH` when set (Unix and Windows)
- **Uninstall / dry-run / help** modes (dry-run applies to uninstall as well)

## Development

```sh
wrangler dev      # local preview at http://localhost:8787
wrangler deploy   # ship to Cloudflare
```

The custom domain `sh.qntx.org` is bound via Cloudflare Dashboard → Workers → Custom Domains.

### What requires a redeploy

| Change                                     | Redeploy Worker?                                     |
| ------------------------------------------ | ---------------------------------------------------- |
| Edit `install.sh` / `install.ps1` template | No — push `main`; edge cache ≤1h for 200s (or purge) |
| Edit `src/index.js`                        | Yes — `wrangler deploy`                              |

Upstream fetches use status-aware edge TTLs: successful responses ~1h, `404` ~60s, `5xx` not cached.

### HTTP semantics

| Status | Cause                                                                           |
| ------ | ------------------------------------------------------------------------------- |
| `200`  | Script returned, `Cache-Control: public, max-age=3600`                          |
| `404`  | Invalid path (unparseable route)                                                |
| `405`  | Method other than `GET` / `HEAD`                                                |
| `500`  | Unexpected Worker error                                                         |
| `502`  | Upstream failure, timeout, template unavailable, or invalid BIN / `install.bin` |

---

<div align="center">

A **[QuantX](https://qntx.org)** open-source project.

<a href="https://qntx.org"><img alt="QuantX" width="369" src="https://raw.githubusercontent.com/qntx/.github/main/profile/qntx.svg" /></a>

Code is law. We write both.

</div>
