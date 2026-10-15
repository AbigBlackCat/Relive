import AppKit
import AVFoundation
import Foundation
import ImageIO

enum SelfTests {
    @MainActor static func run(directory: URL) async throws {
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        let token = JobToken()
        let video = directory.appendingPathComponent("source.mov")
        _ = try await Tools.run("ffmpeg", ["-v", "error", "-y", "-f", "lavfi", "-i", "testsrc2=size=320x240:rate=30", "-f", "lavfi", "-i", "sine=frequency=440:sample_rate=48000", "-t", "1.2", "-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac", video.path], token: token)
        let gif = directory.appendingPathComponent("source.gif")
        _ = try await Tools.run("ffmpeg", ["-v", "error", "-y", "-i", video.path, "-vf", "fps=12,scale=160:120", gif.path], token: token)
        let mpv = directory.appendingPathComponent("source.mpv")
        _ = try await Tools.run("ffmpeg", ["-v", "error", "-y", "-i", video.path, "-an", "-c:v", "mpeg2video", "-f", "mpeg2video", mpv.path], token: token)
        let svg = directory.appendingPathComponent("animation.svg")
        try """
        <svg xmlns="http://www.w3.org/2000/svg" width="320" height="240" viewBox="0 0 320 240">
          <rect width="320" height="240" fill="#f2eee4"/>
          <circle cy="120" r="32" fill="#34b27b"><animate attributeName="cx" values="50;270;50" dur="1s" repeatCount="indefinite"/></circle>
          <style>@keyframes fade {from {opacity:1} to {opacity:.2}} .square{animation:fade 1s infinite alternate}</style>
          <rect class="square" x="140" y="20" width="40" height="40" fill="#e56a47"/>
        </svg>
        """.write(to: svg, atomically: true, encoding: .utf8)
        for source in [video, gif, mpv, svg] {
            let ext = source.pathExtension
            let normalized = directory.appendingPathComponent("normalized-" + ext + ".mp4")
            let info: MediaInfo
            if ext == "svg" {
                info = try await SVGRenderer().render(source: source, destination: normalized, duration: 1, background: "#FFFFFF", token: token, progress: { _ in })
            } else {
                info = try await MediaEngine.normalize(source: source, destination: normalized, durationForImage: 1, background: "#FFFFFF", token: token, progress: { _ in })
            }
            guard info.duration > 0, info.width == 320 || ext == "gif", info.fps > 0 else { throw ReliveError.message("\(ext) 规范化属性异常。") }
            if ext == "mov" && info.frames != 36 { throw ReliveError.message("音频 padding 导致视频帧数不准确。") }
            let package = try await LivePhotoWriter.write(video: normalized, coverTime: min(0.4, info.duration / 2), outputDirectory: directory, name: "test-" + ext)
            try await LivePhotoWriter.validate(package: package)
            print("PASS \(ext): \(info.width)x\(info.height) \(info.duration)s, Live Photo + cover")
            let webP = try await WebPEncoder.write(source: normalized, info: info, startFrame: 0, endFrame: info.frames,
                maxSide: 1080, outputDirectory: directory.appendingPathComponent("WebP 导出 中文"), name: "test " + ext,
                temporaryDirectory: directory, token: token, progress: { _ in })
            guard webP.info.width == info.width, webP.info.height == info.height,
                  webP.info.isAnimated, webP.info.loopCount == 0,
                  abs(webP.info.duration - Double(info.frames) / info.fps) <= 0.001 else {
                throw ReliveError.message("\(ext) WebP 属性异常。")
            }
            print("PASS \(ext): animated WebP, original duration + loop")
        }
        let svgVideo = directory.appendingPathComponent("normalized-svg.mp4")
        let first = try MediaEngine.image(svgVideo, at: 0)
        let middle = try MediaEngine.image(svgVideo, at: 0.5)
        guard first.tiffRepresentation != middle.tiffRepresentation else { throw ReliveError.message("SVG 动画没有产生变化。") }
        let videoInfo = try await MediaEngine.probe(directory.appendingPathComponent("normalized-mov.mp4"), token: token)
        let lastPackage = try await LivePhotoWriter.write(video: directory.appendingPathComponent("normalized-mov.mp4"), coverTime: Double(videoInfo.frames - 1) / videoInfo.fps, outputDirectory: directory, name: "test-last-frame")
        try await LivePhotoWriter.validate(package: lastPackage)
        print("PASS last real video frame with audio padding")
        let trimmed = directory.appendingPathComponent("trimmed.mp4")
        try await MediaEngine.clip(source: directory.appendingPathComponent("normalized-mov.mp4"), destination: trimmed, start: 0.2, duration: 0.6, maxSide: 1080, keepAudio: false, fps: 30, token: token, progress: { _ in })
        let clipInfo = try await MediaEngine.probe(trimmed, token: token)
        guard abs(clipInfo.duration - 0.6) < 0.05, !clipInfo.hasAudio else { throw ReliveError.message("片段裁切或静音失败。") }
        let trimPackage = try await LivePhotoWriter.write(video: trimmed, coverTime: 0, outputDirectory: directory, name: "test-trim-first")
        try await LivePhotoWriter.validate(package: trimPackage)
        print("PASS trim + mute + first cover")
        do {
            _ = try await LivePhotoWriter.write(video: trimmed, coverTime: 0, outputDirectory: directory, name: "test-trim-first")
            throw ReliveError.message("同名覆盖防护失败。")
        } catch is LivePhotoWriter.Failure { print("PASS duplicate refuses overwrite") }
        let bad = directory.appendingPathComponent("invalid.mp4")
        try Data("not a video".utf8).write(to: bad)
        do {
            _ = try await MediaEngine.probe(bad, token: token)
            throw ReliveError.message("损坏输入检查失败。")
        } catch { if error.localizedDescription == "损坏输入检查失败。" { throw error }; print("PASS invalid input rejected") }
        let cancelled = JobToken(); cancelled.cancel()
        do {
            _ = try await Tools.run("ffprobe", ["-version"], token: cancelled)
            throw ReliveError.message("取消检查失败。")
        } catch is CancellationError { print("PASS cancellation") }
        let running = JobToken()
        let cancellationTask = Task { try? await Task.sleep(nanoseconds: 150_000_000); running.cancel() }
        let started = Date()
        do {
            _ = try await Tools.run("ffmpeg", ["-v", "error", "-re", "-f", "lavfi", "-i", "color=c=red:size=64x64:rate=30", "-t", "20", "-f", "null", "-"], token: running)
            throw ReliveError.message("运行中取消失败。")
        } catch is CancellationError {
            guard Date().timeIntervalSince(started) < 3 else { throw ReliveError.message("运行中取消响应过慢。") }
            print("PASS running process cancellation")
        }
        cancellationTask.cancel()
        let forbidden = directory.appendingPathComponent("entities.svg")
        try "<!DOCTYPE svg [<!ENTITY a 'test'>]><svg xmlns='http://www.w3.org/2000/svg'/>".write(to: forbidden, atomically: true, encoding: .utf8)
        do {
            _ = try await SVGRenderer().render(source: forbidden, destination: directory.appendingPathComponent("forbidden.mp4"), duration: 1, background: "#FFFFFF", token: token, progress: { _ in })
            throw ReliveError.message("SVG 实体隔离失败。")
        } catch { if error.localizedDescription == "SVG 实体隔离失败。" { throw error }; print("PASS SVG entities rejected") }
        try await webPTests(directory: directory)
    }

    @MainActor private static func webPTests(directory: URL) async throws {
        let token = JobToken(), fm = FileManager.default
        let output = directory.appendingPathComponent("WebP 导出 中文"), temporary = directory.appendingPathComponent("WebP 临时 空格")
        try fm.createDirectory(at: temporary, withIntermediateDirectories: true)
        let fast = directory.appendingPathComponent("60 fps 中文.mov")
        _ = try await Tools.run("ffmpeg", ["-v", "error", "-y", "-f", "lavfi", "-i", "testsrc2=size=320x240:rate=60", "-t", "1.2", "-an", "-c:v", "libx264", "-pix_fmt", "yuv420p", fast.path], token: token)
        let info = try await MediaEngine.probe(fast, token: token)
        let reduced = try await WebPEncoder.write(source: fast, info: info, startFrame: 0, endFrame: info.frames,
            maxSide: 1080, outputDirectory: output, name: "60 fps", temporaryDirectory: temporary, token: token, progress: { _ in })
        guard reduced.info.frameCount <= 36, reduced.info.isAnimated, abs(reduced.info.duration - 1.2) <= 0.001,
              let decoder = CGImageSourceCreateWithURL(reduced.url as CFURL, nil), CGImageSourceGetCount(decoder) == reduced.info.frameCount else {
            throw ReliveError.message("60→30 fps 降帧或累计毫秒时长错误。")
        }
        print("PASS WebP 60→30 fps, ImageIO animation decode + cumulative milliseconds")
        for (label, rate, sourceFrames) in [("59.94 fps", "60000/1001", 60), ("60 fps odd tail", "60", 61)] {
            let source = directory.appendingPathComponent(label + ".mov")
            _ = try await Tools.run("ffmpeg", ["-v", "error", "-y", "-f", "lavfi", "-i", "testsrc2=size=96x64:rate=" + rate,
                "-frames:v", String(sourceFrames), "-an", "-c:v", "libx264", "-pix_fmt", "yuv420p", source.path], token: token)
            let sourceInfo = try await MediaEngine.probe(source, token: token)
            let result = try await WebPEncoder.write(source: source, info: sourceInfo, startFrame: 0, endFrame: sourceInfo.frames, maxSide: 1080,
                outputDirectory: output, name: label, temporaryDirectory: temporary, token: token, progress: { _ in })
            let parsed = WebPInfoParser()
            _ = try await Tools.run("webpinfo", ["-diag", "-summary", result.url.path], token: token, onLine: parsed.consume)
            let expectedDuration = Double(sourceInfo.frames) / sourceInfo.fps
            guard result.info.isAnimated, result.info.frameCount <= Int(floor(expectedDuration * 30 + 0.0000001)),
                  (parsed.minimumFrameDurationMilliseconds ?? 0) >= 30,
                  abs(result.info.duration - expectedDuration) <= 0.00051 else {
                throw ReliveError.message(label + " WebP 降帧产生过短尾帧或时长漂移。")
            }
        }
        print("PASS WebP 59.94 fps and odd 60 fps clip: no tiny tail frames, <=30 fps and unchanged duration")

        let colors = directory.appendingPathComponent("red then blue.mov")
        _ = try await Tools.run("ffmpeg", ["-v", "error", "-y", "-f", "lavfi", "-i", "color=red:size=80x60:rate=30:d=0.5", "-f", "lavfi", "-i", "color=blue:size=80x60:rate=30:d=0.5", "-filter_complex", "[0:v][1:v]concat=n=2:v=1:a=0[v]", "-map", "[v]", "-c:v", "libx264", "-pix_fmt", "yuv420p", colors.path], token: token)
        let colorInfo = try await MediaEngine.probe(colors, token: token)
        let full = try await WebPEncoder.write(source: colors, info: colorInfo, startFrame: 0, endFrame: 30, maxSide: 1080,
            outputDirectory: output, name: "原始顺序", temporaryDirectory: temporary, token: token, progress: { _ in })
        guard full.info.isAnimated, full.info.frameCount <= 2, full.info.duration == 1 else { throw ReliveError.message("重复帧合并后的 WebP 时长错误。") }
        try checkWebPColor(full.url, frame: 0, blue: false)
        try checkWebPColor(full.url, frame: full.info.frameCount - 1, blue: true)
        let original = try Data(contentsOf: full.url)
        let duplicate = try await WebPEncoder.write(source: colors, info: colorInfo, startFrame: 15, endFrame: 30, maxSide: 1080,
            outputDirectory: output, name: "原始顺序", temporaryDirectory: temporary, token: token, progress: { _ in })
        guard duplicate.url.lastPathComponent == "原始顺序 2.webp", try Data(contentsOf: full.url) == original,
              !duplicate.info.isAnimated, duplicate.info.frameCount == 1, duplicate.info.durationMilliseconds == 0 else {
            throw ReliveError.message("WebP 静态合并或重名保护错误。")
        }
        try checkWebPColor(duplicate.url, frame: 0, blue: true)
        let single = try await WebPEncoder.write(source: colors, info: colorInfo, startFrame: 15, endFrame: 16, maxSide: 1080,
            outputDirectory: output, name: "单帧", temporaryDirectory: temporary, token: token, progress: { _ in })
        guard !single.info.isAnimated, single.info.frameCount == 1, single.info.duration == 0 else { throw ReliveError.message("单帧 WebP 应为无动画时长的静态图片。") }
        try checkWebPColor(single.url, frame: 0, blue: true)
        print("PASS WebP original red→blue order, trim first frame, repeated/static + single frames, numbered duplicate")

        do {
            _ = try await WebPEncoder.write(source: colors, info: colorInfo, startFrame: 0, endFrame: 30, maxSide: 1080,
                outputDirectory: output, name: "no space", temporaryDirectory: temporary, token: token, availableBytes: 0, progress: { _ in })
            throw ReliveError.message("WebP 磁盘空间检查失败。")
        } catch {
            guard error.localizedDescription.contains("临时磁盘空间不足") else { throw error }
        }
        let blocked = directory.appendingPathComponent("不是文件夹")
        try Data([1]).write(to: blocked)
        do {
            _ = try await WebPEncoder.write(source: colors, info: colorInfo, startFrame: 0, endFrame: 1, maxSide: 1080,
                outputDirectory: blocked, name: "unwritable", temporaryDirectory: temporary, token: token, progress: { _ in })
            throw ReliveError.message("WebP 无效输出目录检查失败。")
        } catch { if error.localizedDescription == "WebP 无效输出目录检查失败。" { throw error } }
        let cancelled = JobToken()
        do {
            _ = try await WebPEncoder.write(source: fast, info: info, startFrame: 0, endFrame: info.frames, maxSide: 1080,
                outputDirectory: output, name: "cancelled", temporaryDirectory: temporary, token: cancelled, progress: { fraction in if fraction >= 0.55 { cancelled.cancel() } })
            throw ReliveError.message("WebP 运行中取消检查失败。")
        } catch is CancellationError { }
        guard try fm.contentsOfDirectory(atPath: temporary.path).isEmpty,
              !fm.fileExists(atPath: output.appendingPathComponent("cancelled.webp").path),
              !fm.fileExists(atPath: output.appendingPathComponent("no space.webp").path) else { throw ReliveError.message("WebP 失败或取消后残留临时文件。") }
        let parser = WebPInfoParser()
        ["Canvas size 320 x 240", "Animation: 1", "Loop count : 0"].forEach(parser.consume)
        for _ in 0..<70_000 { ["Width: 4", "Height: 2", "Animation: 0", "Duration: 33"].forEach(parser.consume) }
        ["Number of frames: 70000", "No error detected."].forEach(parser.consume)
        let parsed = try parser.result(byteCount: 123)
        guard parsed.width == 320, parsed.height == 240, parsed.durationMilliseconds == 2_310_000, parsed.isAnimated else { throw ReliveError.message("长动画流式信息解析错误。") }
        print("PASS WebP disk capacity, unwritable destination, running cancellation + cleanup, streaming canvas/duration parser")

        let model = ReliveModel()
        defer { model.cleanUp() }
        let item = MediaItem(id: UUID(), sourceURL: colors, previewURL: colors, name: "model WebP", kind: "MOV", width: colorInfo.width,
            height: colorInfo.height, duration: Double(colorInfo.frames) / colorInfo.fps, fps: colorInfo.fps, frames: colorInfo.frames, thumbnail: nil)
        model.items = [item]; model.select(item); model.coverFrame = 1
        model.trimStart = 0.5; model.trimEnd = 1; model.exportDirectory = output; model.exportFormat = .webP
        model.export()
        while model.busy { try await Task.sleep(nanoseconds: 20_000_000) }
        guard model.error == nil, model.lastWebP != nil, model.lastExport?.pathExtension == "webp" else {
            throw ReliveError.message("隐藏的封面帧仍影响 WebP 裁切：" + (model.error ?? "未知错误"))
        }
        model.exportFormat = .livePhoto
        guard model.lastExport == nil, model.lastWebP == nil else { throw ReliveError.message("切换格式没有清空旧导出结果。") }
        print("PASS WebP model ignores hidden cover; format switch clears result")
    }

    private static func checkWebPColor(_ url: URL, frame: Int, blue: Bool) throws {
        guard let source = CGImageSourceCreateWithURL(url as CFURL, nil), let image = CGImageSourceCreateImageAtIndex(source, frame, nil),
              let color = NSBitmapImageRep(cgImage: image).colorAt(x: image.width / 2, y: image.height / 2)?.usingColorSpace(.deviceRGB),
              blue ? (color.blueComponent > 0.8 && color.redComponent < 0.2) : (color.redComponent > 0.8 && color.blueComponent < 0.2) else {
            throw ReliveError.message("WebP 画面顺序或裁切首帧错误。")
        }
    }
}
