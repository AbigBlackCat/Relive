#!/bin/zsh
set -euo pipefail
relive_root="${0:A:h:h}"
cd "$relive_root"
relive_arch="${1:-arm64}"
case "$relive_arch" in
  arm64) relive_app="$relive_root/dist/Relive.app"; relive_resources="$relive_root/Resources"; relive_ffmpeg_licenses="$relive_root/licenses/ffmpeg" ;;
  x86_64) relive_app="$relive_root/dist/Relive-Intel.app"; relive_resources="$relive_root/Resources/macos-x86_64"; relive_ffmpeg_licenses="$relive_root/licenses/ffmpeg-x86_64" ;;
  *) print -u2 "Usage: scripts/build.sh [arm64|x86_64]"; exit 2 ;;
esac
for relive_tool in ffmpeg ffprobe; do
  if [[ ! -x "$relive_resources/bin/$relive_tool" ]]; then
    print -u2 "Missing $relive_arch $relive_tool. Run scripts/prepare_intel_ffmpeg.py for Intel builds."
    exit 1
  fi
  if ! lipo -archs "$relive_resources/bin/$relive_tool" | tr ' ' '\n' | /usr/bin/grep -qx "$relive_arch"; then
    print -u2 "Wrong architecture for $relive_tool: expected $relive_arch"
    exit 1
  fi
done
[[ -f "$relive_ffmpeg_licenses/manifest.json" ]] || { print -u2 "Missing FFmpeg license manifest: $relive_ffmpeg_licenses"; exit 1; }
rm -rf "$relive_app"
mkdir -p "$relive_app/Contents/MacOS" "$relive_app/Contents/Resources"
xcrun swiftc -swift-version 5 -O -target "$relive_arch-apple-macosx13.0" Sources/*.swift -o "$relive_app/Contents/MacOS/Relive" -framework SwiftUI -framework AppKit -framework AVKit -framework AVFoundation -framework Photos -framework WebKit -framework ImageIO -framework UniformTypeIdentifiers
cp Resources/Info.plist "$relive_app/Contents/Info.plist"
ditto "$relive_resources/bin" "$relive_app/Contents/Resources/bin"
ditto "$relive_resources/lib" "$relive_app/Contents/Resources/lib"
mkdir -p "$relive_app/Contents/Resources/licenses"
for relive_license in licenses/*; do
  [[ "${relive_license:t}" == ffmpeg* ]] && continue
  ditto "$relive_license" "$relive_app/Contents/Resources/licenses/${relive_license:t}"
done
ditto "$relive_ffmpeg_licenses" "$relive_app/Contents/Resources/licenses/ffmpeg"
cp Resources/使用说明.html "$relive_app/Contents/Resources/使用说明.html"
cp Resources/ASSET-SOURCES.txt "$relive_app/Contents/Resources/ASSET-SOURCES.txt"
cp README.md "$relive_app/Contents/Resources/README.md"
if [[ -f Resources/Relive.icns ]]; then cp Resources/Relive.icns "$relive_app/Contents/Resources/Relive.icns"; fi
codesign --force --sign - "$relive_app"
codesign --verify --deep --strict "$relive_app"
print "$relive_app"
