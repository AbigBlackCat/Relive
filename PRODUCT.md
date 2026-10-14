# Relive

## 产品目标

用户在 Apple Silicon Mac 上将 SVG、GIF、MOV、MPV 等文件制作成实况图，在 iPhone 小红书上传。软件名为 Relive，提供简便前端、预览、任意帧封面选择和可打开的软件包。iPhone 是用户确认的发布设备。

## 实现范围

本地原生 macOS 工作台，内置 FFmpeg。Live Photo 以 Apple JPEG/MOV 配对和封面时间标记输出到 .pvt 包，原文件保留。支持首帧、当前帧、数值帧号选择，完整视频或裁切片段，尺寸上限与保留声音设置。

## 已知边界

首版面向 Apple Silicon、macOS 13+。SVG 支持自包含 SMIL/CSS，静态文件不会新增运动。应用不执行 SVG 脚本或外链。不持久化编辑项目。Mac 系统识别有自动测试，iPhone 小红书发布尚需设备侧实测。

## 视觉参考

用户提供的 openscreen-main.zip。采用深色编辑器、大预览、侧栏参数、底部时间线；只保留实况图制作所需操作。
