set -ex

# libdir is set to lib, otherwise on aarch64 and some others 
# will default to lib64

meson setup builddir          \
    ${MESON_ARGS}             \
    -Denable_tests=false      \
    --prefix=$PREFIX          \
    --buildtype=release       \
    -Dlibdir=lib

meson compile -C builddir

meson install -C builddir --no-rebuild
