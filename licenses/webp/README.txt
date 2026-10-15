Relive includes img2webp and webpinfo from libwebp 1.6.0.
Original Google copyright, BSD license and patent grant are in COPYING and PATENTS.
macOS binaries are built from the checksum-pinned official source with a macOS 13.0
deployment target, static linkage and no optional image or UI libraries. Only
Apple system libraries are needed; PNG/JPEG/TIFF support is not included.
Windows x64 binaries are built from the same pinned official source using CMake
and MSVC, with static libraries and CRT. WEBP_UNICODE=OFF enables argument files;
the application supplies relative ASCII filenames inside a Unicode working directory.
argument-capacity.patch raises only the heap argument array capacity from 16384 to
1048576 on all platforms. It does not change encoding, frame ordering or timing.
Exact source URL, SHA256, build flags and the patch hash are in provenance.json.
Per-target manifests contain the installed tool hashes and validation results.
Rebuild: python3 scripts/prepare_webp.py --target arm64|x86_64|windows-x64
Only the selected target is prepared. A macOS host with Xcode command-line tools
is required to compile macOS targets; Windows builds need CMake and VS 2022 C++ tools.
These build tools, Conda, Homebrew and the VC redistributable are not needed to run Relive.
