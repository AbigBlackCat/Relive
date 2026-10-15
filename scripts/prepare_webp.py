#!/usr/bin/env python3
"""Prepare checksum-pinned libwebp tools for Relive, without changing FFmpeg."""

import argparse
import hashlib
import json
import os
import platform
import re
import shutil
import subprocess
import sys
import tarfile
import tempfile
import zipfile
from pathlib import Path


PROJECT = Path(__file__).resolve().parent.parent
VERSION = "1.6.0"
BASE_URL = "https://storage.googleapis.com/downloads.webmproject.org/releases/webp/"
SOURCE_NAME = f"libwebp-{VERSION}.tar.gz"
SOURCE_SHA256 = "e4ab7009bf0629fd11982d4c2aa83964cf244cffba7347ecd39019a9e38c4564"
WINDOWS_NAME = f"libwebp-{VERSION}-windows-x64.zip"
WINDOWS_SHA256 = "48886f506b21f62e4661f0f4cbfca19800897c385128e8902542d29a950c93f1"
TOOLS = ("img2webp", "webpinfo")
CACHE = PROJECT / ".build/webp"
LICENSES = PROJECT / "licenses/webp"
CONFIGURE_FLAGS = ["--disable-shared", "--enable-static", "--disable-sdl",
                   "--disable-png", "--disable-jpeg", "--disable-tiff",
                   "--disable-gl", "--disable-threading"]


def digest(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def run(arguments, **kwargs):
    result = subprocess.run([str(arg) for arg in arguments], check=True,
                            capture_output=True, text=True, **kwargs)
    return result.stdout


def download(name, expected):
    destination = CACHE / name
    if destination.is_file() and digest(destination) == expected:
        return destination
    temporary = destination.with_suffix(destination.suffix + ".download")
    try:
        subprocess.run(["curl", "--fail", "--location", "--retry", "3",
                        "--silent", "--show-error", BASE_URL + name,
                        "--output", str(temporary)], check=True)
        if digest(temporary) != expected:
            raise RuntimeError(f"SHA256 mismatch for {name}; no tools were installed.")
        temporary.replace(destination)
    finally:
        temporary.unlink(missing_ok=True)
    return destination


def source_and_notices(archive):
    source = CACHE / f"libwebp-{VERSION}"
    LICENSES.mkdir(parents=True, exist_ok=True)
    with tarfile.open(archive) as tar:
        for name in ("COPYING", "PATENTS"):
            member = tar.extractfile(f"libwebp-{VERSION}/{name}")
            if member is None:
                raise RuntimeError(f"Missing original WebP notice: {name}")
            (LICENSES / name).write_bytes(member.read())
        if not (source / "configure").is_file():
            for member in tar.getmembers():
                target = (CACHE / member.name).resolve()
                if CACHE.resolve() not in target.parents or member.issym() or member.islnk():
                    raise RuntimeError("Unexpected path or link in pinned WebP source archive.")
            tar.extractall(CACHE)
    provenance = {
        "name": "libwebp", "version": VERSION, "license": "BSD-3-Clause",
        "homepage": "https://developers.google.com/speed/webp/",
        "repository": "https://chromium.googlesource.com/webm/libwebp",
        "source": {"url": BASE_URL + SOURCE_NAME, "sha256": SOURCE_SHA256},
        "windows_archive": {"url": BASE_URL + WINDOWS_NAME, "sha256": WINDOWS_SHA256},
        "bundled_tools": list(TOOLS),
        "macos": {"minimum_version": "13.0", "linkage": "static",
                  "configure_flags": CONFIGURE_FLAGS},
    }
    (LICENSES / "provenance.json").write_text(json.dumps(provenance, indent=2) + "\n")
    (LICENSES / "README.txt").write_text(
        "Relive includes img2webp and webpinfo from libwebp 1.6.0.\n"
        "Original Google copyright, BSD license and patent grant are in COPYING and PATENTS.\n"
        "macOS binaries are built from the checksum-pinned official source with a macOS 13.0\n"
        "deployment target, static linkage and no optional image or UI libraries. Only\n"
        "Apple system libraries are needed; PNG/JPEG/TIFF support is not included.\n"
        "Windows x64 binaries are copied unchanged from Google's checksum-pinned archive.\n"
        "Exact download URLs, archive SHA256 values and build flags are in provenance.json.\n"
        "Per-target manifests contain the installed tool hashes and validation results.\n"
        "Rebuild: python3 scripts/prepare_webp.py --target arm64|x86_64|windows-x64\n"
        "Only the selected target is prepared. A macOS host with Xcode command-line tools\n"
        "is required to compile macOS targets. No Conda or Homebrew runtime is needed.\n")
    return source


def smoke_test(binary_directory, suffix):
    with tempfile.TemporaryDirectory(prefix="Relive-webp-tools-") as temporary:
        directory = Path(temporary)
        for name, color in (("red", b"\xff\x00\x00"), ("blue", b"\x00\x00\xff")):
            (directory / (name + ".ppm")).write_bytes(b"P6\n2 2\n255\n" + color * 4)
        output = directory / "animated.webp"
        run([binary_directory / ("img2webp" + suffix), "-loop", "0", "-lossy",
             "-q", "80", "-m", "4", "-d", "40", directory / "red.ppm",
             directory / "blue.ppm", "-o", output])
        info = run([binary_directory / ("webpinfo" + suffix), "-diag", "-summary", output])
        if not (re.search(r"Number of frames:\s*2\b", info)
                and re.search(r"Loop count\s*:\s*0\b", info)
                and sum(map(int, re.findall(r"Duration:\s*(\d+)", info))) == 80):
            raise RuntimeError("Bundled WebP tools failed animated PPM encoding validation.")
        run([binary_directory / ("img2webp" + suffix), "-lossy", "-q", "80",
             directory / "red.ppm", "-o", directory / "still.webp"])
        still = run([binary_directory / ("webpinfo" + suffix), "-diag", "-summary",
                     directory / "still.webp"])
        if not re.search(r"Number of frames:\s*1\b", still):
            raise RuntimeError("Bundled WebP tools failed single-frame validation.")
    return {"passed": True, "cases": ["2-frame PPM, 80 ms, infinite loop", "single-frame WebP"]}


def prepare_macos(target, source):
    if sys.platform != "darwin":
        raise RuntimeError("Compile macOS WebP tools on a macOS host.")
    build = CACHE / ("build-" + target)
    build.mkdir(exist_ok=True)
    environment = dict(os.environ, MACOSX_DEPLOYMENT_TARGET="13.0",
                       CC=f"/usr/bin/clang -arch {target}",
                       CFLAGS="-O2 -mmacosx-version-min=13.0",
                       LDFLAGS="-mmacosx-version-min=13.0")
    configure = [source / "configure", "--host=" + target + "-apple-darwin"] + CONFIGURE_FLAGS
    for command, log in ((configure, "configure.log"),
                         (["make", "-j" + str(min(8, os.cpu_count() or 2))], "build.log")):
        with (build / log).open("w") as output:
            result = subprocess.run([str(arg) for arg in command], cwd=build, env=environment,
                                    stdout=output, stderr=subprocess.STDOUT)
        if result.returncode:
            raise RuntimeError(f"WebP build failed; see {build / log}")
    destination = PROJECT / ("Resources/bin" if target == "arm64" else "Resources/macos-x86_64/bin")
    destination.mkdir(parents=True, exist_ok=True)
    details = {}
    for name in TOOLS:
        binary = destination / name
        shutil.copy2(build / "examples" / name, binary)
        binary.chmod(0o755)
        if run(["/usr/bin/lipo", "-archs", binary]).strip() != target:
            raise RuntimeError(f"Wrong architecture for {binary}")
        commands = run(["/usr/bin/otool", "-l", binary])
        minimum = re.search(r"\bminos\s+(\S+)", commands)
        if not minimum or minimum.group(1) != "13.0":
            raise RuntimeError(f"Unexpected deployment target for {binary}")
        libraries = [line.strip().split(" (", 1)[0]
                     for line in run(["/usr/bin/otool", "-L", binary]).splitlines()[1:]]
        if any(not path.startswith(("/usr/lib/", "/System/Library/")) for path in libraries):
            raise RuntimeError(f"Non-system dependency in {binary}: {libraries}")
        run(["/usr/bin/codesign", "--force", "--sign", "-", binary])
        run(["/usr/bin/codesign", "--verify", "--strict", binary])
        details[name] = {"sha256": digest(binary), "bytes": binary.stat().st_size,
                         "architecture": target, "minimum_macos": "13.0", "libraries": libraries}
    native = platform.machine().lower()
    checked = smoke_test(destination, "") if native == target else {"passed": None, "reason": "Cross-architecture build; run smoke test on target hardware."}
    return destination, details, checked


def prepare_windows():
    archive = download(WINDOWS_NAME, WINDOWS_SHA256)
    destination = PROJECT / "desktop/vendor/win32-x64"
    destination.mkdir(parents=True, exist_ok=True)
    details = {}
    with zipfile.ZipFile(archive) as zip_file:
        for name in TOOLS:
            binary = destination / (name + ".exe")
            data = zip_file.read(f"libwebp-{VERSION}-windows-x64/bin/{name}.exe")
            if data[:2] != b"MZ":
                raise RuntimeError(f"Not a Windows executable: {name}")
            pe = int.from_bytes(data[60:64], "little")
            if data[pe:pe + 6] != b"PE\x00\x00\x64\x86":
                raise RuntimeError(f"Not a Windows x64 executable: {name}")
            binary.write_bytes(data)
            details[name + ".exe"] = {"sha256": digest(binary), "bytes": len(data),
                                       "architecture": "x86_64", "modified": False}
    checked = smoke_test(destination, ".exe") if sys.platform == "win32" else {"passed": None, "reason": "Windows binary extraction on another host; run self-check on Windows CI."}
    return destination, details, checked


def main():
    default = "windows-x64" if sys.platform == "win32" else platform.machine().lower()
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--target", choices=("arm64", "x86_64", "windows-x64"), default=default)
    args = parser.parse_args()
    if args.target not in ("arm64", "x86_64", "windows-x64"):
        parser.error("Select a supported --target.")
    CACHE.mkdir(parents=True, exist_ok=True)
    source = source_and_notices(download(SOURCE_NAME, SOURCE_SHA256))
    destination, binaries, checked = prepare_windows() if args.target == "windows-x64" else prepare_macos(args.target, source)
    manifest = {"version": VERSION, "target": args.target, "binaries": binaries, "smoke_test": checked}
    (LICENSES / (args.target + ".json")).write_text(json.dumps(manifest, indent=2) + "\n")
    print(f"Prepared {VERSION} {', '.join(TOOLS)} for {args.target}: {destination}")


if __name__ == "__main__":
    main()
