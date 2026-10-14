import Foundation
import AVFoundation
import AppKit

enum ReliveError: LocalizedError {
    case message(String)
    var errorDescription: String? { if case .message(let text) = self { return text }; return nil }
}

final class JobToken: @unchecked Sendable {
    private let lock = NSLock()
    private var process: Process?
    private var stopped = false
    var isCancelled: Bool { lock.lock(); defer { lock.unlock() }; return stopped }
    func attach(_ process: Process) throws {
        lock.lock(); defer { lock.unlock() }
        if stopped { throw CancellationError() }
        self.process = process
    }
    func detach() { lock.lock(); process = nil; lock.unlock() }
    func cancel() {
        lock.lock(); stopped = true; let current = process; lock.unlock()
        if let current, current.isRunning { current.terminate() }
    }
    func check() throws { if isCancelled { throw CancellationError() } }
}

enum Tools {
    static func url(_ name: String) throws -> URL {
        let bundled = Bundle.main.resourceURL?.appendingPathComponent("bin/" + name)
        let development = URL(fileURLWithPath: #filePath).deletingLastPathComponent().deletingLastPathComponent().appendingPathComponent("Resources/bin/" + name)
        for candidate in [bundled, development].compactMap({ $0 }) {
            if FileManager.default.isExecutableFile(atPath: candidate.path) { return candidate }
        }
        throw ReliveError.message("软件内的 \(name) 不完整，请重新安装 Relive。")
    }

    static func run(_ name: String, _ arguments: [String], token: JobToken, progress: ((Double) -> Void)? = nil, duration: Double = 0) async throws -> Data {
        let executable = try url(name)
        return try await withCheckedThrowingContinuation { continuation in
            DispatchQueue.global(qos: .userInitiated).async {
                let process = Process()
                process.executableURL = executable
                process.arguments = arguments
                let stdout = Pipe(), stderr = Pipe()
                process.standardOutput = stdout
                process.standardError = stderr
                process.standardInput = FileHandle.nullDevice
                do {
                    try token.attach(process)
                    try process.run()
                    if token.isCancelled {
                        if process.isRunning { process.terminate() }
                        process.waitUntilExit()
                        throw CancellationError()
                    }
                    // Drain both pipes concurrently so a decoder error cannot block a job.
                    let errorGroup = DispatchGroup()
                    let errorBox = DataBox()
                    errorGroup.enter()
                    DispatchQueue.global(qos: .utility).async {
                        while true {
                            let chunk = stderr.fileHandleForReading.availableData
                            if chunk.isEmpty { break }
                            errorBox.append(chunk, limit: 32_768)
                        }
                        errorGroup.leave()
                    }
                    var output = Data(), pending = ""
                    while true {
                        let chunk = stdout.fileHandleForReading.availableData
                        if chunk.isEmpty { break }
                        output.append(chunk)
                        if output.count > 4_194_304 { output.removeFirst(output.count - 4_194_304) }
                        if let progress, duration > 0 {
                            pending += String(decoding: chunk, as: UTF8.self)
                            while let newline = pending.firstIndex(of: "\n") {
                                let line = String(pending[..<newline])
                                pending.removeSubrange(...newline)
                                if line.hasPrefix("out_time_us="), let microseconds = Double(line.dropFirst(12)) {
                                    progress(min(1, max(0, microseconds / 1_000_000 / duration)))
                                }
                            }
                        }
                    }
                    process.waitUntilExit()
                    errorGroup.wait()
                    token.detach()
                    try token.check()
                    guard process.terminationStatus == 0 else {
                        let details = String(decoding: errorBox.value, as: UTF8.self).trimmingCharacters(in: .whitespacesAndNewlines)
                        throw ReliveError.message(details.isEmpty ? "媒体转换失败（\(process.terminationStatus)）。" : "媒体转换失败：\n" + String(details.suffix(2400)))
                    }
                    continuation.resume(returning: output)
                } catch {
                    token.detach()
                    continuation.resume(throwing: error)
                }
            }
        }
    }
}

private final class DataBox: @unchecked Sendable {
    private let lock = NSLock()
    private var data = Data()
    var value: Data { lock.lock(); defer { lock.unlock() }; return data }
    func append(_ chunk: Data, limit: Int) { lock.lock(); defer { lock.unlock() }; data.append(chunk); if data.count > limit { data.removeFirst(data.count - limit) } }
}

struct MediaInfo {
    let width: Int, height: Int
    let duration: Double, fps: Double
    let frames: Int
    let hasAudio: Bool
}

enum MediaEngine {
    static func probe(_ url: URL, token: JobToken) async throws -> MediaInfo {
        let data = try await Tools.run("ffprobe", ["-v", "error", "-show_streams", "-show_format", "-of", "json", url.path], token: token)
        guard let root = try JSONSerialization.jsonObject(with: data) as? [String: Any],
              let streams = root["streams"] as? [[String: Any]],
              let video = streams.first(where: { $0["codec_type"] as? String == "video" }),
              let width = video["width"] as? Int, let height = video["height"] as? Int,
              width > 0, height > 0, width <= 32768, height <= 32768 else {
            throw ReliveError.message("未找到可读取的画面，请确认文件是图片或视频。")
        }
        let format = root["format"] as? [String: Any] ?? [:]
        let seconds = max(Double(video["duration"] as? String ?? "") ?? 0, Double(format["duration"] as? String ?? "") ?? 0)
        let rate = (video["avg_frame_rate"] as? String ?? "0/0").split(separator: "/").compactMap { Double($0) }
        let fallback = (video["r_frame_rate"] as? String ?? "30/1").split(separator: "/").compactMap { Double($0) }
        let ratio = rate.count == 2 && rate[1] > 0 ? rate[0] / rate[1] : (fallback.count == 2 && fallback[1] > 0 ? fallback[0] / fallback[1] : 30)
        let fps = ratio.isFinite && ratio > 0 ? ratio : 30
        let safeSeconds = seconds.isFinite ? max(0, seconds) : 0
        let estimate = safeSeconds * fps
        guard estimate.isFinite, estimate < Double(Int.max) else { throw ReliveError.message("素材的时长或帧率信息不正确。") }
        let frames = Int(video["nb_frames"] as? String ?? "") ?? max(1, Int(estimate.rounded()))
        return MediaInfo(width: width, height: height, duration: safeSeconds, fps: fps, frames: max(1, frames), hasAudio: streams.contains { $0["codec_type"] as? String == "audio" })
    }

    static func normalize(source: URL, destination: URL, durationForImage: Double, background: String, token: JobToken, progress: @escaping (Double) -> Void) async throws -> MediaInfo {
        let info = try await probe(source, token: token)
        let still = ["png", "jpg", "jpeg", "heic", "heif", "bmp", "tif", "tiff", "webp"].contains(source.pathExtension.lowercased()) && info.duration <= 0
        let duration = still ? durationForImage : info.duration
        let fps = still || source.pathExtension.lowercased() == "gif" ? 30.0 : min(60, max(1, info.fps))
        var args = ["-v", "error", "-nostdin", "-nostats", "-progress", "pipe:1"]
        if still { args += ["-loop", "1"] }
        args += ["-i", source.path]
        let hex = background == "#000000" ? "0x000000" : "0xFFFFFF"
        let scale = "scale=w='max(2,min(1920,iw))':h='max(2,min(1920,ih))':force_original_aspect_ratio=decrease:force_divisible_by=2,setsar=1"
        let filter = "[0:v:0]\(scale),format=rgba,split=2[base][fg];[base]drawbox=x=0:y=0:w=iw:h=ih:color=\(hex):t=fill:replace=1[bg];[bg][fg]overlay=shortest=1:format=auto,format=yuv420p[v]"
        args += ["-filter_complex", filter, "-map", "[v]", "-map", "0:a?"]
        // Videos, including raw MPV with no duration, are decoded through EOF without trimming.
        if still { args += ["-t", String(duration)] }
        args += ["-r", String(fps), "-c:v", "libx264", "-preset", "fast", "-crf", "18", "-pix_fmt", "yuv420p", "-c:a", "aac", "-b:a", "192k", "-ar", "48000", "-movflags", "+faststart", destination.path]
        _ = try await Tools.run("ffmpeg", args, token: token, progress: progress, duration: duration)
        return try await probe(destination, token: token)
    }

    static func clip(source: URL, destination: URL, start: Double, duration: Double, maxSide: Int, keepAudio: Bool, fps: Double, token: JobToken, progress: @escaping (Double) -> Void) async throws {
        let side = maxSide == 1920 ? 1920 : 1080
        var args = ["-v", "error", "-nostdin", "-nostats", "-progress", "pipe:1", "-i", source.path, "-ss", String(start), "-t", String(duration), "-map", "0:v:0"]
        if keepAudio { args += ["-map", "0:a?"] } else { args += ["-an"] }
        args += ["-vf", "scale=w='max(2,min(\(side),iw))':h='max(2,min(\(side),ih))':force_original_aspect_ratio=decrease:force_divisible_by=2,setsar=1", "-r", String(fps), "-c:v", "libx264", "-preset", "fast", "-crf", "18", "-pix_fmt", "yuv420p", "-c:a", "aac", "-b:a", "192k", "-movflags", "+faststart", destination.path]
        _ = try await Tools.run("ffmpeg", args, token: token, progress: progress, duration: duration)
    }

    static func image(_ url: URL, at seconds: Double, size: CGSize = CGSize(width: 1920, height: 1920)) throws -> NSImage {
        let generator = AVAssetImageGenerator(asset: AVURLAsset(url: url))
        generator.appliesPreferredTrackTransform = true
        generator.maximumSize = size
        generator.requestedTimeToleranceBefore = .zero
        generator.requestedTimeToleranceAfter = .zero
        let cg = try generator.copyCGImage(at: CMTime(seconds: max(0, seconds), preferredTimescale: 60000), actualTime: nil)
        return NSImage(cgImage: cg, size: NSSize(width: cg.width, height: cg.height))
    }
}
