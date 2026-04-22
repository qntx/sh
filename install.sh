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

set -eu

REPO="__REPO__"
BIN="__BIN__"
UP=$(echo "$BIN" | tr '[:lower:]' '[:upper:]' | tr '-' '_')

if [ -t 1 ] && [ -z "${NO_COLOR:-}" ]; then
    B=$(printf '\033[1m'); R=$(printf '\033[31m'); N=$(printf '\033[0m')
else
    B=''; R=''; N=''
fi

say()  { printf '%s%s%s\n' "$B" "$*" "$N"; }
warn() { printf '%s%s%s\n' "$B" "$*" "$N" >&2; }
err()  { printf '%serror%s: %s\n' "$R" "$N" "$*" >&2; exit 1; }
have() { command -v "$1" >/dev/null 2>&1; }

# HTTP GET with retries and exponential backoff.
# $1=url, $2=outfile (empty for stdout), $3=max attempts (default 3).
http() {
    url=$1 out=${2:-} max=${3:-3} i=1 d=1
    while :; do
        if have curl; then
            if [ -n "$out" ]; then
                curl -fsSL -A "$BIN-installer" -o "$out" "$url" && return 0
            else
                curl -fsSL -A "$BIN-installer" "$url" && return 0
            fi
        elif have wget; then
            if [ -n "$out" ]; then
                wget -q --user-agent="$BIN-installer" -O "$out" "$url" && return 0
            else
                wget -q --user-agent="$BIN-installer" -O- "$url" && return 0
            fi
        else
            err "curl or wget is required"
        fi
        [ "$i" -ge "$max" ] && return 1
        sleep "$d"; i=$((i + 1)); d=$((d * 2))
    done
}

target() {
    os=$(uname -s); arch=$(uname -m)
    case "$os" in
        Linux)
            os=unknown-linux-gnu
            for p in /lib /lib64 /usr/lib; do
                ls "$p"/ld-musl-* >/dev/null 2>&1 && { os=unknown-linux-musl; break; }
            done
            ;;
        Darwin)
            os=apple-darwin
            [ "$arch" = x86_64 ] && sysctl -n hw.optional.arm64 2>/dev/null | grep -q 1 && arch=aarch64
            ;;
        *) err "unsupported OS: $os" ;;
    esac
    case "$arch" in
        x86_64|amd64)  arch=x86_64 ;;
        aarch64|arm64) arch=aarch64 ;;
        *) err "unsupported architecture: $arch" ;;
    esac
    echo "$arch-$os"
}

latest() {
    t=$(http "https://api.github.com/repos/$REPO/releases/latest" \
        | sed -n 's/.*"tag_name"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' | head -1)
    [ -n "$t" ] || err "failed to detect latest version (network error or rate limited)"
    echo "${t#v}"
}

sha256() {
    if have sha256sum; then sha256sum "$1" | awk '{print $1}'
    elif have shasum; then shasum -a 256 "$1" | awk '{print $1}'
    else err "sha256sum or shasum is required"
    fi
}

# Locate $BIN inside an extracted archive, tolerating an optional top-level folder.
find_bin() {
    [ -f "$1/$BIN" ] && { echo "$1/$BIN"; return; }
    f=$(find "$1" -type f -name "$BIN" 2>/dev/null | head -1)
    [ -n "$f" ] || err "binary '$BIN' not found in archive"
    echo "$f"
}

# Append the PATH entry to every existing shell rc, plus fish conf.d.
add_path() {
    dir=$1
    case ":$PATH:" in *":$dir:"*) return ;; esac
    line="export PATH=\"$dir:\$PATH\""
    touched=0
    for rc in .zshrc .bashrc .bash_profile .profile; do
        [ -f "$HOME/$rc" ] || continue
        touched=1
        grep -qF -- "$line" "$HOME/$rc" 2>/dev/null && continue
        printf '\n%s\n' "$line" >> "$HOME/$rc"
        say "  added PATH entry to ~/$rc"
    done
    if [ -d "$HOME/.config/fish" ]; then
        touched=1
        fc="$HOME/.config/fish/conf.d/$BIN-path.fish"
        mkdir -p "$(dirname "$fc")"
        if [ ! -f "$fc" ] || ! grep -qF "$dir" "$fc"; then
            printf "fish_add_path -g '%s'\n" "$dir" > "$fc"
            say "  added PATH entry to ~/.config/fish/conf.d/$BIN-path.fish"
        fi
    fi
    if [ "$touched" -eq 0 ]; then
        printf '%s\n' "$line" >> "$HOME/.profile"
        say "  created ~/.profile"
    fi
    say "  restart your shell to apply"
}

# Safely read `${UP}_INSTALL_DIR` via eval while keeping expansion quoted so that
# values containing `;` or `$()` cannot smuggle in extra commands.
install_dir() { eval "printf %s \"\${${UP}_INSTALL_DIR:-\$HOME/.local/bin}\""; }

install_cli() {
    t=$(target)
    eval "v=\"\${${UP}_VERSION:-}\""
    [ -n "$v" ] || v=$(latest)
    d=$(install_dir)
    archive="$BIN-$v-$t.tar.gz"
    url="https://github.com/$REPO/releases/download/v$v/$archive"

    say "Installing $BIN v$v ($t)"
    if [ "$DRY" = 1 ]; then
        say "[dry-run] download: $url"
        say "[dry-run] install:  $d/$BIN"
        return 0
    fi

    tmp=$(mktemp -d); trap 'rm -rf "$tmp"' EXIT

    say "  downloading $archive"
    http "$url" "$tmp/$archive" || err "failed to download $url"

    if http "$url.sha256" "$tmp/$archive.sha256" 1 2>/dev/null; then
        exp=$(awk '{print $1}' "$tmp/$archive.sha256")
        act=$(sha256 "$tmp/$archive")
        [ "$act" = "$exp" ] || err "checksum mismatch: expected $exp, got $act"
        say "  checksum verified"
    else
        warn "  no published checksum, skipping verification"
    fi

    say "  extracting"
    tar xzf "$tmp/$archive" -C "$tmp"
    src=$(find_bin "$tmp")

    mkdir -p "$d"
    install -m 755 "$src" "$d/$BIN"
    say "  installed $d/$BIN"

    add_path "$d"
    say ""
    say "$BIN v$v installed."
}

uninstall_cli() {
    d=$(install_dir)
    t="$d/$BIN"
    if [ -f "$t" ]; then
        rm -f "$t"
        say "removed $t"
    else
        say "$t not found"
    fi
    fc="$HOME/.config/fish/conf.d/$BIN-path.fish"
    [ -f "$fc" ] && rm -f "$fc" && say "removed $fc"
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
  ${UP}_INSTALL_DIR   Install directory (default: \$HOME/.local/bin)
  NO_COLOR            Disable color output
EOF
}

ACT=install
DRY=0
[ "${UNINSTALL:-0}" = 1 ] && ACT=uninstall
[ "${DRY_RUN:-0}"   = 1 ] && DRY=1

for a in "$@"; do
    case "$a" in
        -h|--help)   usage; exit 0 ;;
        --uninstall) ACT=uninstall ;;
        --dry-run)   DRY=1 ;;
        *) err "unknown argument: $a" ;;
    esac
done

case "$ACT" in
    install)   install_cli ;;
    uninstall) uninstall_cli ;;
esac
