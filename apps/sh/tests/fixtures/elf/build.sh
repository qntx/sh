#!/bin/sh
# Rebuild the ELF fixtures read by tests/elf.test.ts. Each binary is
# compiled in a pinned container image (by index digest) so the version
# needs are reproducible: almalinux 8's gcc links a weak statx reference
# against glibc 2.28, fedora 43's pidfd_getpid requires glibc 2.39, and
# alpine's gcc -static produces a musl binary with no version needs.
# Usage: sh apps/sh/tests/fixtures/elf/build.sh  (needs docker)
set -eu
cd "$(dirname "$0")"

ALMALINUX8='almalinux:8@sha256:768bedc30fe0a536adb0a65d2eddb7caad364e514fbddd0ae9e026975f590342'
FEDORA43='fedora:43@sha256:f01112b9a1f1d0504ad962d9adfa401425033f8ab067e0a821904ebdde5b8ca5'
ALPINE322='alpine:3.22@sha256:49340b346798875b5592e5d420241f2f9cfba5f47e62ebb1446a1b34734e898f'

d=$(mktemp -d)
trap 'rm -rf "$d"' EXIT

# Compile the stdin C source inside image $1 for platform $2 after
# running install command $3, link with extra flags $4, copy out as $5.
build() {
    cat >"$d/main.c"
    docker run --rm --platform "$2" -v "$d:/src" "$1" sh -c \
        "$3 && gcc -Os -s $4 -o /src/out.elf /src/main.c"
    cp "$d/out.elf" "$5"
    rm -f "$d/out.elf" "$d/main.c"
    echo "built $5"
}

# statx is a weak symbol reference the way Rust std emits one: glibc
# 2.28+ resolves it, older glibc leaves it NULL. The version *need* it
# pulls in is recorded with Flags none (binutils does not set
# VER_FLG_WEAK on the Vernaux) -> Vernaux GLIBC_2.28, flags none.
build "$ALMALINUX8" linux/amd64 'dnf -y -q install gcc' '' glibc-2.28-x86_64.elf <<'EOF'
#define _GNU_SOURCE
#include <fcntl.h>
#include <stdio.h>
#include <sys/stat.h>
#include <unistd.h>
#pragma weak statx
int
main(void)
{
    struct statx stx;
    if (statx != 0 && statx(AT_FDCWD, "/", 0, STATX_BASIC_STATS, &stx) == 0) {
        printf("statx mask %u\n", stx.stx_mask);
    } else {
        puts("no statx");
    }
    return 0;
}
EOF

# pidfd_open is glibc 2.36, pidfd_getpid glibc 2.39 -> floor 2.39.
build "$FEDORA43" linux/arm64 'dnf -y -q install gcc' '' glibc-2.39-aarch64.elf <<'EOF'
#include <stdio.h>
#include <sys/pidfd.h>
#include <unistd.h>
int
main(void)
{
    int fd = pidfd_open(getpid(), 0);
    printf("pidfd %d self %d\n", fd, pidfd_getpid(fd));
    return 0;
}
EOF

# musl + -static: no PT_DYNAMIC, no version needs at all.
build "$ALPINE322" linux/amd64 'apk -q add gcc musl-dev' '-static' musl-static-x86_64.elf <<'EOF'
#include <stdio.h>
int
main(void)
{
    puts("hi");
    return 0;
}
EOF
