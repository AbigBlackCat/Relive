import Foundation
import Darwin

enum ExportQuality: String, CaseIterable, Identifiable {
    case original, high, standard, small
    var id: Self { self }
    var title: String { switch self { case .original: return "原画质"; case .high: return "高清"; case .standard: return "标准"; case .small: return "省空间" } }
    var maxSide: Int { switch self { case .original: return 0; case .high: return 1920; case .standard: return 1080; case .small: return 720 } }
    var h264: String { switch self { case .original: return "12"; case .high: return "16"; case .standard: return "20"; case .small: return "28" } }
    var vp9: String { switch self { case .original: return "0"; case .high: return "20"; case .standard: return "28"; case .small: return "36" } }
    var audioRate: String { switch self { case .original: return "320k"; case .high: return "256k"; case .standard: return "192k"; case .small: return "96k" } }
    var webP: String { switch self { case .original: return "-lossless -q 90"; case .high: return "-lossy -q 92"; case .standard: return "-lossy -q 80"; case .small: return "-lossy -q 60" } }
}

struct CropRegion: Equatable {
    let x: Double, y: Double, width: Double, height: Double
    static let full = Self(x: 0, y: 0, width: 1, height: 1)

    // FFmpeg applies source rotation before filtering. Round in the upright image.
    var ffmpeg: String {
        guard self != .full else { return "" }
        return "crop=w='max(2,trunc(iw*\(width)/2)*2)':h='max(2,trunc(ih*\(height)/2)*2)':x='trunc(iw*\(x)/2)*2':y='trunc(ih*\(y)/2)*2':exact=1,"
    }

    func size(width inputWidth: Int, height inputHeight: Int) -> (Int, Int) {
        if self == .full { return (inputWidth, inputHeight) }
        return (max(2, Int(Double(inputWidth) * width / 2) * 2), max(2, Int(Double(inputHeight) * height / 2) * 2))
    }
}

struct MediaExportInfo {
    let width: Int?, height: Int?
    let duration: Double
    let byteCount: Int64
    let hasAudio: Bool
}

extension MediaEngine {
    static func scaleFilter(_ side: Int) -> String {
        if side == 0 { return "scale=w='max(2,trunc(iw/2)*2)':h='max(2,trunc(ih/2)*2)',setsar=1" }
        return "scale=w='max(2,min(\(side),iw))':h='max(2,min(\(side),ih))':force_original_aspect_ratio=decrease:force_divisible_by=2,setsar=1"
    }

    static func writeMedia(source: URL, destination: URL, format: ExportFormat, quality: ExportQuality,
                           start: Double, duration: Double, crop: CropRegion, keepAudio: Bool, fps: Double,
                           token: JobToken, progress: @escaping (Double) -> Void) async throws -> MediaExportInfo {
        if format.isAudioOnly, try await !probe(source, token: token).hasAudio {
            throw ReliveError.message("这段素材没有可提取的音轨。")
        }
        let input = ["-v", "error", "-nostdin", "-nostats", "-progress", "pipe:1", "-i", source.path]
        var args = input + ["-ss", String(start), "-t", String(duration)]
        let filter = crop.ffmpeg + scaleFilter(quality.maxSide)
        if format.isAudioOnly {
            args += ["-map", "0:a:0", "-vn"]
            if format == .mp3 { args += ["-c:a", "libmp3lame", "-b:a", quality.audioRate] }
            else {
                args += ["-c:a", quality == .original || quality == .high ? "pcm_s24le" : "pcm_s16le"]
                if quality == .small { args += ["-ar", "32000"] }
            }
        } else if format == .gif {
            let colors = quality == .small ? "128" : "256"
            // Trim inside the graph: palette generation must only sample the selected clip.
            let graph = "[0:v:0]trim=start=\(start):duration=\(duration),setpts=PTS-STARTPTS,\(filter),fps=\(min(30, fps)):round=up,split[a][b];[a]palettegen=max_colors=\(colors)[p];[b][p]paletteuse[v]"
            args = input + ["-filter_complex", graph, "-map", "[v]", "-an", "-loop", "0"]
        } else {
            args += ["-map", "0:v:0", "-vf", filter]
            args += keepAudio ? ["-map", "0:a:0?"] : ["-an"]
            if format == .webm {
                args += ["-c:v", "libvpx-vp9", "-b:v", "0", "-crf", quality.vp9, "-pix_fmt", "yuv420p"]
                if quality == .original { args += ["-lossless", "1"] }
                if keepAudio { args += ["-c:a", "libopus", "-b:a", quality == .small ? "80k" : "160k"] }
            } else if format == .mkv && quality == .original {
                args += ["-c:v", "ffv1"]
                if keepAudio { args += ["-c:a", "flac"] }
            } else {
                args += ["-c:v", "libx264", "-preset", "fast", "-crf", quality.h264, "-pix_fmt", "yuv420p"]
                if keepAudio { args += ["-c:a", "aac", "-b:a", quality.audioRate] }
                if format == .mp4 || format == .mov { args += ["-movflags", "+faststart"] }
            }
        }
        _ = try await Tools.run("ffmpeg", args + [destination.path], token: token, progress: progress, duration: duration)
        let probe = try await Tools.run("ffprobe", ["-v", "error", "-show_streams", "-show_format", "-of", "json", destination.path], token: token)
        let root = try JSONSerialization.jsonObject(with: probe) as? [String: Any] ?? [:]
        let streams = root["streams"] as? [[String: Any]] ?? []
        let video = streams.first { $0["codec_type"] as? String == "video" }
        let hasAudio = streams.contains { $0["codec_type"] as? String == "audio" }
        let length = Double((root["format"] as? [String: Any])?["duration"] as? String ?? "") ?? 0
        let bytes = (try FileManager.default.attributesOfItem(atPath: destination.path)[.size] as? NSNumber)?.int64Value ?? 0
        guard bytes > 0, length.isFinite, length > 0, format.isAudioOnly ? hasAudio : video != nil else {
            throw ReliveError.message("没有生成可播放的\(format.title)文件，请检查导出片段。")
        }
        return MediaExportInfo(width: video?["width"] as? Int, height: video?["height"] as? Int, duration: length, byteCount: bytes, hasAudio: hasAudio)
    }

    static func saveExport(_ source: URL, output: URL, name: String, token: JobToken) throws -> URL {
        let ext = source.pathExtension
        let staging = output.appendingPathComponent(".Relive-" + UUID().uuidString + "." + ext)
        defer { try? FileManager.default.removeItem(at: staging) }
        try FileManager.default.copyItem(at: source, to: staging)
        var number = 1
        while true {
            try token.check()
            let destination = output.appendingPathComponent(name + (number == 1 ? "" : " \(number)") + "." + ext)
            if renamex_np(staging.path, destination.path, UInt32(RENAME_EXCL)) == 0 { return destination }
            guard errno == EEXIST else { throw ReliveError.message("无法保存导出文件，请检查文件夹权限和磁盘空间。") }
            number += 1
        }
    }
}
