import Foundation
import Darwin

struct WebPInfo {
    let width: Int, height: Int, frameCount: Int
    let durationMilliseconds: Int
    let loopCount: Int?
    let isAnimated: Bool
    let byteCount: Int64

    var duration: Double { Double(durationMilliseconds) / 1000 }
}

struct WebPExport {
    let url: URL
    let info: WebPInfo
}

enum WebPEncoder {
    // Input frame bounds are zero based, with an exclusive end, like FFmpeg's trim filter.
    static func write(source: URL, info: MediaInfo, startFrame: Int, endFrame: Int, maxSide: Int,
                      outputDirectory: URL, name: String, temporaryDirectory: URL,
                      token: JobToken, availableBytes: Int64? = nil,
                      progress: @escaping (Double) -> Void) async throws -> WebPExport {
        try token.check()
        guard info.fps.isFinite, info.fps > 0, startFrame >= 0, endFrame > startFrame, endFrame <= info.frames else {
            throw ReliveError.message("请设置有效的 WebP 导出片段。")
        }
        let fm = FileManager.default
        let job = temporaryDirectory.appendingPathComponent("webp-" + UUID().uuidString)
        try fm.createDirectory(at: job, withIntermediateDirectories: true)
        defer { try? fm.removeItem(at: job) }
        let duration = Double(endFrame - startFrame) / info.fps
        let fps = min(30, info.fps)
        let frameEstimate = max(1, floor(duration * fps + 0.0000001))
        guard frameEstimate.isFinite, frameEstimate < Double(Int.max), duration * 1000 < Double(Int.max) else {
            throw ReliveError.message("素材的时长或帧率信息不正确。")
        }
        let frameCount = Int(frameEstimate)
        let side = maxSide == 1920 ? 1920 : 1080
        let scale = min(1, Double(side) / Double(max(info.width, info.height)))
        let width = max(2, Int(ceil(Double(info.width) * scale)))
        let height = max(2, Int(ceil(Double(info.height) * scale)))
        // PPM is uncompressed RGB. Include headers, a possible encoded copy, and 256 MiB headroom.
        let required = Double(frameCount) * Double(width) * Double(height) * 3 * 1.15 + 268_435_456
        let free = try availableBytes ?? freeBytes(at: job)
        guard required.isFinite, required <= Double(free) else {
            let neededBytes = required < Double(Int64.max) ? Int64(max(0, required)) : Int64.max
            let needed = ByteCountFormatter.string(fromByteCount: neededBytes, countStyle: .file)
            throw ReliveError.message("临时磁盘空间不足。此片段约需 \(needed) 可用空间，请缩短片段、选择 1080 像素或清理磁盘后重试。")
        }
        try token.check()
        // Distribute pictures over the whole clip instead of appending a tiny tail frame.
        // selected_n counts already selected pictures, so the first picture is always n=0.
        let ratio = String(format: "%.12f", locale: Locale(identifier: "en_US_POSIX"), Double(endFrame - startFrame) / Double(frameCount))
        let filter = "trim=start_frame=\(startFrame):end_frame=\(endFrame),setpts=PTS-STARTPTS,select='eq(n,floor(selected_n*\(ratio)+0.0000001))',scale=w='max(2,min(\(side),iw))':h='max(2,min(\(side),ih))':force_original_aspect_ratio=decrease:force_divisible_by=2,setsar=1"
        _ = try await Tools.run("ffmpeg", ["-v", "error", "-nostdin", "-nostats", "-progress", "pipe:1", "-i", source.path,
            "-map", "0:v:0", "-an", "-vf", filter, "-vsync", "0", "-frames:v", String(frameCount),
            "-c:v", "ppm", "-pix_fmt", "rgb24", "-start_number", "0", "frame-%08d.ppm"], token: token,
            progress: { progress($0 * 0.55) }, duration: duration, directory: job)
        let frames = try fm.contentsOfDirectory(atPath: job.path).filter { $0.hasPrefix("frame-") && $0.hasSuffix(".ppm") }.sorted()
        guard frames.count == frameCount else { throw ReliveError.message("素材的实际帧数与片段不符，请重新导入素材。") }
        try token.check()
        var arguments = "-loop 0 -lossy -q 80 -m 4\n"
        var previous = 0
        for (index, frame) in frames.enumerated() {
            let boundary = Double(index + 1) * duration / Double(frameCount)
            let milliseconds = Int((boundary * 1000).rounded())
            arguments += "-d \(max(1, milliseconds - previous)) \(frame)\n"
            previous = milliseconds
        }
        arguments += "-o output.webp\n"
        // img2webp tokenizes this relative ASCII argument file itself, avoiding argv limits and
        // its Windows narrow-string path handling. FFmpeg alone sees the original user path.
        try arguments.write(to: job.appendingPathComponent("arguments.txt"), atomically: true, encoding: .utf8)
        progress(0.58)
        _ = try await Tools.run("img2webp", ["arguments.txt"], token: token, directory: job)
        try token.check()
        progress(0.88)
        let encoded = job.appendingPathComponent("output.webp")
        let checked = try await validate(encoded, token: token)
        if checked.isAnimated {
            guard checked.loopCount == 0, abs(checked.durationMilliseconds - Int((duration * 1000).rounded())) <= 1 else {
                throw ReliveError.message("WebP 动画时长或循环校验失败，请重新导出。")
            }
        }
        try token.check()
        try fm.createDirectory(at: outputDirectory, withIntermediateDirectories: true)
        let staging = outputDirectory.appendingPathComponent(".Relive-" + UUID().uuidString + ".webp")
        defer { try? fm.removeItem(at: staging) }
        try fm.copyItem(at: encoded, to: staging)
        try token.check()
        let base = safeName(name)
        var number = 1
        while true {
            try token.check()
            let suffix = number == 1 ? "" : " \(number)"
            let destination = outputDirectory.appendingPathComponent(base + suffix + ".webp")
            // Both files live on the destination volume. RENAME_EXCL claims the name atomically.
            if renamex_np(staging.path, destination.path, UInt32(RENAME_EXCL)) == 0 {
                progress(1)
                return WebPExport(url: destination, info: checked)
            }
            if errno == EEXIST { number += 1; continue }
            throw NSError(domain: NSPOSIXErrorDomain, code: Int(errno), userInfo: [NSLocalizedDescriptionKey: "无法保存 WebP，请确认导出文件夹可写。"])
        }
    }

    static func validate(_ url: URL, token: JobToken) async throws -> WebPInfo {
        let parser = WebPInfoParser()
        _ = try await Tools.run("webpinfo", ["-diag", "-summary", url.path], token: token, onLine: parser.consume)
        let attributes = try FileManager.default.attributesOfItem(atPath: url.path)
        return try parser.result(byteCount: (attributes[.size] as? NSNumber)?.int64Value ?? 0)
    }

    private static func freeBytes(at url: URL) throws -> Int64 {
        if let value = try? url.resourceValues(forKeys: [.volumeAvailableCapacityForImportantUsageKey]).volumeAvailableCapacityForImportantUsage { return value }
        let values = try FileManager.default.attributesOfFileSystem(forPath: url.path)
        guard let value = values[.systemFreeSize] as? NSNumber else { throw ReliveError.message("无法读取临时磁盘可用空间，请检查磁盘状态后重试。") }
        return value.int64Value
    }

    private static func safeName(_ name: String) -> String {
        let cleaned = name.components(separatedBy: CharacterSet(charactersIn: "/:\0\n\r")).joined(separator: "_").trimmingCharacters(in: .whitespacesAndNewlines)
        return String((cleaned.isEmpty ? "Relive" : cleaned).prefix(100))
    }
}

// This consumes every line while the process runs; long animations cannot lose their first
// frames when Tools' bounded diagnostic buffer rolls over. Subframe sizes never replace canvas.
final class WebPInfoParser {
    private var width = 0, height = 0, canvasWidth = 0, canvasHeight = 0
    private var frames = 0, duration = 0, durationCount = 0, loop: Int?
    private var animated = false, clean = false
    private(set) var minimumFrameDurationMilliseconds: Int?

    func consume(_ raw: String) {
        let line = raw.trimmingCharacters(in: .whitespacesAndNewlines)
        if line.hasPrefix("Canvas size ") {
            let values = line.dropFirst(12).split(separator: " ")
            if values.count == 3 { canvasWidth = Int(values[0]) ?? 0; canvasHeight = Int(values[2]) ?? 0 }
        } else if line.hasPrefix("Width:") { if width == 0 { width = integer(line) ?? 0 } }
        else if line.hasPrefix("Height:") { if height == 0 { height = integer(line) ?? 0 } }
        else if line.hasPrefix("Loop count") { loop = integer(line) }
        else if line.hasPrefix("Number of frames:") { frames = integer(line) ?? 0 }
        else if line.hasPrefix("Animation:"), integer(line) == 1 { animated = true }
        else if line.hasPrefix("Duration:"), let value = integer(line), value >= 0 {
            let addition = duration.addingReportingOverflow(value)
            if !addition.overflow {
                duration = addition.partialValue; durationCount += 1
                minimumFrameDurationMilliseconds = min(minimumFrameDurationMilliseconds ?? value, value)
            }
        } else if line == "No error detected." { clean = true }
    }

    func result(byteCount: Int64) throws -> WebPInfo {
        let w = canvasWidth > 0 ? canvasWidth : width, h = canvasHeight > 0 ? canvasHeight : height
        guard clean, w > 0, h > 0, frames > 0, byteCount > 0,
              !animated || (loop != nil && durationCount == frames && duration > 0) else {
            throw ReliveError.message("WebP 文件校验失败，未得到完整的画面或动画信息。")
        }
        return WebPInfo(width: w, height: h, frameCount: frames, durationMilliseconds: animated ? duration : 0,
                        loopCount: animated ? loop : nil, isAnimated: animated, byteCount: byteCount)
    }

    private func integer(_ line: String) -> Int? {
        guard let colon = line.firstIndex(of: ":") else { return nil }
        return Int(line[line.index(after: colon)...].trimmingCharacters(in: .whitespaces))
    }
}
