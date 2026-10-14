#!/bin/bash
set -e
set -x

mkdir build
cd build

cmake ${CMAKE_ARGS} .. \
 -DCMAKE_BUILD_TYPE=Release \
 -DBUILD_SHARED_LIBS=ON

make -j $CPU_COUNT

make install
