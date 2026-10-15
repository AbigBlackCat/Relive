Relive includes img2webp and webpinfo from libwebp 1.6.0.
Original Google copyright, BSD license and patent grant are in COPYING and PATENTS.
macOS binaries are built from the checksum-pinned official source with a macOS 13.0
deployment target, static linkage and no optional image or UI libraries. Only
Apple system libraries are needed; PNG/JPEG/TIFF support is not included.
Windows x64 binaries are copied unchanged from Google's checksum-pinned archive.
Exact download URLs, archive SHA256 values and build flags are in provenance.json.
Per-target manifests contain the installed tool hashes and validation results.
Rebuild: python3 scripts/prepare_webp.py --target arm64|x86_64|windows-x64
Only the selected target is prepared. A macOS host with Xcode command-line tools
is required to compile macOS targets. No Conda or Homebrew runtime is needed.
