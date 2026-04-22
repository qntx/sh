<!-- markdownlint-disable MD033 MD041 MD036 -->

# sh

Install-script proxy for [qntx](https://github.com/qntx) GitHub projects. Every repo gets a `curl | sh` endpoint with zero per-repo boilerplate. Deployed at **[sh.qntx.fun](https://sh.qntx.fun)** as a Cloudflare Worker.

## Usage

```sh
# Unix / macOS
curl -fsSL https://sh.qntx.fun/<repo> | sh

# Windows PowerShell
irm https://sh.qntx.fun/<repo>/ps | iex
```

### Routes

| Path           | Target                                       |
| -------------- | -------------------------------------------- |
| `/`            | `qntx/ovo`, shell                            |
| `/ps`          | `qntx/ovo`, PowerShell                       |
| `/{repo}`      | `qntx/{repo}`, shell                         |
| `/{repo}/ps`   | `qntx/{repo}`, PowerShell                    |
| `/labs/{repo}` | `qntx-labs/{repo}` (optionally suffix `/ps`) |

### Runtime overrides

`<BIN>` is the uppercased binary name.

| Variable            | Purpose                                | Default                                                 |
| ------------------- | -------------------------------------- | ------------------------------------------------------- |
| `<BIN>_VERSION`     | Pin a specific version (no `v` prefix) | latest release                                          |
| `<BIN>_INSTALL_DIR` | Install directory                      | `~/.local/bin` (Unix), `%LOCALAPPDATA%\<bin>` (Windows) |

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

where `<target>` is a Rust target triple such as `x86_64-unknown-linux-gnu`, `aarch64-apple-darwin`, or `x86_64-pc-windows-msvc`. The archive root must contain the executable `<bin>` (`<bin>.exe` on Windows). This matches the default output of [`cargo-dist`](https://opensource.axo.dev/cargo-dist/) and `GoReleaser`.

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
| `502`  | Upstream GitHub failure or 10s timeout                 |

---

<div align="center">

A **[QNTX](https://qntx.fun)** open-source project.

<a href="https://qntx.fun"><img alt="QNTX" width="369" src="https://raw.githubusercontent.com/qntx/.github/main/profile/qntx-banner.svg" /></a>

<!--prettier-ignore-->
Code is law. We write both.

</div>
