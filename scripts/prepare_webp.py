#!/usr/bin/env python3
"""Prepare checksum-pinned libwebp tools for Relive, without changing FFmpeg."""

import argparse
import difflib
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
from pathlib import Path


PROJECT = Path(__file__).resolve().parent.parent
VERSION = "1.6.0"
BASE_URL = "https://storage.googleapis.com/downloads.webmproject.org/releases/webp/"
SOURCE_NAME = f"libwebp-{VERSION}.tar.gz"
SOURCE_SHA256 = "e4ab7009bf0629fd11982d4c2aa83964cf244cffba7347ecd39019a9e38c4564"
TOOLS = ("img2webp", "webpinfo")
CACHE = PROJECT / ".build/webp"
LICENSES = PROJECT / "licenses/webp"
CONFIGURE_FLAGS = ["--disable-shared", "--enable-static", "--disable-sdl",
                   "--disable-png", "--disable-jpeg", "--disable-tiff",
                   "--disable-gl", "--disable-threading"]
CMAKE_FLAGS = ["-DBUILD_SHARED_LIBS=OFF", "-DWEBP_LINK_STATIC=ON",
               "-DWEBP_UNICODE=OFF", "-DCMAKE_POLICY_DEFAULT_CMP0091=NEW",
               "-DCMAKE_MSVC_RUNTIME_LIBRARY=MultiThreaded",
               "-DWEBP_USE_THREAD=OFF", "-DWEBP_BUILD_IMG2WEBP=ON", "-DWEBP_BUILD_WEBPINFO=ON",
               "-DWEBP_BUILD_LIBWEBPMUX=ON", "-DWEBP_BUILD_ANIM_UTILS=OFF",
               "-DWEBP_BUILD_CWEBP=OFF", "-DWEBP_BUILD_DWEBP=OFF", "-DWEBP_BUILD_GIF2WEBP=OFF",
               "-DWEBP_BUILD_VWEBP=OFF", "-DWEBP_BUILD_WEBPMUX=OFF", "-DWEBP_BUILD_EXTRAS=OFF",
               "-DCMAKE_DISABLE_FIND_PACKAGE_PNG=ON", "-DCMAKE_DISABLE_FIND_PACKAGE_JPEG=ON",
               "-DCMAKE_DISABLE_FIND_PACKAGE_TIFF=ON", "-DCMAKE_DISABLE_FIND_PACKAGE_GIF=ON"]
MAX_ARGUMENTS = 1_048_576


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
        member = tar.extractfile(f"libwebp-{VERSION}/examples/example_util.c")
        original = member.read().decode("utf-8")
    old, new = "#define MAX_ARGC 16384\n", f"#define MAX_ARGC {MAX_ARGUMENTS}\n"
    if original.count(old) != 1:
        raise RuntimeError("Pinned WebP argument capacity source did not match exactly once.")
    patched = original.replace(old, new)
    utility = source / "examples/example_util.c"
    if utility.read_bytes() not in (original.encode(), patched.encode()):
        raise RuntimeError("WebP example_util.c differs from the pinned source and capacity patch.")
    if utility.read_bytes() != patched.encode():
        utility.write_bytes(patched.encode())
    patch = "".join(difflib.unified_diff(original.splitlines(keepends=True), patched.splitlines(keepends=True),
                                        fromfile="a/examples/example_util.c", tofile="b/examples/example_util.c"))
    (LICENSES / "argument-capacity.patch").write_bytes(patch.encode())
    provenance = {
        "name": "libwebp", "version": VERSION, "license": "BSD-3-Clause",
        "homepage": "https://developers.google.com/speed/webp/",
        "repository": "https://chromium.googlesource.com/webm/libwebp",
        "source": {"url": BASE_URL + SOURCE_NAME, "sha256": SOURCE_SHA256},
        "bundled_tools": list(TOOLS),
        "macos": {"minimum_version": "13.0", "linkage": "static",
                  "configure_flags": CONFIGURE_FLAGS},
        "windows": {"architecture": "x86_64", "generator_selection": "Newest installed C++ Visual Studio reported by vswhere with a matching CMake generator",
                    "cmake_flags": CMAKE_FLAGS, "runtime": "static MSVC CRT",
                    "unicode": False, "source_build": True},
        "source_patch": {"file": "argument-capacity.patch", "sha256": digest(LICENSES / "argument-capacity.patch"),
                         "reason": "Raise heap argument capacity to 1048576; no codec algorithm changes.",
                         "original_file_sha256": hashlib.sha256(original.encode()).hexdigest(),
                         "patched_file_sha256": hashlib.sha256(patched.encode()).hexdigest()},
    }
    (LICENSES / "provenance.json").write_text(json.dumps(provenance, indent=2) + "\n")
    (LICENSES / "README.txt").write_text(
        "Relive includes img2webp and webpinfo from libwebp 1.6.0.\n"
        "Original Google copyright, BSD license and patent grant are in COPYING and PATENTS.\n"
        "macOS binaries are built from the checksum-pinned official source with a macOS 13.0\n"
        "deployment target, static linkage and no optional image or UI libraries. Only\n"
        "Apple system libraries are needed; PNG/JPEG/TIFF support is not included.\n"
        "Windows x64 binaries are built from the same pinned official source using CMake\n"
        "and MSVC, with static libraries and CRT. WEBP_UNICODE=OFF enables argument files;\n"
        "the application supplies relative ASCII filenames inside a Unicode working directory.\n"
        "argument-capacity.patch raises only the heap argument array capacity from 16384 to\n"
        "1048576 on all platforms. It does not change encoding, frame ordering or timing.\n"
        "Exact source URL, SHA256, build flags and the patch hash are in provenance.json.\n"
        "Per-target manifests contain the installed tool hashes and validation results.\n"
        "Rebuild: python3 scripts/prepare_webp.py --target arm64|x86_64|windows-x64\n"
        "Only the selected target is prepared. A macOS host with Xcode command-line tools\n"
        "is required to compile macOS targets; Windows builds need CMake and VS 2022 or newer C++\n"
        "tools. vswhere selects the newest installed version supported by CMake's generators.\n"
        "These build tools, Conda, Homebrew and the VC redistributable are not needed to run Relive.\n")
    return source


def smoke_test(binary_directory, suffix):
    with tempfile.TemporaryDirectory(prefix="Relive-webp-tools-") as temporary:
        directory = Path(temporary) / "Unicode 中文 with spaces"
        directory.mkdir()
        for name, color in (("red", b"\xff\x00\x00"), ("blue", b"\x00\x00\xff")):
            (directory / (name + ".ppm")).write_bytes(b"P6\n2 2\n255\n" + color * 4)
        (directory / "arguments.txt").write_text(
            "-loop 0 -lossy -q 80 -m 4 -d 40 red.ppm blue.ppm -o animated.webp\n", encoding="ascii")
        run([binary_directory / ("img2webp" + suffix), "arguments.txt"], cwd=directory)
        info = run([binary_directory / ("webpinfo" + suffix), "-diag", "-summary", "animated.webp"], cwd=directory)
        if not (re.search(r"Number of frames:\s*2\b", info)
                and re.search(r"Loop count\s*:\s*0\b", info)
                and sum(map(int, re.findall(r"Duration:\s*(\d+)", info))) == 80):
            raise RuntimeError("Bundled WebP tools failed animated PPM encoding validation.")
        (directory / "single.txt").write_text("-lossy -q 80 red.ppm -o still.webp\n", encoding="ascii")
        run([binary_directory / ("img2webp" + suffix), "single.txt"], cwd=directory)
        still = run([binary_directory / ("webpinfo" + suffix), "-diag", "-summary",
                     "still.webp"], cwd=directory)
        if not re.search(r"Number of frames:\s*1\b", still):
            raise RuntimeError("Bundled WebP tools failed single-frame validation.")
        (directory / "long.txt").write_text(
            "-loop 0 -lossy -q 80 -m 4\n" + "-d 1 red.ppm\n" * 6000 + "-o long.webp\n", encoding="ascii")
        run([binary_directory / ("img2webp" + suffix), "long.txt"], cwd=directory)
        long_info = run([binary_directory / ("webpinfo" + suffix), "-diag", "-summary", "long.webp"], cwd=directory)
        if not re.search(r"Number of frames:\s*1\b", long_info):
            raise RuntimeError("Bundled WebP tools failed the >16384-token argument file check.")
    return {"passed": True, "cases": ["relative argument file in Unicode cwd: 2 frames, 80 ms, infinite loop",
                                       "single-frame WebP", "6000 repeated frames, >16384 tokens, static merge"]}


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
            print((build / log).read_text(errors="replace")[-6000:], file=sys.stderr)
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


def windows_imports(data):
    def word(offset, length=4):
        return int.from_bytes(data[offset:offset + length], "little")
    pe = word(60)
    if data[:2] != b"MZ" or data[pe:pe + 6] != b"PE\x00\x00\x64\x86" or word(pe + 24, 2) != 0x20b:
        raise RuntimeError("Not a Windows x64 PE32+ executable.")
    section_start = pe + 24 + word(pe + 20, 2)
    sections = [section_start + n * 40 for n in range(word(pe + 6, 2))]
    def offset(rva):
        for section in sections:
            address = word(section + 12)
            if address <= rva < address + max(word(section + 8), word(section + 16)):
                return word(section + 20) + rva - address
        raise RuntimeError("Invalid import RVA in compiled WebP tool.")
    imports, descriptor = [], offset(word(pe + 24 + 120))
    while any(data[descriptor:descriptor + 20]):
        name = offset(word(descriptor + 12))
        imports.append(data[name:data.index(b"\0", name)].decode("ascii"))
        descriptor += 20
    system = {"kernel32.dll", "shell32.dll", "shlwapi.dll", "ole32.dll", "windowscodecs.dll",
              "advapi32.dll", "user32.dll", "ntdll.dll"}
    if any(name.lower() not in system for name in imports):
        raise RuntimeError(f"Non-system or dynamic CRT dependency in WebP tool: {imports}")
    return sorted(imports)


def choose_visual_studio(instances, generators):
    supported = {}
    for generator in generators:
        match = re.fullmatch(r"Visual Studio (\d+) \d{4}", generator["name"])
        if match:
            supported[int(match[1])] = generator["name"]
    choices = []
    for instance in instances:
        version = tuple(int(part) for part in instance.get("installationVersion", "").split(".") if part.isdigit())
        if not version or version[0] < 17 or version[0] not in supported or instance.get("isComplete") is False:
            continue
        if instance.get("installationPath"):
            choices.append((version, instance))
    if not choices:
        installed = [instance.get("installationVersion") for instance in instances]
        raise RuntimeError(f"No installed VS 2022 or newer C++ toolset matches a CMake generator. Installed: {installed}; supported: {list(supported.values())}")
    version, instance = max(choices, key=lambda choice: choice[0])
    return {"generator": supported[version[0]], "installation_path": instance["installationPath"],
            "installation_version": instance["installationVersion"]}


def discover_visual_studio():
    vswhere = shutil.which("vswhere")
    if not vswhere:
        vswhere = str(Path(os.environ.get("ProgramFiles(x86)", r"C:\Program Files (x86)"))
                      / "Microsoft Visual Studio/Installer/vswhere.exe")
    if not Path(vswhere).is_file():
        raise RuntimeError("Visual Studio Installer's vswhere.exe is required to find the C++ build tools.")
    instances = json.loads(run([vswhere, "-all", "-prerelease", "-products", "*", "-requires",
                                "Microsoft.VisualStudio.Component.VC.Tools.x86.x64", "-format", "json", "-utf8"], encoding="utf-8-sig"))
    capabilities = json.loads(run(["cmake", "-E", "capabilities"]))
    return choose_visual_studio(instances, capabilities["generators"])


def prepare_windows(source):
    if sys.platform != "win32":
        raise RuntimeError("Compile Windows WebP tools on a Windows host with CMake and Visual Studio C++ tools.")
    toolchain = discover_visual_studio()
    print(f"Selected {toolchain['generator']}: {toolchain['installation_path']} ({toolchain['installation_version']})")
    major = toolchain["installation_version"].split(".")[0]
    build = CACHE / ("build-windows-x64-vs" + major)
    build.mkdir(exist_ok=True)
    configure = ["cmake", "-S", source, "-B", build, "-G", toolchain["generator"], "-A", "x64",
                 "-DCMAKE_GENERATOR_INSTANCE=" + toolchain["installation_path"],
                 "-DCMAKE_RUNTIME_OUTPUT_DIRECTORY_RELEASE=" + str(build / "bin")] + CMAKE_FLAGS
    commands = [(configure, "configure.log"),
                (["cmake", "--build", build, "--config", "Release", "--parallel", "4",
                  "--target", "img2webp", "webpinfo"], "build.log")]
    for command, log in commands:
        with (build / log).open("w") as output:
            result = subprocess.run([str(arg) for arg in command], stdout=output, stderr=subprocess.STDOUT)
        if result.returncode:
            print((build / log).read_text(errors="replace")[-6000:], file=sys.stderr)
            raise RuntimeError(f"Windows WebP build failed; see {build / log}")
    destination = PROJECT / "desktop/vendor/win32-x64"
    destination.mkdir(parents=True, exist_ok=True)
    details = {}
    for name in TOOLS:
        binary = destination / (name + ".exe")
        shutil.copy2(build / "bin" / (name + ".exe"), binary)
        imports = windows_imports(binary.read_bytes())
        details[name + ".exe"] = {"sha256": digest(binary), "bytes": binary.stat().st_size,
                                   "architecture": "x86_64", "source_build": True,
                                   "unicode": False, "crt": "static", "libraries": imports,
                                   "toolchain": toolchain}
    checked = smoke_test(destination, ".exe")
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
    destination, binaries, checked = prepare_windows(source) if args.target == "windows-x64" else prepare_macos(args.target, source)
    manifest = {"version": VERSION, "target": args.target, "binaries": binaries, "smoke_test": checked}
    (LICENSES / (args.target + ".json")).write_text(json.dumps(manifest, indent=2) + "\n")
    print(f"Prepared {VERSION} {', '.join(TOOLS)} for {args.target}: {destination}")


if __name__ == "__main__":
    main()
