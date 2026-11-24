#!/bin/sh
# End-to-end check for a rendered installer script on Unix.
# Usage: sh test/e2e/unix.sh dist/kobe.sh
set -eu

# Absolute path: the XDG test below runs the script from another cwd.
script=$(cd "$(dirname "$1")" && pwd)/$(basename "$1")
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

# Unknown variant names are a usage error (exit 2) and touch nothing.
rc=0
sh "$script" --install-dir "$d" --no-modify-path --variant zzz 2>/dev/null || rc=$?
if [ "$rc" != 2 ]; then
    echo "--variant zzz exited $rc, expected 2" >&2
    exit 1
fi
test ! -e "$receipt"
test ! -e "$d/$bin"

# A relative --install-dir is likewise a usage error (exit 2) and
# touches nothing.
rc=0
sh "$script" --install-dir rel --no-modify-path 2>/dev/null || rc=$?
if [ "$rc" != 2 ]; then
    echo "--install-dir rel exited $rc, expected 2" >&2
    exit 1
fi
test ! -e "$receipt"

# Variant names are case-sensitive: the uppercased declared name is
# still unknown (VARIANT is set by the caller, e.g. VARIANT=onion).
if [ -n "${VARIANT-}" ]; then
    rc=0
    sh "$script" --install-dir "$d" --no-modify-path \
        --variant "$(printf '%s' "$VARIANT" | tr '[:lower:]' '[:upper:]')" 2>/dev/null || rc=$?
    if [ "$rc" != 2 ]; then
        echo "--variant uppercased VARIANT exited $rc, expected 2" >&2
        exit 1
    fi
    test ! -e "$receipt"
    test ! -e "$d/$bin"
fi

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

# Declared build variant (e.g. nosfry onion), driven by VARIANT + a pin —
# the pinned path probes the variant's .sha256 like the default build's.
# VARIANT_VERSION may differ from PIN_VERSION when the pinned default
# exercises an older release than the variant's first-published one.
if [ -n "${VARIANT-}" ] && [ -n "${PIN_VERSION-}" ]; then
    VARIANT_VERSION=${VARIANT_VERSION:-$PIN_VERSION}
    sh "$script" --install-dir "$d" --no-modify-path --quiet \
        --version "$VARIANT_VERSION" --variant "$VARIANT"
    "$d/$bin" --version | grep -q "$VARIANT_VERSION"
    grep -qF "\"variant\":\"$VARIANT\"" "$receipt"

    # Same version + variant again: the idempotency check short-circuits
    # before any download, which the "Skipping" line proves.
    out=$(sh "$script" --install-dir "$d" --no-modify-path \
        --version "$VARIANT_VERSION" --variant "$VARIANT" 2>&1) || {
        printf '%s\n' "$out" >&2
        exit 1
    }
    printf '%s\n' "$out" | grep -q 'Skipping' || {
        printf 'expected skip, got:\n%s\n' "$out" >&2
        exit 1
    }

    # The <PREFIX>_VARIANT env var selects a variant like --variant does.
    prefix=$(printf '%s' "$tool" | tr 'a-z-' 'A-Z_')
    env "${prefix}_VARIANT=$VARIANT" sh "$script" --install-dir "$d" \
        --no-modify-path --quiet --version "$VARIANT_VERSION" --force
    grep -qF "\"variant\":\"$VARIANT\"" "$receipt"

    # Back to the default build at the same pinned version: reinstalls
    # (receipt variant no longer matches) and writes no "variant" key.
    sh "$script" --install-dir "$d" --no-modify-path --quiet --version "$VARIANT_VERSION"
    "$d/$bin" --version | grep -q "$VARIANT_VERSION"
    if grep -qF '"variant"' "$receipt"; then
        echo "receipt kept a variant key" >&2
        exit 1
    fi
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

# A relative XDG_CONFIG_HOME is ignored per the XDG spec (matching upg):
# the receipt lands at the default ~/.config path and no relative dir is
# created under the cwd.
(cd "$d" && XDG_CONFIG_HOME=rel sh "$script" --install-dir "$d" --no-modify-path --quiet --force)
test ! -e "$d/rel"
test -f "$receipt"

# Uninstall removes binary and receipt; --quiet means no stderr at all.
errs=$(sh "$script" --install-dir "$d" --no-modify-path --quiet --uninstall 2>&1 >/dev/null)
test -z "$errs" || {
    printf 'quiet uninstall wrote to stderr:\n%s\n' "$errs" >&2
    exit 1
}
test ! -e "$d/$bin"
test ! -e "$receipt"

# Uninstall without a receipt fails without deleting anything.
if sh "$script" --install-dir "$d" --no-modify-path --uninstall 2>/dev/null; then
    echo "uninstall without receipt succeeded" >&2
    exit 1
fi

echo "e2e ok: $bin $v"
