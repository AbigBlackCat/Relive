@ECHO ON

mkdir build
cd build

cmake %CMAKE_ARGS% ^
      -G Ninja ^
      -DCMAKE_POLICY_VERSION_MINIMUM=3.10 ^
      -DCMAKE_INSTALL_PREFIX=%LIBRARY_PREFIX% ^
      -DBUILD_SHARED_LIBS=ON ^
      ..
if errorlevel 1 exit 1

ninja -v
if errorlevel 1 exit 1

ninja install
if errorlevel 1 exit 1
