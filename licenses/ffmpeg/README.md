# FFmpeg and bundled library notices

This local Relive build includes FFmpeg / ffprobe 6.1.1 for Apple Silicon (arm64).
The original binaries come from the installed Conda packages listed below; no Conda installation is needed to run Relive.
Only Mach-O dependency paths and ad-hoc signatures were changed. The media libraries were not recompiled.

FFmpeg reports GPL version 3 or later for this build (`--enable-gpl --enable-version3`).
Original license notices are copied verbatim into each package's `licenses` folder.
Exact upstream source archive URLs, checksums, build recipes, and package download URLs are recorded in `manifest.json` and the copied `recipe` folders.
The FFmpeg 6.1.1 upstream source is https://ffmpeg.org/releases/ffmpeg-6.1.1.tar.gz; the Conda recipe includes its patch and build instructions.

These files document provenance and licenses. They are not a complete corresponding-source archive.
Any public redistribution must supply the corresponding source and applicable notices under each package's license; preserve this folder with the application.

| Package | Version | License | Upstream source / repository |
| --- | --- | --- | --- |
| ffmpeg | 6.1.1 | GPL-2.0-or-later | https://git.ffmpeg.org/ffmpeg.git |
| svt-av1 | 1.8.0 | BSD-2-Clause | https://gitlab.com/AOMediaCodec/SVT-AV1 |
| aom | 3.7.1 | BSD-2-Clause | https://aomedia.googlesource.com/aom/ |
| libass | 0.17.1 | ISC | https://github.com/libass/libass |
| bzip2 | 1.0.8 | bzip2-1.0.6 | http://www.bzip.org/ |
| libcxx | 23.1.1 | Apache-2.0 WITH LLVM-exception | https://github.com/llvm/llvm-project |
| dav1d | 1.2.1 | BSD-2-Clause | https://code.videolan.org/videolan/dav1d |
| libexpat | 2.8.1 | MIT | https://github.com/libexpat/libexpat |
| libffi | 3.4.4 | MIT | https://github.com/libffi/libffi |
| fontconfig | 2.14.2 | MIT | https://cgit.freedesktop.org/fontconfig/ |
| freetype | 2.12.1 | GPL-2-only and LicenseRef-FreeType | https://gitlab.freedesktop.org/freetype/freetype |
| fribidi | 1.0.16 | LGPL-2.1-or-later | https://github.com/fribidi/fribidi |
| libglib | 2.78.4 | LGPL-2.1-or-later | https://gitlab.gnome.org/GNOME/glib/ |
| gnutls | 3.7.9 | LGPL-2.1-or-later | https://gitlab.com/gnutls/gnutls/tree/master |
| graphite2 | 1.3.15 | LGPL-2.0-or-later | https://github.com/silnrsi/graphite |
| harfbuzz | 8.3.0 | MIT | https://github.com/harfbuzz/harfbuzz |
| nettle | 3.9.1 | GPL 2 and LGPL3 | https://git.lysator.liu.se/nettle/nettle |
| libiconv | 1.18 | LGPL-2.1-only | https://www.gnu.org/software/libiconv/ |
| icu | 73.2 | MIT | https://github.com/unicode-org/icu |
| libidn2 | 2.3.8 | LGPL-2.0-only | https://www.gnu.org/software/libidn/#libidn2 |
| libintl | 0.25.1 | LGPL-2.1-or-later | https://www.gnu.org/software/gettext/ |
| xz | 5.4.5 | LGPL-2.1-or-later and GPL-2.0-or-later | https://git.tukaani.org/ |
| lame | 3.100 | LGPL-2.0-only | https://svn.code.sf.net/p/lame/svn/trunk/lame/ |
| openh264 | 2.4.0 | BSD-2-Clause | https://github.com/cisco/openh264 |
| libopenvino | 2023.2.0 |  | See copied recipe |
| libopus | 1.6.1 | BSD-3-Clause | https://github.com/xiph/opus |
| p11-kit | 0.24.1 | MIT | https://github.com/p11-glue/p11-kit |
| pcre2 | 10.42 | BSD-3-Clause | https://github.com/PCRE2Project/pcre2 |
| libpng | 1.6.39 | Zlib | https://sourceforge.net/p/libpng/code/ci/libpng16/tree/ |
| pugixml | 1.14 | MIT | https://github.com/zeux/pugixml |
| libtasn1 | 4.21.0 | LGPL-2.1-or-later | https://gitlab.com/gnutls/libtasn1/ |
| tbb | 2021.8.0 | Apache-2.0 | https://github.com/oneapi-src/oneTBB |
| libunistring | 0.9.10 | GPL-3.0-only OR LGPL-3.0-only | https://www.gnu.org/software/libunistring |
| libvpx | 1.13.1 | BSD-3-Clause | https://chromium.googlesource.com/webm/libvpx |
| x264 | 1!164.3095 | GPL-2.0-or-later | https://code.videolan.org/videolan/x264 |
| x265 | 3.5 | GPL-2.0-or-later | https://bitbucket.org/multicoreware/x265_git |
| libxml2 | 2.12.7 | MIT | https://git.gnome.org/browse/libxml2/ |
| libzlib | 1.2.13 | Zlib | https://github.com/madler/zlib |
