#!/bin/sh
# sh.qntx.org tool directory. S1: list every tool and exit 1.

set -eu

main() {
    cat >&2 <<'EOF'
Usage: curl -fsSL https://sh.qntx.org/<tool> | sh

Tools:
EOF
# @qntx-constants
    cat >&2 <<'EOF'

Windows PowerShell:
  irm https://sh.qntx.org/<tool>/ps | iex
EOF
    exit 1
}

main "$@"
