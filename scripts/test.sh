#!/bin/zsh
set -euo pipefail
relive_root="${0:A:h:h}"
relive_arch="${1:-arm64}"
case "$relive_arch" in
  arm64) relive_app="$relive_root/dist/Relive.app" ;;
  x86_64) relive_app="$relive_root/dist/Relive-Intel.app" ;;
  *) print -u2 "Usage: scripts/test.sh [arm64|x86_64]"; exit 2 ;;
esac
relive_test_dir="$(mktemp -d /tmp/Relive-test.XXXXXX)"
"$relive_app/Contents/MacOS/Relive" --self-test "$relive_test_dir"
print "Validated outputs: $relive_test_dir"
