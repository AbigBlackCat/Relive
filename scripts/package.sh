#!/bin/zsh
set -euo pipefail
relive_root="${0:A:h:h}"
relive_version="$(/usr/libexec/PlistBuddy -c 'Print CFBundleShortVersionString' "$relive_root/Resources/Info.plist")"
relive_arch="${1:-arm64}"
case "$relive_arch" in
  arm64) relive_app="$relive_root/dist/Relive.app"; relive_label=AppleSilicon; relive_destination="${2:-$relive_root/dist/Relive-$relive_version-AppleSilicon.dmg}" ;;
  x86_64) relive_app="$relive_root/dist/Relive-Intel.app"; relive_label=Intel; relive_destination="${2:-$relive_root/dist/Relive-$relive_version-Intel.dmg}" ;;
  *.dmg) relive_app="$relive_root/dist/Relive.app"; relive_label=AppleSilicon; relive_destination="$relive_arch" ;;
  *) print -u2 "Usage: scripts/package.sh [arm64|x86_64] [output.dmg]"; exit 2 ;;
esac
[[ -d "$relive_app" ]] || { print -u2 "Build the $relive_label app before packaging: $relive_app"; exit 1; }
relive_package_dir="$(mktemp -d /tmp/Relive-package.XXXXXX)"
trap '/bin/rm -rf "$relive_package_dir"' EXIT
ditto "$relive_app" "$relive_package_dir/Relive.app"
ln -s /Applications "$relive_package_dir/Applications"
cp "$relive_root/Resources/使用说明.html" "$relive_package_dir/使用说明.html"
hdiutil create -volname "Relive $relive_label" -srcfolder "$relive_package_dir" -format UDZO -ov "$relive_destination"
print "$relive_destination"
