#!/usr/bin/env python3
"""Download and bundle the Intel FFmpeg 6.1.1 runtime into Relive resources."""

import argparse
import os
import shutil
import subprocess
import sys
from pathlib import Path


PROJECT = Path(__file__).resolve().parent.parent


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--conda", default=os.environ.get("CONDA_EXE") or shutil.which("conda"))
    parser.add_argument("--prefix", type=Path, default=PROJECT / ".build/ffmpeg-osx-64")
    parser.add_argument("--skip-runtime-test", action="store_true")
    args = parser.parse_args()
    if not args.conda:
        parser.error("Install Conda / Miniforge or pass --conda /path/to/conda.")
    environment = dict(os.environ, CONDA_SUBDIR="osx-64", CONDA_NO_PLUGINS="true")
    subprocess.run([args.conda, "create", "--solver", "classic", "--override-channels",
                    "-c", "conda-forge", "--prefix", str(args.prefix),
                    "ffmpeg=6.1.1=gpl*", "--no-default-packages", "-y"],
                   env=environment, check=True)
    bundle = [sys.executable, str(PROJECT / "scripts/bundle_ffmpeg.py"),
              "--arch", "x86_64", "--prefix", str(args.prefix)]
    if args.skip_runtime_test:
        bundle.append("--skip-runtime-test")
    subprocess.run(bundle, check=True)


if __name__ == "__main__":
    main()
