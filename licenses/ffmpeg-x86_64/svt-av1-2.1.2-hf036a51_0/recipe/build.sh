#!/bin/bash

set -ex

cd Build

cmake ${CMAKE_ARGS}              \
      -DCMAKE_BUILD_TYPE=Release \
      -DBUILD_SHARED_LIBS=ON     \
      -DNATIVE=OFF               \
      ..

make -j${CPU_COUNT} VERBOSE=1

make install
