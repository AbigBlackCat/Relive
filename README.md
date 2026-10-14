# Relive 1.1.0

本地实况图制作台，将 SVG、GIF、MOV、MP4、MPV 等素材转换为 Apple Live Photo，逐帧选择封面，用于 iPhone 相册与小红书发布流程。界面参考 OpenScreen：素材栏、大预览、底部帧带与导出检查器。源码与构建记录保存在[私有 GitHub 仓库](https://github.com/AbigBlackCat/Relive)。

## 安装

| 平台 | 系统要求 | 软件包 |
| --- | --- | --- |
| Apple Silicon Mac | macOS 13 或更新 | `Relive-1.1.0-AppleSilicon.dmg` |
| Intel Mac | macOS 13 或更新 | `Relive-1.1.0-Intel.dmg` |
| Windows x64 | Windows 10 / 11 | `Relive-1.1.0-Windows-x64-Setup.exe` 或 `Relive-1.1.0-Windows-x64.zip` |

Mac 打开对应芯片的 DMG，将 Relive 拖入「应用程序」。Windows 可以运行安装程序，或解压便携 ZIP 后打开 `Relive.exe`。三平台均内置 FFmpeg、ffprobe 及所需运行时；使用软件无需安装 Python、Node.js 或命令行工具。

macOS 包采用 ad-hoc 签名，未 Apple 公证；Windows 包未正式代码签名。

## 制作与发布

打开 Relive → 导入素材 → 时间线定位 / 左右箭头逐帧 → 设为封面 → 导出。可选首帧、当前帧或输入任意帧号；帧号从 1 开始。默认保留完整视频，也可裁切片段；封面须位于片段内。支持最长边 1080 / 1920 像素、原比例输出和声音开关。

输出为 `.pvt` 包，内含配对 JPEG、MOV 与实况封面时间标记。重名输出自动编号，原素材不修改。Mac 原生版导出会通过 Apple Photos 框架识别校验；Windows 版执行配对结构、媒体与时间标记校验。

- **通过 Mac：** 双击 `.pvt` 或点击「导入照片」，导入 Mac「照片」。通过 iCloud 照片同步，或从「照片」内隔空投送到 iPhone。
- **仅用 Windows：** 将包内配对 JPEG 和 MOV 交由支持 Live Photo 配对导入的 iOS 相册工具，存入 iPhone 系统相册；也可以将 `.pvt` 转交 Mac「照片」后传到 iPhone。

在 iPhone「照片」确认 LIVE 标识并可播放后，再从小红书相册选择。单独导入 JPEG 或直接上传 `.pvt` 不会自动成为实况照片。iPhone 小红书实际发布尚未测试，识别结果以手机当前版本为准。

SVG 支持 SMIL / CSS 动画，导入前可设置录制 1–30 秒及白色 / 黑色背景。静态 SVG 不自动添加运动；外链和脚本不执行，DTD 与实体定义不接受。请使用 UTF-8，并内嵌图片 / 字体。素材预览规范化为 H.264，长边最高 1920 像素、帧率最高 60 fps；视频解码范围由内置 FFmpeg 决定。MPV 是 MPEG 视频文件。

全部转换在本机执行，不上传素材。编辑列表仅保留当前会话；关闭软件后清理临时预览，已导出的作品保留。

## 构建与验证

Mac 原生版需要 Xcode。FFmpeg 二进制不存入 Git：Apple Silicon 运行时由 `scripts/bundle_ffmpeg.py` 从 arm64 Conda 环境收集，默认读取 `/opt/anaconda3`，也可用 `--prefix` 指定包含 FFmpeg 的环境；Intel 准备脚本需要 Conda / Miniforge。

```sh
# Apple Silicon：先准备 Resources/bin 与 Resources/lib
python3 scripts/bundle_ffmpeg.py --arch arm64
scripts/build.sh arm64
scripts/test.sh arm64
scripts/package.sh arm64

# Intel：准备对应 FFmpeg 后构建；自测需在 Intel Mac 上运行
python3 scripts/prepare_intel_ffmpeg.py
scripts/build.sh x86_64
scripts/test.sh x86_64
scripts/package.sh x86_64
```

Windows 版使用 Electron。开发与构建需要 Node.js 24、Python 3；FFmpeg 准备脚本下载指定版本并校验 SHA256。

```sh
npm ci
npm run prepare:windows
npm run desktop
npm run test:portable
npm run test:desktop
npm run build:windows
```

Windows 便携格式测试需要将 `RELIVE_FFMPEG` / `RELIVE_FFPROBE` 指向 `desktop/vendor/win32-x64/ffmpeg.exe` / `ffprobe.exe`。构建产物位于 `dist/windows/`。GitHub Actions 的 `Build Relive` 可手动选择 `all`、`windows` 或 `intel`，下载对应构建产物。

原生 Intel CI 自测、Windows 配对格式测试、完整转换 / SVG 捕获测试，以及打包后的 Windows 可执行文件烟雾测试均已通过。测试覆盖首 / 中 / 末帧封面、裁切、声音、重名保护、坏输入与取消；这些检查不等同于 iPhone 小红书发布验证。

## 实现与许可

Relive 自有源码采用 MIT License。第三方组件保留各自许可。

Mac 原生实现位于 `Sources/`；Windows 的 Electron 主进程、隔离桥、转换核心和操作台位于 `desktop/`。macOS 元数据实现参考 MIT makelive，操作台参考 MIT OpenScreen。第三方声明、FFmpeg 许可证和精确构建来源随包保留在 `licenses/`。
