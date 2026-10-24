#!/bin/sh
# qntx installer for one tool, rendered by src/render.ts and served by
# sh.qntx.org. POSIX sh only: no eval, no local (temporaries are prefixed).
#
# Usage:
#   curl -fsSL <url> | sh                          # install the locked latest
#   curl -fsSL <url> | sh -s -- --version 6.0.0    # install a pinned version
#   curl -fsSL <url> | sh -s -- --uninstall        # uninstall
#
# Public contract (additive-only): the option names, environment variables,
# exit codes and the receipt format below must never change incompatibly.
# Exit codes: 0 ok (including "up to date"), 1 failure, 2 bad arguments,
# 3 unsupported platform.

set -eu

# @qntx-constants

main() {
    _m_version="$VERSION"
    _m_dir=''
    _m_no_path=0
    _m_force=0
    _m_check=0
    _m_uninstall=0
    _m_dry=0
    _m_quiet=0
    _m_pinned=0

    if [ -n "$CFG_VERSION" ]; then
        _m_version="$CFG_VERSION"
        _m_pinned=1
    fi
    if [ -n "$CFG_INSTALL_DIR" ]; then
        _m_dir="$CFG_INSTALL_DIR"
    fi
    [ "$CFG_NO_MODIFY_PATH" = '1' ] && _m_no_path=1

    while [ $# -gt 0 ]; do
        _m_opt=$1
        case "$_m_opt" in
            --version=*)
                _m_version=${_m_opt#*=}
                _m_pinned=1
                ;;
            --version)
                shift
                [ $# -gt 0 ] || usage_error '--version requires a value'
                _m_version=$1
                _m_pinned=1
                ;;
            --install-dir=*)
                _m_dir=${_m_opt#*=}
                ;;
            --install-dir)
                shift
                [ $# -gt 0 ] || usage_error '--install-dir requires a value'
                _m_dir=$1
                ;;
            --no-modify-path) _m_no_path=1 ;;
            --force) _m_force=1 ;;
            --check) _m_check=1 ;;
            --uninstall) _m_uninstall=1 ;;
            --dry-run) _m_dry=1 ;;
            --quiet) _m_quiet=1 ;;
            --help | -h)
                usage
                exit 0
                ;;
            *) usage_error "unknown option: $_m_opt" ;;
        esac
        shift
    done

    if ! printf '%s' "$_m_version" |
        grep -Eq '^[0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z.-]+)?$'; then
        usage_error "version must be x.y.z[-suffix]: $_m_version"
    fi

    if [ -z "${HOME:-}" ]; then
        err 'HOME is unset'
    fi

    CFG_DIR=${XDG_CONFIG_HOME:-"$HOME/.config"}
    RECEIPTS="$CFG_DIR/qntx/receipts"
    RECEIPT="$RECEIPTS/$TOOL.json"

    if [ "$_m_check" = 1 ]; then
        printf '%s\n' "$_m_version"
        exit 0
    fi

    _m_dir=$(resolve_dir "$_m_dir")

    if [ "$_m_uninstall" = 1 ]; then
        uninstall "$_m_dir" "$_m_dry"
        exit 0
    fi

    install "$_m_version" "$_m_dir" "$_m_pinned" "$_m_force" "$_m_dry" "$_m_quiet" "$_m_no_path"
}

usage_error() {
    printf 'error: %s\n' "$1" >&2
    exit 2
}

say() {
    [ "${_say_quiet:-0}" = 1 ] && return 0
    if [ "${_say_color:-0}" = 1 ]; then
        printf ' \033[32m%11s\033[0m %s\n' "$1" "$2" >&2
    else
        printf ' %11s %s\n' "$1" "$2" >&2
    fi
}

err() {
    printf 'error: %s\n' "$1" >&2
    exit 1
}

err_platform() {
    printf 'error: %s\n' "$1" >&2
    if [ -n "$PACKAGE" ]; then
        printf '%s\n' "install from source: cargo install $PACKAGE --locked" >&2
    else
        printf '%s\n' "build from source: https://github.com/$REPO" >&2
    fi
    exit 3
}

have() { command -v "$1" >/dev/null 2>&1; }

usage() {
    cat <<EOF
Installer for $TOOL ($REPO), locked at $VERSION.

Usage:
  curl -fsSL <url> | sh -s -- [options]

Options:
  --version <x.y.z>     Install a specific version (default: $VERSION)
  --install-dir <dir>   Install directory (default: ~/.local/bin)
  --no-modify-path      Do not add the install dir to PATH
  --force               Reinstall even when up to date
  --check               Print the target version and exit
  --uninstall           Remove the binary, receipt and PATH entry
  --dry-run             Print what would happen
  --quiet               Print only errors
  --help                Show this text

Environment:
  ${ENV_PREFIX}_VERSION         Same as --version
  ${ENV_PREFIX}_INSTALL_DIR     Same as --install-dir
  ${ENV_PREFIX}_NO_MODIFY_PATH  1 = same as --no-modify-path
  NO_COLOR                      Disable colored output
EOF
}

# Absolute-path + safe-charset validation for the install dir (the string is
# later embedded into rc files and the JSON receipt unescaped).
resolve_dir() {
    _rd_dir=$1
    if [ -z "$_rd_dir" ]; then
        _rd_dir=${XDG_BIN_HOME:-"$HOME/.local/bin"}
    fi
    case "$_rd_dir" in
        /*) ;;
        *) err "install dir must be an absolute path: $_rd_dir" ;;
    esac
    case "$_rd_dir" in
        *//* | *..*) err "unsafe install dir: $_rd_dir" ;;
    esac
    case "$_rd_dir" in
        *[!A-Za-z0-9/._+-]*) err "install dir has unsafe characters: $_rd_dir" ;;
    esac
    printf '%s\n' "$_rd_dir"
}

is_musl_host() {
    for _mh_p in /lib/ld-musl-* /usr/lib/ld-musl-* /lib64/ld-musl-*; do
        [ -e "$_mh_p" ] && return 0
    done
    return 1
}

# Ordered target candidates for this host, one rule for locked and pinned
# versions alike: Linux prefers the musl triple, then gnu on glibc hosts
# only; macOS maps Rosetta shells onto aarch64; Windows shells exit 3.
candidates() {
    _c_os=$(uname -s)
    _c_arch=$(uname -m)
    case "$_c_arch" in
        x86_64 | amd64) _c_arch=x86_64 ;;
        aarch64 | arm64) _c_arch=aarch64 ;;
        *) err_platform "unsupported architecture: $_c_arch" ;;
    esac
    case "$_c_os" in
        Linux)
            _c_list="$_c_arch-unknown-linux-musl"
            if ! is_musl_host; then
                _c_list="$_c_list $_c_arch-unknown-linux-gnu"
            fi
            printf '%s\n' "$_c_list"
            ;;
        Darwin)
            if [ "$_c_arch" = x86_64 ] &&
                [ "$(sysctl -n sysctl.proc_translated 2>/dev/null || true)" = '1' ]; then
                _c_arch=aarch64
            fi
            if [ "$_c_arch" = aarch64 ]; then
                printf '%s\n' 'aarch64-apple-darwin'
            else
                err_platform "$TOOL has no prebuilt binary for $_c_arch-apple-darwin"
            fi
            ;;
        MINGW* | MSYS* | CYGWIN*)
            printf 'error: use PowerShell instead: irm https://sh.qntx.org/%s/ps | iex\n' "$TOOL" >&2
            exit 3
            ;;
        *) err_platform "unsupported OS: $_c_os" ;;
    esac
}

http_get() {
    _hg_url=$1
    _hg_out=${2:-}
    if have curl; then
        if [ -n "$_hg_out" ]; then
            curl --proto '=https' --tlsv1.2 -fsSL --retry 3 -A "$TOOL-installer" -o "$_hg_out" "$_hg_url"
        else
            curl --proto '=https' --tlsv1.2 -fsSL --retry 3 -A "$TOOL-installer" "$_hg_url"
        fi
    elif have wget; then
        if [ -n "$_hg_out" ]; then
            wget -q -O "$_hg_out" "$_hg_url"
        else
            wget -q -O - "$_hg_url"
        fi
    else
        err 'curl or wget is required'
    fi
}

sha256_of() {
    if have sha256sum; then
        sha256sum "$1" | cut -d' ' -f1
    elif have shasum; then
        shasum -a 256 "$1" | cut -d' ' -f1
    elif have openssl; then
        openssl dgst -sha256 "$1" | sed 's/^.*= //'
    else
        err 'sha256sum, shasum or openssl is required'
    fi
}

receipt_fields() {
    # Parse the fields our own receipt format writes.
    _rf_field=$1
    sed -n "s/.*\"$_rf_field\"[[:space:]]*:[[:space:]]*\"\([^\"]*\)\".*/\1/p" "$RECEIPT" | head -n 1
}

install() {
    _i_version=$1
    _i_dir=$2
    _i_pinned=$3
    _i_force=$4
    _i_dry=$5
    _i_quiet=$6
    _i_no_path=$7
    _say_quiet=$_i_quiet
    if [ -t 2 ] && [ -z "${NO_COLOR:-}" ]; then _say_color=1; else _say_color=0; fi

    # Idempotency: receipt version + dir match and the binary exists.
    if [ "$_i_force" = 0 ] && [ -f "$RECEIPT" ] && [ -f "$_i_dir/$TOOL" ]; then
        _i_rv=$(receipt_fields version)
        _i_rd=$(receipt_fields install_dir)
        if [ "$_i_rv" = "$_i_version" ] && [ "$_i_rd" = "$_i_dir" ]; then
            say 'Skipping' "$TOOL $_i_version is up to date"
            exit 0
        fi
    fi

    _i_candidates=$(candidates)
    _i_base="https://github.com/$REPO/releases/download/v$_i_version"
    _i_target=''
    _i_asset=''

    if [ "$_i_dry" = 1 ]; then
        if [ "$_i_pinned" = 0 ]; then
            _i_target=${_i_candidates%% *}
            say 'Downloading' "$_i_base/$TOOL-$_i_version-$_i_target.tar.gz"
        else
            say 'Probing' "$_i_candidates"
        fi
        say 'Installing' "$_i_dir/$TOOL"
        exit 0
    fi

    _i_tmp=$(mktemp -d)
    # shellcheck disable=SC2064
    trap "rm -rf '$_i_tmp'" EXIT
    trap 'exit 130' INT
    trap 'exit 143' TERM

    if [ "$_i_pinned" = 0 ]; then
        # Locked version: the first candidate present in the embedded table.
        for _i_t in $_i_candidates; do
            if asset_sha256 "$_i_t" >/dev/null 2>&1; then
                _i_target=$_i_t
                break
            fi
        done
        [ -n "$_i_target" ] ||
            err_platform "$TOOL has no prebuilt binary for this platform"
        _i_asset="$TOOL-$_i_version-$_i_target.tar.gz"
        _i_hash=$(asset_sha256 "$_i_target")
    else
        # Pinned version: probe the candidates' .sha256 URLs in order; the
        # first that downloads wins under the same musl-first rule.
        _i_got=''
        for _i_t in $_i_candidates; do
            _i_a="$TOOL-$_i_version-$_i_t.tar.gz"
            if http_get "$_i_base/$_i_a.sha256" "$_i_tmp/sum" 2>/dev/null; then
                _i_target=$_i_t
                _i_asset=$_i_a
                _i_got=1
                break
            fi
        done
        [ -n "$_i_got" ] || err "no $_i_version asset for this platform"
        _i_line=$(head -n 1 "$_i_tmp/sum")
        _i_hash=${_i_line%% *}
        _i_name=${_i_line##* }
        case "$_i_hash" in
            *[!0-9a-f]*) err "malformed .sha256 file" ;;
        esac
        if [ "${#_i_hash}" -ne 64 ]; then
            err "malformed .sha256 file"
        fi
        # sha256sum may record `*<name>` (binary mode) or `dist/<name>`.
        _i_name=${_i_name#\*}
        case "$_i_name" in
            "$_i_asset" | "dist/$_i_asset") ;;
            *) err "bad .sha256 file for $_i_asset" ;;
        esac
    fi

    say 'Downloading' "$TOOL $_i_version ($_i_target)"
    http_get "$_i_base/$_i_asset" "$_i_tmp/$_i_asset" ||
        err "failed to download $_i_base/$_i_asset"

    _i_sum=$(sha256_of "$_i_tmp/$_i_asset")
    if [ "$_i_sum" != "$_i_hash" ]; then
        err "sha256 mismatch for $_i_asset"
    fi
    _i_short=$(printf '%s' "$_i_sum" | cut -c1-12)
    _i_tail=$(printf '%s' "$_i_sum" | cut -c57-64)
    say 'Verified' "sha256 ${_i_short}...${_i_tail}"

    tar -xzf "$_i_tmp/$_i_asset" -C "$_i_tmp" "./$TOOL" ||
        err "archive has no ./$TOOL member"
    if [ ! -f "$_i_tmp/$TOOL" ] || [ -L "$_i_tmp/$TOOL" ]; then
        err "extracted $TOOL is not a regular file"
    fi
    chmod 755 "$_i_tmp/$TOOL"

    _i_escaped=$(printf '%s' "$_i_version" | sed 's/\./\\./g')
    if ! "$_i_tmp/$TOOL" --version 2>&1 |
        grep -Eq "(^|[^0-9.])${_i_escaped}([^0-9.]|\$)"; then
        err "self-check failed: $TOOL --version did not report $_i_version"
    fi
    say 'Verified' "runs $_i_version"

    mkdir -p "$_i_dir"
    cp "$_i_tmp/$TOOL" "$_i_dir/.$TOOL.tmp.$$"
    chmod 755 "$_i_dir/.$TOOL.tmp.$$"
    mv -f "$_i_dir/.$TOOL.tmp.$$" "$_i_dir/$TOOL"

    mkdir -p "$RECEIPTS"
    printf '{"schema":1,"tool":"%s","version":"%s","install_dir":"%s"}\n' \
        "$TOOL" "$_i_version" "$_i_dir" >"$RECEIPTS/.$TOOL.tmp.$$"
    mv -f "$RECEIPTS/.$TOOL.tmp.$$" "$RECEIPT"
    say 'Installed' "$_i_dir/$TOOL"

    if [ "$_i_no_path" = 0 ]; then
        add_path "$_i_dir"
    fi
}

add_path() {
    _ap_dir=$1
    if [ -n "${GITHUB_PATH:-}" ]; then
        printf '%s\n' "$_ap_dir" >>"$GITHUB_PATH"
        return 0
    fi
    case ":$PATH:" in
        *":$_ap_dir:"*) return 0 ;;
    esac
    _ap_rc=''
    _ap_shell=${SHELL:-}
    case "$_ap_shell" in
        */zsh) _ap_rc="$HOME/.zshrc" ;;
        */bash)
            if [ "$(uname -s)" = 'Darwin' ]; then
                _ap_rc="$HOME/.bash_profile"
            else
                _ap_rc="$HOME/.bashrc"
            fi
            ;;
        */fish)
            _ap_rc="$HOME/.config/fish/conf.d/qntx.fish"
            ;;
        *) _ap_rc="$HOME/.profile" ;;
    esac
    case "$_ap_rc" in
        */qntx.fish)
            _ap_line="fish_add_path -g '$_ap_dir' # qntx"
            ;;
        *)
            _ap_line="export PATH=\"$_ap_dir:\$PATH\" # qntx"
            ;;
    esac
    if [ -f "$_ap_rc" ] && grep -qF '# qntx' "$_ap_rc"; then
        return 0
    fi
    mkdir -p "$(dirname "$_ap_rc")"
    printf '%s\n' "$_ap_line" >>"$_ap_rc"
    say 'Added' "PATH entry in $_ap_rc (restart your shell)"
}

remove_path_entry() {
    # Only when this tool was the last one installed via sh.qntx.org.
    [ -d "$RECEIPTS" ] || return 0
    set -- "$RECEIPTS"/*.json
    [ -e "$1" ] && return 0
    for _rp_rc in "$HOME/.zshrc" "$HOME/.bashrc" "$HOME/.bash_profile" \
        "$HOME/.profile"; do
        if [ -f "$_rp_rc" ] && grep -qF '# qntx' "$_rp_rc"; then
            _rp_tmp="$_rp_rc.qntx.$$"
            grep -vF '# qntx' "$_rp_rc" >"$_rp_tmp" || true
            mv -f "$_rp_tmp" "$_rp_rc"
            say 'Removed' "PATH entry in $_rp_rc"
        fi
    done
    _rp_fish="$HOME/.config/fish/conf.d/qntx.fish"
    if [ -f "$_rp_fish" ]; then
        rm -f "$_rp_fish"
        say 'Removed' "$_rp_fish"
    fi
}

uninstall() {
    _u_dir=$1
    _u_dry=$2
    _say_quiet=0
    if [ -t 2 ] && [ -z "${NO_COLOR:-}" ]; then _say_color=1; else _say_color=0; fi

    # Touch the binary only when our receipt says we put it there.
    if [ ! -f "$RECEIPT" ] || [ "$(receipt_fields install_dir)" != "$_u_dir" ]; then
        printf 'error: not installed by sh.qntx.org at %s\n' "$_u_dir" >&2
        exit 1
    fi
    if [ "$_u_dry" = 1 ]; then
        say 'Removing' "$_u_dir/$TOOL and $RECEIPT"
        return 0
    fi
    if [ -f "$_u_dir/$TOOL" ] || [ -L "$_u_dir/$TOOL" ]; then
        rm -f "$_u_dir/$TOOL"
        say 'Removed' "$_u_dir/$TOOL"
    fi
    rm -f "$RECEIPT"
    say 'Removed' "$RECEIPT"
    remove_path_entry
}

main "$@"
