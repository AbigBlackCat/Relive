# Relive

Mac 上的实况图制作台。原生 SwiftUI 界面，参考 OpenScreen 的深色编辑器布局；将 SVG、GIF、MOV、MP4、MPV 等素材转换为 Apple Live Photo，逐帧选择封面，用于 iPhone 相册与小红书发布流程。

## 使用

打开 `Relive.app` → 导入素材 → 时间线定位 / 左右箭头逐帧 → 设为封面 → 导出。

封面帧号从 1 开始计数。默认保留完整视频，可裁切片段。输出为 `.pvt`，包含配对 JPEG、MOV、封面时间 metadata；导出前会由 `PHLivePhoto` 识别校验。重名输出自动编号，原素材不修改。

双击 `.pvt` 或点击「导入照片」进入 Mac「照片」，通过 iCloud 照片或从「照片」内隔空投送进入 iPhone；确认 LIVE 后从小红书相册选择。Mac 原生识别已验证，iPhone 小红书实际发布尚未测试。官方依据见应用内「使用说明」。

SVG 支持 SMIL / CSS 动画，录制 1–30 秒。静态 SVG 不自动添加运动；外链、脚本、DTD 和实体定义不执行，文件需 UTF-8、图片/字体内嵌。预览规范化为 H.264，长边最高 1920 px、帧率最高 60 fps。视频支持范围由内置 FFmpeg 决定。MPV 是 MPEG 视频文件。

## 构建与验证

目标 Apple Silicon、macOS 13+。构建需要本机 Xcode；生成的软件不需要 Python、Xcode 或外部 FFmpeg。

```sh
scripts/build.sh
scripts/test.sh
```

FFmpeg 已独立打包在 `Resources/bin` 与 `Resources/lib`。如需从本机 Conda FFmpeg 重新收集运行时，可执行 `python3 scripts/bundle_ffmpeg.py`，该脚本默认读取 `/opt/anaconda3`。

集成自测覆盖：MOV + AAC、GIF、原始 MPV、SMIL/CSS SVG、非首帧封面、首帧封面、裁切与静音、重名拒绝、坏输入、取消与 SVG 实体隔离。另有 LivePhotoWriter 的独立首/中/末帧及损坏配对测试。产物由 Apple Photos 框架检查，不需要导入用户图库。

## 实现

- `MainView.swift`：素材栏、预览、帧带与导出检查器。
- `ReliveModel.swift`：编辑会话、帧选择、任务取消与安全导出。
- `MediaEngine.swift`：内置工具调用、转码、裁切及元数据探测。
- `SVGRenderer.swift`：受限 WKWebView 的定时 SVG 帧渲染。
- `LivePhotoWriter.swift`：ImageIO 配对封面、AVFoundation 压缩流 passthrough、封面 mebx 标记、Photos 原生验证。

导入素材复制到应用临时工作区后处理，避免子进程直接访问受保护目录。编辑列表仅在当前会话中保存；退出后清理临时预览，导出作品保留。

## 许可与分发

macOS 原生元数据实现参考 MIT makelive，操作台参考 MIT OpenScreen；保留相应声明在 `licenses/`。FFmpeg 及部分依赖采用 GPL v3 或更高版本；依赖的原始许可证、精确版本、Conda 构建 recipe、patch 和源代码地址也在 `licenses/ffmpeg/`。本地软件采用 ad-hoc 签名，未 Apple 公证。若未来公开分发，需要按这些许可证补齐对应源代码提供方式与正式签名/公证；当前包是为本机使用构建。
