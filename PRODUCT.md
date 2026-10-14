# Relive

## 产品目标

用户在 Apple Silicon Mac、Intel Mac 或 Windows 上将 SVG、GIF、MOV、MP4、MPV 等文件制作成实况图，存入 iPhone 相册后从小红书选择。软件名为 Relive，提供简便操作台、预览、逐帧定位、任意帧封面选择和可安装的软件包。iPhone 是用户确认的发布设备；GitHub 仓库 https://github.com/AbigBlackCat/Relive 当前为 private。

## 实现范围

1.1.0 交付 Apple Silicon 与 Intel 的原生 macOS 工作台（macOS 13+），以及 Windows 10 / 11 x64 的 Electron 安装版与便携 ZIP。三平台均内置 FFmpeg、ffprobe，全程本地处理。Live Photo 以 JPEG / MOV 配对和封面时间标记输出到 .pvt 包，原文件保留，重名自动编号。支持首帧、当前帧、从 1 开始的数值帧号、完整视频或裁切片段、1080 / 1920 像素最长边和声音开关。

Mac 通过「照片」导入 .pvt，再同步或隔空投送到 iPhone。Windows 用户需要支持 Live Photo 配对导入的 iOS 相册工具处理 JPEG + MOV，或经 Mac「照片」转入 iPhone；单独 JPEG 不会自动成为实况图。

## 已知边界

SVG 支持自包含 SMIL / CSS 动画，录制 1–30 秒；静态文件不会新增运动。应用不执行 SVG 脚本或外链，拒绝 DTD / 实体定义。不持久化编辑项目。Mac 导出通过 Photos 框架识别校验；Windows 导出执行配对结构、媒体与时间标记校验。原生 Intel CI 及 Windows 完整转换、打包后烟雾测试已通过，iPhone 小红书发布尚未实测。Mac 包未 Apple 公证，Windows 包未正式代码签名。

## 视觉参考

用户提供的 openscreen-main.zip。采用深色编辑器、大预览、侧栏参数、底部时间线；只保留实况图制作所需操作。
