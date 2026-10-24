# upg

Self-upgrade helper for QuantX CLIs: the shared `upgrade` subcommand that
re-runs the official [sh.qntx.org](https://sh.qntx.org) installer. `upg`
never downloads archives or verifies hashes itself — the installer does.

## Integration

```rust
// clap Subcommand variant:
#[command(visible_alias = "update")]
Upgrade(upg::Args),

// dispatch:
println!("{}", upg::run(&TOOL, &args)?);
```

## Behaviour

| Situation                                           | Result                                               |
| --------------------------------------------------- | ---------------------------------------------------- |
| `--check` (any install method)                      | `Available` / `UpToDate`                             |
| Installed by the sh.qntx.org script (receipt match) | re-run installer; `Upgraded` / `UpToDate`            |
| Installed under `$CARGO_HOME/bin`                   | `Cargo { command }` — print the cargo hint           |
| Anything else                                       | `Error::Unmanaged` with the one-line install command |
| No prebuilt binary for the platform                 | `Error::Unsupported` (installer exit 3)              |
| Installer exits non-zero                            | `Error::Installer { code }`                          |

Script bytes are fetched once per `run` (curl, wget fallback); PowerShell
invocation ends with `; exit $LASTEXITCODE` so the process exit code is the
installer's. Child stdout is redirected to stderr so callers can print JSON.

## License

Dual-licensed under MIT OR Apache-2.0.
