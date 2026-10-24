#!/bin/sh
# End-to-end check for a rendered installer script on Unix.
# Usage: sh test/e2e/unix.sh dist/kobe.sh
set -eu

script=$1
# Tool/binary names come from the rendered script name (kobe.sh -> kobe);
# the running-binary FIFO case is kobe-specific (`kobe evm -m -` blocks on
# stdin) and is skipped for other tools.
bin=$(basename "$script" .sh)
tool=$bin
receipt="$HOME/.config/qntx/receipts/$tool.json"

sha256_of() {
    if command -v sha256sum >/dev/null 2>&1; then
        sha256sum "$1" | cut -d' ' -f1
    else
        shasum -a 256 "$1" | cut -d' ' -f1
    fi
}

d=$(mktemp -d)
trap 'rm -rf "$d"' EXIT

v=$(sh "$script" --check)
echo "locked version: $v"
zeros=$(printf '0%.0s' $(seq 64))

# Fresh install
sh "$script" --install-dir "$d" --no-modify-path --quiet
test -x "$d/$bin"
"$d/$bin" --version | grep -q "$v"
grep -qF "\"version\":\"$v\"" "$receipt"

# Idempotent rerun (no re-download), then --force reinstall
sh "$script" --install-dir "$d" --no-modify-path --quiet
sh "$script" --install-dir "$d" --no-modify-path --quiet --force

# Pin an older release (kobe ships 5.0.0; tools without a usable pin
# skip via PIN_VERSION=).
if [ -n "${PIN_VERSION-5.0.0}" ]; then
    sh "$script" --install-dir "$d" --no-modify-path --quiet --version "${PIN_VERSION:-5.0.0}"
    "$d/$bin" --version | grep -q "${PIN_VERSION:-5.0.0}"
fi

# Running-binary replacement: `kobe evm -m -` blocks reading a mnemonic
# line from stdin while the FIFO stays held open. kobe-only.
if [ "$bin" = "kobe" ]; then
    mkfifo "$d/fifo"
    (
        exec 3<>"$d/fifo"
        "$d/$bin" evm -m - <&3 >/dev/null 2>&1
    ) &
    pid=$!
    sleep 1
    sh "$script" --install-dir "$d" --no-modify-path --quiet --force
    test -x "$d/$bin"
    kill "$pid" 2>/dev/null || true
fi

# Tamper: corrupt every embedded hash; install dir + receipt unchanged.
bin_sha=$(sha256_of "$d/$bin")
rcpt_sha=$(sha256_of "$receipt")
sed -E "s/'[0-9a-f]{64}'/'$zeros'/g" "$script" >"$d/bad.sh"
if sh "$d/bad.sh" --install-dir "$d" --no-modify-path --quiet --force; then
    echo "tampered script installed" >&2
    exit 1
fi
[ "$(sha256_of "$d/$bin")" = "$bin_sha" ]
[ "$(sha256_of "$receipt")" = "$rcpt_sha" ]

# Uninstall removes binary and receipt
sh "$script" --install-dir "$d" --no-modify-path --quiet --uninstall
test ! -e "$d/$bin"
test ! -e "$receipt"

# Uninstall without a receipt fails without deleting anything.
if sh "$script" --install-dir "$d" --no-modify-path --uninstall 2>/dev/null; then
    echo "uninstall without receipt succeeded" >&2
    exit 1
fi

echo "e2e ok: $bin $v"
