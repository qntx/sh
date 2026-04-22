<!-- markdownlint-disable MD033 MD041 MD036 -->

# sh

Install-script proxy for [qntx](https://github.com/qntx) GitHub projects. Every repo gets a `curl | sh` endpoint with zero per-repo boilerplate. Deployed at **[sh.qntx.fun](https://sh.qntx.fun)** as a Cloudflare Worker.

## Usage

```sh
# Install
curl -fsSL https://sh.qntx.fun/<repo> | sh
irm https://sh.qntx.fun/<repo>/ps | iex

# Uninstall
curl -fsSL https://sh.qntx.fun/<repo> | sh -s -- --uninstall
$env:UNINSTALL=1; irm https://sh.qntx.fun/<repo>/ps | iex

# Preview without executing
curl -fsSL https://sh.qntx.fun/<repo> | sh -s -- --dry-run
$env:DRY_RUN=1; irm https://sh.qntx.fun/<repo>/ps | iex
```

### Routes

| Path           | Target                                       |
| -------------- | -------------------------------------------- |
| `/`            | `qntx/ovo`, shell                            |
| `/ps`          | `qntx/ovo`, PowerShell                       |
| `/{repo}`      | `qntx/{repo}`, shell                         |
| `/{repo}/ps`   | `qntx/{repo}`, PowerShell                    |
| `/labs/{repo}` | `qntx-labs/{repo}` (optionally suffix `/ps`) |

### Configuration

`<BIN>` is the uppercased binary name (dashes → underscores).

| Variable            | Purpose                                 | Default                                                 |
| ------------------- | --------------------------------------- | ------------------------------------------------------- |
| `<BIN>_VERSION`     | Pin a specific version (no `v` prefix)  | latest release                                          |
| `<BIN>_INSTALL_DIR` | Install directory                       | `~/.local/bin` (Unix), `%LOCALAPPDATA%\<bin>` (Windows) |
| `UNINSTALL=1`       | Remove the binary and its PATH entries  | —                                                       |
| `DRY_RUN=1`         | Print planned actions without executing | —                                                       |
| `HELP=1`            | Show installer usage and exit           | —                                                       |
| `NO_COLOR`          | Disable colored output (Unix only)      | —                                                       |

```sh
SKILLS_VERSION=0.1.0 sh -c "$(curl -fsSL https://sh.qntx.fun/skill)"
```

## How it works

```text
curl sh.qntx.fun/<repo>
 └─ GET raw/<org>/<repo>/main/install.{sh,ps1}
     ├─ 200 → serve verbatim (repo fully controls its installer)
     └─ 404 ↓
        ├─ GET raw/qntx/sh/main/install.{sh,ps1}   (template)
        ├─ GET raw/<org>/<repo>/main/install.bin   (optional BIN override)
        └─ render __REPO__ / __BIN__ → serve
```

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
- **Multi-shell PATH** — writes `.zshrc`, `.bashrc`, `.bash_profile`, `.profile`, and `~/.config/fish/conf.d/` when present
- **musl detection** on Linux (picks `unknown-linux-musl` vs `unknown-linux-gnu`)
- **Rosetta 2 override** on Apple Silicon
- **`WM_SETTINGCHANGE` broadcast** on Windows via P/Invoke so new shells pick up PATH immediately
- **GitHub Actions integration** — appends to `$GITHUB_PATH` when set
- **Uninstall / dry-run / help** modes

## Development

```sh
wrangler dev      # local preview at http://localhost:8787
wrangler deploy   # ship to Cloudflare
```

The custom domain `sh.qntx.fun` is bound via Cloudflare Dashboard → Workers → Custom Domains.

### What requires a redeploy

| Change                                     | Redeploy Worker?                                   |
| ------------------------------------------ | -------------------------------------------------- |
| Edit `install.sh` / `install.ps1` template | No — push `main`; edge cache ≤1h (or manual purge) |
| Edit `src/index.js`                        | Yes — `wrangler deploy`                            |

### HTTP semantics

| Status | Cause                                                  |
| ------ | ------------------------------------------------------ |
| `200`  | Script returned, `Cache-Control: public, max-age=3600` |
| `404`  | Invalid path or upstream template missing              |
| `405`  | Method other than `GET` / `HEAD`                       |
| `500`  | Unexpected Worker error                                |
| `502`  | Upstream failure, 10s timeout, or template unavailable |

---

<div align="center">

A **[QNTX](https://qntx.fun)** open-source project.

<a href="https://qntx.fun"><img alt="QNTX" width="369" src="https://raw.githubusercontent.com/qntx/.github/main/profile/qntx-banner.svg" /></a>

<!--prettier-ignore-->
Code is law. We write both.

</div>
