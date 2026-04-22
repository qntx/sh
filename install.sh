#!/bin/sh
# Installer for a GitHub-hosted CLI, served via sh.qntx.fun.
#
# Usage:
#   curl -fsSL <url> | sh
#   curl -fsSL <url> | sh -s -- --uninstall
#   curl -fsSL <url> | sh -s -- --dry-run
#   curl -fsSL <url> | sh -s -- --help
#
# Environment (uppercased BIN prefix, dashes to underscores):
#   <BIN>_VERSION       Install a specific version (no 'v' prefix)
#   <BIN>_INSTALL_DIR   Install directory (default: $HOME/.local/bin)
#   NO_COLOR            Disable color output when set

set -eu

REPO="__REPO__"
BIN="__BIN__"

BIN_UPPER=$(echo "$BIN" | tr '[:lower:]' '[:upper:]' | tr '-' '_')
MAX_RETRIES=3

if [ -t 1 ] && [ -z "${NO_COLOR:-}" ]; then
    BOLD=$(printf '\033[1m'); RED=$(printf '\033[31m'); RESET=$(printf '\033[0m')
else
    BOLD=""; RED=""; RESET=""
fi

say()  { printf '%s%s%s\n' "$BOLD" "$*" "$RESET"; }
warn() { printf '%s%s%s\n' "$BOLD" "$*" "$RESET" >&2; }
err()  { printf '%serror%s: %s\n' "$RED" "$RESET" "$*" >&2; exit 1; }
have() { command -v "$1" >/dev/null 2>&1; }

# HTTP GET with up to MAX_RETRIES attempts and exponential backoff.
# Args: url [output_file]. Writes to stdout if output_file omitted.
http_get() {
    _url=$1; _out=${2:-}; _attempt=1; _delay=1
    while : ; do
        _ok=0
        if have curl; then
            if [ -n "$_out" ]; then
                curl -fsSL -A "$BIN-installer" -o "$_out" "$_url" && _ok=1
            else
                curl -fsSL -A "$BIN-installer" "$_url" && _ok=1
            fi
        elif have wget; then
            if [ -n "$_out" ]; then
                wget -q --user-agent="$BIN-installer" -O "$_out" "$_url" && _ok=1
            else
                wget -q --user-agent="$BIN-installer" -O - "$_url" && _ok=1
            fi
        else
            err "curl or wget is required"
        fi
        [ "$_ok" = 1 ] && return 0
        [ "$_attempt" -ge "$MAX_RETRIES" ] && return 1
        sleep "$_delay"
        _attempt=$((_attempt + 1)); _delay=$((_delay * 2))
    done
}

detect_libc() {
    for p in /lib /lib64 /usr/lib; do
        [ -d "$p" ] || continue
        ls "$p"/ld-musl-* >/dev/null 2>&1 && { echo musl; return; }
    done
    have ldd && ldd --version 2>&1 | grep -qi musl && { echo musl; return; }
    echo gnu
}

detect_target() {
    _os=$(uname -s); _arch=$(uname -m)
    case "$_os" in
        Linux)  _os="unknown-linux-$(detect_libc)" ;;
        Darwin)
            _os="apple-darwin"
            [ "$_arch" = x86_64 ] && sysctl -n hw.optional.arm64 2>/dev/null | grep -q 1 && _arch=aarch64
            ;;
        *) err "unsupported OS: $_os" ;;
    esac
    case "$_arch" in
        x86_64|amd64)  _arch=x86_64 ;;
        aarch64|arm64) _arch=aarch64 ;;
        *) err "unsupported architecture: $_arch" ;;
    esac
    echo "$_arch-$_os"
}

latest_version() {
    _tag=$(http_get "https://api.github.com/repos/$REPO/releases/latest" \
        | sed -n 's/.*"tag_name"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' | head -1)
    [ -n "$_tag" ] || err "failed to detect latest version (network error or rate limited)"
    echo "${_tag#v}"
}

sha256_of() {
    if have sha256sum; then sha256sum "$1" | awk '{print $1}'
    elif have shasum; then shasum -a 256 "$1" | awk '{print $1}'
    else err "sha256sum or shasum is required for checksum verification"
    fi
}

find_binary() {
    [ -f "$1/$BIN" ] && { echo "$1/$BIN"; return; }
    _found=$(find "$1" -type f -name "$BIN" 2>/dev/null | head -1)
    [ -n "$_found" ] || err "binary '$BIN' not found in archive"
    echo "$_found"
}

in_path() { case ":$PATH:" in *":$1:"*) return 0 ;; esac; return 1; }

update_shells_path() {
    _dir=$1
    _line="export PATH=\"$_dir:\$PATH\""
    _any=0
    for _rc in "$HOME/.zshrc" "$HOME/.bashrc" "$HOME/.bash_profile" "$HOME/.profile"; do
        [ -f "$_rc" ] || continue
        _any=1
        grep -qF -- "$_line" "$_rc" 2>/dev/null && continue
        printf '\n%s\n' "$_line" >> "$_rc"
        say "  added PATH entry to ~/${_rc#$HOME/}"
    done
    if [ -d "$HOME/.config/fish" ]; then
        _any=1
        _fish="$HOME/.config/fish/conf.d/$BIN-path.fish"
        mkdir -p "$(dirname "$_fish")"
        if [ ! -f "$_fish" ] || ! grep -qF "$_dir" "$_fish"; then
            echo "fish_add_path -g '$_dir'" > "$_fish"
            say "  added PATH entry to ~/.config/fish/conf.d/$BIN-path.fish"
        fi
    fi
    if [ "$_any" -eq 0 ]; then
        printf '%s\n' "$_line" >> "$HOME/.profile"
        say "  created ~/.profile"
    fi
}

resolve_dir() {
    eval "_d=\${${BIN_UPPER}_INSTALL_DIR:-\$HOME/.local/bin}"
    echo "$_d"
}

do_install() {
    _target=$(detect_target)
    eval "_ver=\${${BIN_UPPER}_VERSION:-}"
    [ -n "$_ver" ] || _ver=$(latest_version)
    _dir=$(resolve_dir)

    _archive="$BIN-$_ver-$_target.tar.gz"
    _url="https://github.com/$REPO/releases/download/v$_ver/$_archive"

    say "Installing $BIN v$_ver ($_target)"
    if [ "$DRY_RUN" -eq 1 ]; then
        say "[dry-run] would download: $_url"
        say "[dry-run] would install:  $_dir/$BIN"
        return 0
    fi

    _tmp=$(mktemp -d); trap 'rm -rf "$_tmp"' EXIT

    http_get "$_url" "$_tmp/$_archive" || err "failed to download $_url"

    if http_get "$_url.sha256" "$_tmp/$_archive.sha256" 2>/dev/null; then
        _expected=$(awk '{print $1}' "$_tmp/$_archive.sha256")
        _actual=$(sha256_of "$_tmp/$_archive")
        [ "$_actual" = "$_expected" ] || err "checksum mismatch: expected $_expected, got $_actual"
        say "  checksum verified"
    else
        warn "  no published checksum, skipping verification"
    fi

    tar xzf "$_tmp/$_archive" -C "$_tmp"
    _bin_path=$(find_binary "$_tmp")

    mkdir -p "$_dir"
    install -m 755 "$_bin_path" "$_dir/$BIN"
    say "  installed $_dir/$BIN"

    if ! in_path "$_dir"; then
        update_shells_path "$_dir"
        say "  restart your shell to pick up the new PATH"
    fi

    say ""
    say "$BIN v$_ver installed."
}

do_uninstall() {
    _dir=$(resolve_dir); _target="$_dir/$BIN"
    if [ -f "$_target" ]; then
        rm -f "$_target"
        say "removed $_target"
    else
        say "$_target not found; nothing to remove"
    fi
    _fish="$HOME/.config/fish/conf.d/$BIN-path.fish"
    [ -f "$_fish" ] && rm -f "$_fish" && say "removed $_fish"
    say "note: PATH entries in shell rc files were not touched"
}

usage() {
    cat <<EOF
Installer for $BIN.

Usage:
  curl -fsSL <url> | sh
  curl -fsSL <url> | sh -s -- --uninstall
  curl -fsSL <url> | sh -s -- --dry-run
  curl -fsSL <url> | sh -s -- --help

Environment:
  ${BIN_UPPER}_VERSION        Install a specific version (no 'v' prefix)
  ${BIN_UPPER}_INSTALL_DIR    Install directory (default: \$HOME/.local/bin)
  NO_COLOR                  Disable color output
EOF
}

ACTION=install
DRY_RUN=0
[ "${UNINSTALL:-0}" = 1 ] && ACTION=uninstall
[ "${DRY_RUN:-0}" = 1 ]   && DRY_RUN=1

for _arg in "$@"; do
    case "$_arg" in
        -h|--help)   usage; exit 0 ;;
        --uninstall) ACTION=uninstall ;;
        --dry-run)   DRY_RUN=1 ;;
        *) err "unknown argument: $_arg" ;;
    esac
done

case "$ACTION" in
    install)   do_install ;;
    uninstall) do_uninstall ;;
esac
