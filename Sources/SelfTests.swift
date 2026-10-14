import AppKit
import AVFoundation
import Foundation

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
    }
}
