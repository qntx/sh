#!/bin/sh
# Installer for a GitHub-hosted CLI, served via sh.qntx.fun.
#
# Usage:
#   curl -fsSL <url> | sh                            # install
#   curl -fsSL <url> | sh -s -- --uninstall          # uninstall
#   curl -fsSL <url> | sh -s -- --dry-run            # preview
#   curl -fsSL <url> | sh -s -- --help               # show this help
#
# Environment (uppercased BIN, '-' -> '_'):
#   <BIN>_VERSION      Pin a version (default: latest release)
#   <BIN>_INSTALL_DIR  Install directory (default: $HOME/.local/bin)
#   NO_COLOR           Disable color output
#
# POSIX sh has no `local`. Every function MUST use unique prefixed names for
# temporaries so helpers never clobber callers (historical bug: http() set
# global d=1 and overwrote the install directory → ./1/$BIN + PATH="1:...").

set -eu

REPO="__REPO__"
BIN="__BIN__"
UP=$(printf '%s' "$BIN" | tr '[:lower:]' '[:upper:]' | tr '-' '_')

# Refuse un-substituted templates / unsafe identifiers.
# Placeholder tokens are split so Worker replaceAll("__REPO__") does not rewrite
# the detection string itself into the real repo name.
_ph_repo='__''REPO''__'
_ph_bin='__''BIN''__'
if [ "$REPO" = "$_ph_repo" ] || [ -z "$REPO" ]; then
    printf '%s\n' "error: REPO template not substituted" >&2
    exit 1
fi
# REPO must be exactly org/name (one slash), chars [A-Za-z0-9._-].
case "$REPO" in
    */*/* | /* | */ )
        printf '%s\n' "error: REPO must be org/name (one slash): $REPO" >&2
        exit 1
        ;;
    [A-Za-z0-9_.-]*/[A-Za-z0-9_.-]* ) ;;
    *)
        printf '%s\n' "error: invalid REPO: $REPO" >&2
        exit 1
        ;;
esac
if [ "$BIN" = "$_ph_bin" ] || [ -z "$BIN" ]; then
    printf '%s\n' "error: BIN template not substituted" >&2
    exit 1
fi
# BIN must be a plain identifier (matches Worker BIN_RE).
case "$BIN" in
    [A-Za-z0-9][A-Za-z0-9_-]*[A-Za-z0-9] | [A-Za-z0-9] ) ;;
    *)
        printf '%s\n' "error: invalid BIN: $BIN" >&2
        exit 1
        ;;
esac

if [ -z "${HOME:-}" ]; then
    printf '%s\n' "error: HOME is unset" >&2
    exit 1
fi

if [ -t 1 ] && [ -z "${NO_COLOR:-}" ]; then
    B=$(printf '\033[1m')
    R=$(printf '\033[31m')
    N=$(printf '\033[0m')
else
    B=''
    R=''
    N=''
fi

say()  { printf '%s%s%s\n' "$B" "$*" "$N"; }
err()  { printf '%serror%s: %s\n' "$R" "$N" "$*" >&2; exit 1; }
have() { command -v "$1" >/dev/null 2>&1; }

# True if $1 looks like a safe release version (no path / shell metacharacters).
# Accepts: 1.2.3, 1.2.3-beta.1, v1.2.3 (caller strips v).
version_ok() {
    # shellcheck disable=SC2254
    case "$1" in
        '' | *[' /\\'!@#$%^\&*\(\)+=\[\]\{\}\;\:\'\"\\\|\,\?\*]* | *..* ) return 1 ;;
        [0-9]*[0-9A-Za-z._-]* ) return 0 ;;
        *) return 1 ;;
    esac
}

# True if $1 is an absolute path (Unix).
absolute_path() {
    case "$1" in
        /*) return 0 ;;
        *) return 1 ;;
    esac
}

# HTTP GET with 3 attempts and exponential backoff.
# $1=url, $2=outfile (empty for stdout).
http() {
    _http_url=$1
    _http_out=${2:-}
    _http_i=1
    _http_delay=1
    while :; do
        if have curl; then
            if [ -n "$_http_out" ]; then
                curl -fsSL -A "$BIN-installer" -o "$_http_out" "$_http_url" && return 0
            else
                curl -fsSL -A "$BIN-installer" "$_http_url" && return 0
            fi
        elif have wget; then
            if [ -n "$_http_out" ]; then
                wget -q --user-agent="$BIN-installer" -O "$_http_out" "$_http_url" && return 0
            else
                wget -q --user-agent="$BIN-installer" -O- "$_http_url" && return 0
            fi
        else
            err "curl or wget is required"
        fi
        [ "$_http_i" -ge 3 ] && return 1
        sleep "$_http_delay"
        _http_i=$((_http_i + 1))
        _http_delay=$((_http_delay * 2))
    done
}

# Print Rust-style target triple for this host (stdout only).
target() {
    _tgt_os=$(uname -s)
    _tgt_arch=$(uname -m)
    case "$_tgt_os" in
        Linux)
            _tgt_os=unknown-linux-gnu
            for _tgt_p in /lib /lib64 /usr/lib; do
                # shellcheck disable=SC2086
                ls "$_tgt_p"/ld-musl-* >/dev/null 2>&1 && {
                    _tgt_os=unknown-linux-musl
                    break
                }
            done
            ;;
        Darwin)
            _tgt_os=apple-darwin
            # Rosetta 2: uname -m is x86_64 but hardware is arm64.
            if [ "$_tgt_arch" = x86_64 ] \
                && sysctl -n hw.optional.arm64 2>/dev/null | grep -q 1; then
                _tgt_arch=aarch64
            fi
            ;;
        *) err "unsupported OS: $_tgt_os" ;;
    esac
    case "$_tgt_arch" in
        x86_64 | amd64) _tgt_arch=x86_64 ;;
        aarch64 | arm64) _tgt_arch=aarch64 ;;
        *) err "unsupported architecture: $_tgt_arch" ;;
    esac
    printf '%s\n' "$_tgt_arch-$_tgt_os"
}

# Print latest GitHub release version without leading v (stdout only).
latest() {
    _lat_json=$(http "https://api.github.com/repos/$REPO/releases/latest") \
        || err "failed to fetch latest release (network error or rate limited)"
    # Prefer the first "tag_name" field (GitHub puts it near the top of the object).
    _lat_tag=$(printf '%s' "$_lat_json" \
        | sed -n 's/.*"tag_name"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' \
        | head -n 1)
    [ -n "$_lat_tag" ] || err "failed to parse latest version from GitHub API"
    _lat_ver=${_lat_tag#v}
    version_ok "$_lat_ver" || err "refusing unsafe version from GitHub: $_lat_ver"
    printf '%s\n' "$_lat_ver"
}

# Locate $BIN inside an extracted archive; tolerate one nesting level.
# $1 = extract root directory.
find_bin() {
    _fb_root=$1
    if [ -f "$_fb_root/$BIN" ]; then
        printf '%s\n' "$_fb_root/$BIN"
        return 0
    fi
    # Limit depth to avoid scanning huge trees / odd archive layouts.
    _fb_hit=$(find "$_fb_root" -maxdepth 3 -type f -name "$BIN" 2>/dev/null | head -n 1)
    [ -n "$_fb_hit" ] || err "binary '$BIN' not found in archive"
    [ -f "$_fb_hit" ] || err "binary path is not a regular file: $_fb_hit"
    printf '%s\n' "$_fb_hit"
}

# Install file $1 → $2 mode 755 (prefer install(1), else cp+chmod).
install_bin() {
    _ib_src=$1
    _ib_dst=$2
    if have install; then
        install -m 755 "$_ib_src" "$_ib_dst"
    else
        cp "$_ib_src" "$_ib_dst"
        chmod 755 "$_ib_dst"
    fi
}

# Append absolute $1 to shell rc PATH entries when missing.
add_path() {
    _ap_dir=$1
    absolute_path "$_ap_dir" || err "refusing relative PATH entry: $_ap_dir"
    case ":$PATH:" in
        *":$_ap_dir:"*) return 0 ;;
    esac
    _ap_line="export PATH=\"$_ap_dir:\$PATH\""
    _ap_touched=0
    for _ap_rc in .zshrc .bashrc .bash_profile .profile; do
        [ -f "$HOME/$_ap_rc" ] || continue
        _ap_touched=1
        grep -qF -- "$_ap_line" "$HOME/$_ap_rc" 2>/dev/null && continue
        printf '\n%s\n' "$_ap_line" >>"$HOME/$_ap_rc"
        say "  added PATH entry to ~/$_ap_rc"
    done
    if [ -d "$HOME/.config/fish" ]; then
        _ap_touched=1
        _ap_fc="$HOME/.config/fish/conf.d/$BIN-path.fish"
        mkdir -p "$(dirname "$_ap_fc")"
        if [ ! -f "$_ap_fc" ] || ! grep -qF "$_ap_dir" "$_ap_fc"; then
            printf "fish_add_path -g '%s'\n" "$_ap_dir" >"$_ap_fc"
            say "  added PATH entry to ~/.config/fish/conf.d/$BIN-path.fish"
        fi
    fi
    if [ "$_ap_touched" -eq 0 ]; then
        printf '%s\n' "$_ap_line" >>"$HOME/.profile"
        say "  created ~/.profile"
    fi
    say "  restart your shell to apply"
}

# Resolve install directory: env override or $HOME/.local/bin. Must be absolute.
install_dir() {
    # Safely expand ${UP}_INSTALL_DIR without allowing command injection in UP
    # (UP is derived from validated BIN).
    eval "_id_val=\"\${${UP}_INSTALL_DIR:-}\""
    if [ -z "$_id_val" ]; then
        _id_val="$HOME/.local/bin"
    fi
    absolute_path "$_id_val" || err "${UP}_INSTALL_DIR must be an absolute path, got: $_id_val"
    # Reject empty path segments / traversal that absolute_path alone allows.
    case "$_id_val" in
        *'..'* ) err "install dir must not contain ..: $_id_val" ;;
    esac
    printf '%s\n' "$_id_val"
}

install_cli() {
    _ic_target=$(target)
    eval "_ic_ver=\"\${${UP}_VERSION:-}\""
    if [ -z "$_ic_ver" ]; then
        _ic_ver=$(latest)
    else
        _ic_ver=${_ic_ver#v}
        version_ok "$_ic_ver" || err "refusing unsafe ${UP}_VERSION: $_ic_ver"
    fi
    _ic_root=$(install_dir)
    _ic_archive="$BIN-$_ic_ver-$_ic_target.tar.gz"
    _ic_url="https://github.com/$REPO/releases/download/v$_ic_ver/$_ic_archive"

    say "Installing $BIN v$_ic_ver ($_ic_target)"
    if [ "$DRY" = 1 ]; then
        say "[dry-run] download: $_ic_url"
        say "[dry-run] install:  $_ic_root/$BIN"
        return 0
    fi

    _ic_tmp=$(mktemp -d)
    # shellcheck disable=SC2064
    trap 'rm -rf "$_ic_tmp"' EXIT

    say "  downloading $_ic_archive"
    http "$_ic_url" "$_ic_tmp/$_ic_archive" || err "failed to download $_ic_url"

    # Re-read install dir after network I/O (defense in depth).
    _ic_root=$(install_dir)

    say "  extracting"
    tar xzf "$_ic_tmp/$_ic_archive" -C "$_ic_tmp"
    _ic_src=$(find_bin "$_ic_tmp")

    mkdir -p "$_ic_root"
    install_bin "$_ic_src" "$_ic_root/$BIN"
    say "  installed $_ic_root/$BIN"

    add_path "$_ic_root"
    say ""
    say "$BIN v$_ic_ver installed."

    # Drop trap after success so EXIT does not re-run with a stale path.
    trap - EXIT
    rm -rf "$_ic_tmp"
}

uninstall_cli() {
    _uc_root=$(install_dir)
    _uc_path="$_uc_root/$BIN"
    if [ -f "$_uc_path" ]; then
        rm -f "$_uc_path"
        say "removed $_uc_path"
    else
        say "$_uc_path not found"
    fi
    _uc_fc="$HOME/.config/fish/conf.d/$BIN-path.fish"
    if [ -f "$_uc_fc" ]; then
        rm -f "$_uc_fc"
        say "removed $_uc_fc"
    fi
    say "note: PATH entries in shell rc files were left in place"
}

usage() {
    cat <<EOF
Installer for $BIN.

Usage:
  curl -fsSL <url> | sh                            # install
  curl -fsSL <url> | sh -s -- --uninstall          # uninstall
  curl -fsSL <url> | sh -s -- --dry-run            # preview
  curl -fsSL <url> | sh -s -- --help               # show this help

Environment:
  ${UP}_VERSION       Pin a version (default: latest)
  ${UP}_INSTALL_DIR   Install directory (default: \$HOME/.local/bin; must be absolute)
  NO_COLOR            Disable color output
EOF
}

ACT=install
DRY=0
[ "${UNINSTALL:-0}" = 1 ] && ACT=uninstall
[ "${DRY_RUN:-0}" = 1 ] && DRY=1

for _arg in "$@"; do
    case "$_arg" in
        -h | --help) usage; exit 0 ;;
        --uninstall) ACT=uninstall ;;
        --dry-run) DRY=1 ;;
        *) err "unknown argument: $_arg" ;;
    esac
done

case "$ACT" in
    install) install_cli ;;
    uninstall) uninstall_cli ;;
    *) err "unknown action: $ACT" ;;
esac
