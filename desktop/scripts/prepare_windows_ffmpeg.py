#!/usr/bin/env python3
"""Prepare the FFmpeg-project-linked Gyan build at a pinned version and SHA256."""
import hashlib
import json
import shutil
import subprocess
import zipfile
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
VERSION = "9.0.2"
URL = "https://www.gyan.dev/ffmpeg/builds/packages/ffmpeg-9.0.2-essentials_build.zip"
SHA256 = "60f467265b1e312373dbcd92200c2618a74850f98d3d078e94296bb3fa2047ba"

def main():
    vendor = ROOT / "desktop/vendor/win32-x64"
    notices = ROOT / "licenses/ffmpeg-windows"
    cache = ROOT / ".build" / ("ffmpeg-" + VERSION + "-windows.zip")
    cache.parent.mkdir(exist_ok=True)
    if not cache.exists():
        partial = cache.with_suffix(".partial")
        subprocess.run(["curl", "--fail", "--location", "--silent", "--show-error", "--retry", "3", "--max-time", "900", URL, "--output", str(partial)], check=True)
        partial.replace(cache)
    if hashlib.sha256(cache.read_bytes()).hexdigest() != SHA256:
        cache.unlink()
        raise SystemExit("FFmpeg archive checksum did not match the pinned publisher SHA256.")
    vendor.mkdir(parents=True, exist_ok=True)
    notices.mkdir(parents=True, exist_ok=True)
    with zipfile.ZipFile(cache) as archive:
        for tool in ["ffmpeg.exe", "ffprobe.exe"]:
            entries = [name for name in archive.namelist() if name.endswith("/bin/" + tool)]
            if len(entries) != 1: raise SystemExit("Missing or ambiguous executable: " + tool)
            with archive.open(entries[0]) as source, (vendor / tool).open("wb") as target: shutil.copyfileobj(source, target)
        for name in archive.namelist():
            if name.lower().endswith(("/license", "/license.txt", "/readme.txt")):
                (notices / Path(name).name).write_bytes(archive.read(name))
    manifest = {"version":VERSION,"architecture":"win32-x64","archive":URL,"sha256":SHA256,"publisher":"Gyan Doshi","publisher_page":"https://www.gyan.dev/ffmpeg/builds/","ffmpeg_project_reference":"https://ffmpeg.org/download.html","upstream_source":"https://ffmpeg.org/releases/ffmpeg-9.0.2.tar.xz"}
    (notices / "provenance.json").write_text(json.dumps(manifest, indent=2) + "\n")
    (notices / "README.md").write_text("# Windows FFmpeg\n\nPinned Gyan FFmpeg 9.0.2 essentials build, Windows x64, GPLv3. Original LICENSE and README are copied verbatim. The publisher SHA256 is checked before extraction. Exact binary and source URLs are in provenance.json. Preserve these notices with the app.\n")
    print("Prepared FFmpeg " + VERSION + " for Windows x64")

if __name__ == "__main__": main()
