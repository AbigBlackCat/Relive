#!/bin/zsh
set -euo pipefail
relive_root="${0:A:h:h}"
relive_test_dir="$(mktemp -d /tmp/Relive-test.XXXXXX)"
"$relive_root/dist/Relive.app/Contents/MacOS/Relive" --self-test "$relive_test_dir"
print "Validated outputs: $relive_test_dir"
