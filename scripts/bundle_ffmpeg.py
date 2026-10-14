#!/usr/bin/env python3
"""Bundle arm64 or x86_64 macOS FFmpeg tools without a Conda runtime."""

import argparse
import hashlib
import json
import platform
import re
import shutil
import subprocess
import tempfile
from pathlib import Path


PROJECT = Path(__file__).resolve().parent.parent
SYSTEM_PREFIXES = ("/usr/lib/", "/System/Library/")


def run(*args, **kwargs):
    return subprocess.run(args, check=True, capture_output=True, text=True, timeout=120, **kwargs).stdout


def load_commands(path):
    dependencies = [
        line.strip().split(" (compatibility", 1)[0]
        for line in run("/usr/bin/otool", "-L", str(path)).splitlines()[1:]
    ]
    commands = run("/usr/bin/otool", "-l", str(path))
    rpaths = re.findall(r"cmd LC_RPATH\n(?:.*\n){1,3}?\s*path (.+) \(offset", commands)
    identity = run("/usr/bin/otool", "-D", str(path)).splitlines()[1:]
    return [dep for dep in dependencies if dep not in identity], rpaths


def dependency_graph(executables, architecture):
    graph = {}
    executable_dir = executables[0].parent

    def expand(path, loader):
        return Path(path.replace("@loader_path", str(loader.parent)).replace(
            "@executable_path", str(executable_dir)))

    def visit(path, inherited_rpaths=()):
        path = path.resolve()
        if path in graph:
            return
        if architecture not in run("/usr/bin/lipo", "-archs", str(path)).split():
            raise RuntimeError(f"Not a {architecture} Mach-O binary: {path}")
        dependencies, rpaths = load_commands(path)
        search_paths = tuple(expand(item, path) for item in rpaths) + inherited_rpaths
        graph[path] = {"dependencies": {}, "rpaths": rpaths}
        for dependency in dependencies:
            if dependency.startswith(SYSTEM_PREFIXES):
                continue
            candidates = [base / dependency[len("@rpath/"):]
                          for base in search_paths] if dependency.startswith("@rpath/") else [expand(dependency, path)]
            resolved = next((candidate.resolve() for candidate in candidates if candidate.is_file()), None)
            if resolved is None:
                raise RuntimeError(f"Cannot resolve {dependency} required by {path}")
            graph[path]["dependencies"][dependency] = resolved
            visit(resolved, search_paths)

    for executable in executables:
        visit(executable)
    return graph


def collect_licenses(prefix, graph, destination, architecture):
    """Copy original notices, source recipes, and exact binary provenance."""
    owners = {}
    wanted_names = {path.name for path in graph}
    for metadata_path in sorted((prefix / "conda-meta").glob("*.json")):
        metadata = json.loads(metadata_path.read_text())
        for filename in metadata.get("files", []):
            if Path(filename).name not in wanted_names:
                continue
            absolute = prefix / filename
            if absolute.exists():
                resolved = absolute.resolve()
                if resolved not in owners or not absolute.is_symlink():
                    owners[resolved] = metadata

    if destination.exists():
        shutil.rmtree(destination)
    destination.mkdir(parents=True)
    included = {}
    files = []
    for binary in sorted(graph):
        package = owners.get(binary)
        if package is None:
            raise RuntimeError(f"No installed package metadata owns {binary}")
        key = f"{package['name']}-{package['version']}-{package['build']}"
        files.append({"binary": binary.name, "package": key,
                      "original_sha256": hashlib.sha256(binary.read_bytes()).hexdigest()})
        if key in included:
            continue
        cache = Path(package.get("extracted_package_dir") or package["link"]["source"])
        notices = cache / "info" / "licenses"
        if not notices.is_dir() or not any(notices.iterdir()):
            raise RuntimeError(f"Missing original license notices: {key}")
        package_dest = destination / key
        shutil.copytree(notices, package_dest / "licenses")
        recipe = cache / "info" / "recipe"
        if recipe.is_dir():
            shutil.copytree(recipe, package_dest / "recipe")
        about_path = cache / "info" / "about.json"
        about = json.loads(about_path.read_text()) if about_path.exists() else {}
        recipe_text = "\n".join(p.read_text(errors="replace") for p in recipe.glob("meta.yaml*"))
        source_block = re.search(r"^source:\s*\n(.*?)(?=^\w|\Z)", recipe_text, re.M | re.S)
        included[key] = {
            "name": package["name"], "version": package["version"], "build": package["build"],
            "license": about.get("license", package.get("license", "")),
            "binary_download": package.get("url", ""),
            "homepage": about.get("home", ""), "upstream_repository": about.get("dev_url", ""),
            "source_recipe": source_block.group(1).strip() if source_block else "See the copied recipe files.",
            "recipe_repository": about.get("extra", {}).get("remote_url", ""),
            "recipe_commit": about.get("extra", {}).get("sha", ""),
        }
        (package_dest / "provenance.json").write_text(json.dumps(included[key], ensure_ascii=False, indent=2) + "\n")

    manifest = {"architecture": architecture, "packages": included, "binaries": files}
    (destination / "manifest.json").write_text(json.dumps(manifest, ensure_ascii=False, indent=2) + "\n")
    version = run(str(prefix / "bin" / "ffmpeg"), "-version")
    license_statement = run(str(prefix / "bin" / "ffmpeg"), "-hide_banner", "-L")
    (destination / "ffmpeg-version.txt").write_text(version)
    (destination / "ffmpeg-license.txt").write_text(license_statement)
    lines = [
        "# FFmpeg and bundled library notices", "",
        f"This local Relive build includes FFmpeg / ffprobe 6.1.1 for macOS ({architecture}).",
        "The original binaries come from the installed Conda packages listed below; no Conda installation is needed to run Relive.",
        "Only Mach-O dependency paths and ad-hoc signatures were changed. The media libraries were not recompiled.", "",
        "FFmpeg reports GPL version 3 or later for this build (`--enable-gpl --enable-version3`).",
        "Original license notices are copied verbatim into each package's `licenses` folder.",
        "Exact upstream source archive URLs, checksums, build recipes, and package download URLs are recorded in `manifest.json` and the copied `recipe` folders.",
        "The FFmpeg 6.1.1 upstream source is https://ffmpeg.org/releases/ffmpeg-6.1.1.tar.gz; the Conda recipe includes its patch and build instructions.", "",
        "These files document provenance and licenses. They are not a complete corresponding-source archive.",
        "Any public redistribution must supply the corresponding source and applicable notices under each package's license; preserve this folder with the application.", "",
        "| Package | Version | License | Upstream source / repository |",
        "| --- | --- | --- | --- |",
    ]
    for package in included.values():
        link = package["upstream_repository"] or package["homepage"] or "See copied recipe"
        lines.append(f"| {package['name']} | {package['version']} | {package['license']} | {link} |")
    (destination / "README.md").write_text("\n".join(lines) + "\n")
    return manifest


def smoke_test(resources):
    with tempfile.TemporaryDirectory(prefix="relive-ffmpeg-test-") as directory:
        work = Path(directory)
        clean_env = {"PATH": "/usr/bin:/bin:/usr/sbin:/sbin", "HOME": str(work),
                     "TMPDIR": str(work), "LC_ALL": "C"}
        ffmpeg = str(resources / "bin" / "ffmpeg")
        ffprobe = str(resources / "bin" / "ffprobe")
        run(ffmpeg, "-version", env=clean_env, cwd=work)
        run(ffprobe, "-version", env=clean_env, cwd=work)
        output = work / "color.mp4"
        run(ffmpeg, "-hide_banner", "-loglevel", "error", "-nostdin", "-y", "-f", "lavfi",
            "-i", "testsrc2=size=128x128:rate=30", "-t", "1", "-c:v", "libx264", "-pix_fmt",
            "yuv420p", "-movflags", "+faststart", str(output), env=clean_env, cwd=work)
        result = json.loads(run(ffprobe, "-v", "error", "-show_streams", "-show_format", "-of",
                                "json", str(output), env=clean_env, cwd=work))
        stream = result["streams"][0]
        assert stream["codec_name"] == "h264", result
        assert stream["width"] == stream["height"] == 128, result
        assert int(stream["nb_frames"]) == 30, result
        assert 0.99 <= float(result["format"]["duration"]) <= 1.01, result
        return {"passed": True, "environment": "No inherited environment or DYLD variables; system PATH only",
                "sample": "1 second / 128x128 / 30 fps / H.264 color test pattern", "output_bytes": output.stat().st_size}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--prefix", type=Path, default=Path("/opt/anaconda3"))
    parser.add_argument("--arch", choices=("arm64", "x86_64"), default="arm64")
    parser.add_argument("--resources", type=Path)
    parser.add_argument("--licenses", type=Path)
    args = parser.parse_args()
    if platform.system() != "Darwin":
        parser.error("This bundler requires macOS and Apple's command line tools.")
    args.prefix = args.prefix.resolve()
    args.resources = args.resources or PROJECT / ("Resources" if args.arch == "arm64" else "Resources/macos-x86_64")
    args.licenses = args.licenses or PROJECT / "licenses" / ("ffmpeg" if args.arch == "arm64" else "ffmpeg-x86_64")
    executables = [args.prefix / "bin" / name for name in ("ffmpeg", "ffprobe")]
    graph = dependency_graph(executables, args.arch)
    resources = args.resources.resolve()
    (resources / "bin").mkdir(parents=True, exist_ok=True)
    if (resources / "lib").exists():
        shutil.rmtree(resources / "lib")
    (resources / "lib").mkdir(parents=True)
    destinations = {}
    for source in graph:
        target = resources / ("bin" if source in executables else "lib") / source.name
        if target in destinations.values():
            raise RuntimeError(f"Two distinct libraries have the same filename: {source.name}")
        shutil.copy2(source, target)
        target.chmod(0o755)
        destinations[source] = target
    for source, target in destinations.items():
        for old, dependency in graph[source]["dependencies"].items():
            relative = "../lib/" if target.parent.name == "bin" else ""
            run("/usr/bin/install_name_tool", "-change", old,
                f"@loader_path/{relative}{destinations[dependency].name}", str(target))
        for rpath in dict.fromkeys(graph[source]["rpaths"]):
            run("/usr/bin/install_name_tool", "-delete_rpath", rpath, str(target))
        if target.parent.name == "lib":
            run("/usr/bin/install_name_tool", "-id", f"@rpath/{target.name}", str(target))
        run("/usr/bin/codesign", "--force", "--sign", "-", "--timestamp=none", str(target))
        run("/usr/bin/codesign", "--verify", "--strict", str(target))
        dependencies, rpaths = load_commands(target)
        assert not rpaths, (target, rpaths)
        assert all(dep.startswith(SYSTEM_PREFIXES + ("@loader_path/",)) for dep in dependencies), (target, dependencies)
    manifest = collect_licenses(args.prefix, graph, args.licenses, args.arch)
    manifest["smoke_test"] = smoke_test(resources)
    manifest["bundled_bytes"] = sum(path.stat().st_size for path in destinations.values())
    for binary in manifest["binaries"]:
        target = next(path for path in destinations.values() if path.name == binary["binary"])
        binary["bundled_sha256"] = hashlib.sha256(target.read_bytes()).hexdigest()
    (args.licenses / "manifest.json").write_text(json.dumps(manifest, ensure_ascii=False, indent=2) + "\n")
    print(json.dumps({"files": len(graph), "bytes": manifest["bundled_bytes"],
                      "license_packages": len(manifest["packages"]), "smoke_test": manifest["smoke_test"]}, indent=2))


if __name__ == "__main__":
    main()
