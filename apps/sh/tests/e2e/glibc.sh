#!/bin/sh
# Container e2e for the installer's glibc floor: an old-glibc image
# (RHEL 8, glibc 2.28) must skip a gnu build whose measured floor is
# newer - a precise exit 3 with the from-source hint when nothing
# remains - while a musl build still installs there, and a new-glibc
# image (fedora 43) installs the gnu build. Native platform.
# Usage: sh apps/sh/tests/e2e/glibc.sh apps/sh/dist   (needs docker)
set -u

dist=$(cd "$1" && pwd)

OLD='redhat/ubi8@sha256:432e88be04b5561187a01fe33429cd2ce7a8408a00f000d8136df368dcab306f'
NEW='fedora:43@sha256:f01112b9a1f1d0504ad962d9adfa401425033f8ab067e0a821904ebdde5b8ca5'

d=$(mktemp -d)
trap 'rm -rf "$d"' EXIT

# getconf fails -> ldd fallback (still glibc 2.28 on OLD); both fail ->
# "could not determine".
mkdir -p "$d/nogetconf" "$d/nolibc"
printf '#!/bin/sh\nexit 1\n' >"$d/nogetconf/getconf"
printf '#!/bin/sh\nexit 1\n' >"$d/nolibc/getconf"
printf '#!/bin/sh\nexit 1\n' >"$d/nolibc/ldd"
chmod 755 "$d/nogetconf/getconf" "$d/nolibc/getconf" "$d/nolibc/ldd"

arch=$(docker run --rm "$OLD" uname -m)
nv=$(sh "$dist/nosfry.sh" --check)
kv=$(sh "$dist/kobe.sh" --check)
nfloor=$(sed -n "s/^        $arch-unknown-linux-gnu) printf '%s' '\([0-9.]*\)'.*/\1/p" \
    "$dist/nosfry.sh" | head -n 1)
SYSPATH='/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin'

fails=0
cid=0
begin() {
    cid=$((cid + 1))
    printf -- '--- case %s: %s\n' "$cid" "$1"
}
check_rc() {
    [ "$rc" = "$1" ] || {
        echo "FAIL: rc=$rc, want $1"
        fails=1
    }
}
has() {
    case "$out" in
        *"$1"*) ;;
        *)
            echo "FAIL missing: $1"
            fails=1
            ;;
    esac
}
lacks() {
    case "$out" in
        *"$1"*)
            echo "FAIL unexpected: $1"
            fails=1
            ;;
    esac
}

# A: OLD, locked nosfry install - below the gnu floor, no musl build.
begin "OLD nosfry install exits 3 below the floor"
out=$(docker run --rm --network none -v "$dist:/dist:ro" "$OLD" \
    sh /dist/nosfry.sh --install-dir /tmp/bin --no-modify-path 2>&1)
rc=$?
printf '%s\n' "$out"
check_rc 3
has "error: nosfry $nv ($arch-unknown-linux-gnu) needs glibc >= $nfloor; this host has glibc 2.28"
has 'install from source: cargo install nosfry --locked'
lacks 'Downloading'

# B: the same selection under --dry-run.
begin "OLD nosfry --dry-run exits 3 below the floor"
out=$(docker run --rm --network none -v "$dist:/dist:ro" "$OLD" \
    sh /dist/nosfry.sh --dry-run --install-dir /tmp/bin --no-modify-path 2>&1)
rc=$?
printf '%s\n' "$out"
check_rc 3
has "error: nosfry $nv ($arch-unknown-linux-gnu) needs glibc >= $nfloor; this host has glibc 2.28"
has 'install from source: cargo install nosfry --locked'
lacks 'Downloading'

# C: variant builds carry the same floor.
begin "OLD nosfry --variant onion exits 3 below the floor"
out=$(docker run --rm --network none -v "$dist:/dist:ro" "$OLD" \
    sh /dist/nosfry.sh --variant onion --install-dir /tmp/bin --no-modify-path 2>&1)
rc=$?
printf '%s\n' "$out"
check_rc 3
has "error: nosfry $nv onion ($arch-unknown-linux-gnu) needs glibc >= $nfloor"
has 'this host has glibc 2.28'
lacks 'Downloading'

# D: getconf missing/failing falls back to ldd (still glibc 2.28).
begin "OLD nosfry --dry-run with failing getconf exits 3 via ldd"
out=$(docker run --rm --network none -v "$dist:/dist:ro" -v "$d/nogetconf:/stub:ro" \
    -e "PATH=/stub:$SYSPATH" "$OLD" \
    sh /dist/nosfry.sh --dry-run --install-dir /tmp/bin --no-modify-path 2>&1)
rc=$?
printf '%s\n' "$out"
check_rc 3
has 'this host has glibc 2.28'
lacks 'Downloading'

# E: OLD kobe --dry-run falls back to the musl build.
begin "OLD kobe --dry-run picks musl"
out=$(docker run --rm --network none -v "$dist:/dist:ro" "$OLD" \
    sh /dist/kobe.sh --dry-run --install-dir /tmp/bin --no-modify-path 2>&1)
rc=$?
printf '%s\n' "$out"
check_rc 0
has "kobe-$kv-$arch-unknown-linux-musl.tar.gz"

# F: OLD kobe real install lands the musl binary.
begin "OLD kobe install uses musl"
out=$(docker run --rm -v "$dist:/dist:ro" "$OLD" sh -c '
    sh /dist/kobe.sh --install-dir /tmp/bin --no-modify-path &&
    /tmp/bin/kobe --version &&
    cat /root/.config/qntx/receipts/kobe.json' 2>&1)
rc=$?
printf '%s\n' "$out"
check_rc 0
has "($arch-unknown-linux-musl)"
has "$kv"
has '"install_dir":"/tmp/bin"'

# G: OLD nosfry pinned install - no floor data on the pinned path; the
# self-check is the backstop and prints the binary's loader error.
begin "OLD nosfry pinned install fails the self-check"
out=$(docker run --rm -v "$dist:/dist:ro" -e "NV=$nv" "$OLD" sh -c '
    sh /dist/nosfry.sh --version "$NV" --install-dir /tmp/bin --no-modify-path
    r=$?
    echo "installer rc=$r"
    [ -e /tmp/bin/nosfry ] && echo "BINARY LEFT"
    [ -e /root/.config/qntx/receipts/nosfry.json ] && echo "RECEIPT LEFT"
    exit $r' 2>&1)
rc=$?
printf '%s\n' "$out"
check_rc 1
has 'self-check failed'
has 'GLIBC_'
has 'not found'
lacks 'BINARY LEFT'
lacks 'RECEIPT LEFT'

# H: NEW installs the gnu build - the floor is below the host glibc.
begin "NEW nosfry install uses gnu"
out=$(docker run --rm -v "$dist:/dist:ro" "$NEW" sh -c '
    sh /dist/nosfry.sh --install-dir /tmp/bin --no-modify-path &&
    /tmp/bin/nosfry --version' 2>&1)
rc=$?
printf '%s\n' "$out"
check_rc 0
has "($arch-unknown-linux-gnu)"
has "$nv"
lacks 'warning:'

# I: NEW with getconf and ldd both failing - one warning, gnu anyway.
begin "NEW nosfry --dry-run warns once when glibc is undetectable"
out=$(docker run --rm -v "$dist:/dist:ro" -v "$d/nolibc:/stub:ro" \
    -e "PATH=/stub:$SYSPATH" "$NEW" \
    sh /dist/nosfry.sh --dry-run --install-dir /tmp/bin --no-modify-path 2>&1)
rc=$?
printf '%s\n' "$out"
check_rc 0
has "nosfry-$nv-$arch-unknown-linux-gnu.tar.gz"
wlines=$(printf '%s\n' "$out" | grep -c 'warning: could not determine the glibc version')
[ "$wlines" = 1 ] || {
    echo "FAIL: $wlines undetectable-glibc warnings, want 1"
    fails=1
}

[ "$fails" = 0 ] || exit 1
echo 'glibc e2e ok'
