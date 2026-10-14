#!/bin/bash
set -ex

autoreconf -ivf
./configure --prefix="${PREFIX}" \
  --enable-shared \
  --disable-static \
  --with-pic
make -j "${CPU_COUNT}"
if [[ "${CONDA_BUILD_CROSS_COMPILATION:-}" != "1" || "${CROSSCOMPILING_EMULATOR}" != "" ]]; then
make check
fi
make test
make install
