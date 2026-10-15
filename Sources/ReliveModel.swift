import AppKit
import AVFoundation
import Combine
import UniformTypeIdentifiers

struct MediaItem: Identifiable {
    let id: UUID
    let sourceURL: URL, previewURL: URL
    let name: String, kind: String
    let width: Int, height: Int
    let duration: Double, fps: Double
    let frames: Int
    let thumbnail: NSImage?
}

struct FrameThumbnail: Identifiable {
    let id: Int
    let time: Double
    let image: NSImage
}

enum ExportFormat: String, CaseIterable, Identifiable {
    case livePhoto, webP
    var id: Self { self }
    var title: String { self == .livePhoto ? "Live Photo" : "WebP 动图" }
    var icon: String { self == .livePhoto ? "livephoto" : "photo.on.rectangle.angled" }
}

@MainActor
final class ReliveModel: ObservableObject {
    static let shared = ReliveModel()
    @Published var items: [MediaItem] = []
    @Published var selectedID: UUID?
    @Published var player = AVPlayer()
    @Published var playhead = 0.0
    @Published var coverFrame = 1
    @Published var thumbnails: [FrameThumbnail] = []
    @Published var busy = false
    @Published var status = "导入素材，从第一帧开始。"
    @Published var progress = 0.0
    @Published var error: String?
    @Published var lastExport: URL?
    @Published var lastWebP: WebPInfo?
    @Published var exportFormat: ExportFormat = .livePhoto {
        didSet { if oldValue != exportFormat { lastExport = nil; lastWebP = nil; error = nil } }
    }
    @Published var exportDirectory = FileManager.default.homeDirectoryForCurrentUser.appendingPathComponent("Desktop/Relive 导出")
    @Published var maxSide = 1080
    @Published var keepAudio = true
    @Published var svgDuration = 3.0
    @Published var backgroundHex = "#FFFFFF"
    @Published var trimStart = 0.0
    @Published var trimEnd = 0.0
    @Published var isPlaying = false
    private var activeToken: JobToken?
    private var task: Task<Void, Never>?
    private var observer: Any?
    private var endObserver: NSObjectProtocol?
    private let workspace: URL
    private var thumbnailTask: Task<Void, Never>?

    var current: MediaItem? { items.first { $0.id == selectedID } }
    var frameCount: Int { current?.frames ?? 1 }
    var currentFrame: Int { guard let current else { return 1 }; return min(frameCount, max(1, Int((playhead * current.fps + 0.001).rounded(.down)) + 1)) }
    var coverTime: Double { guard let current else { return 0 }; return Double(coverFrame - 1) / current.fps }
    var clipDuration: Double { max(0, trimEnd - trimStart) }

    init() {
        workspace = FileManager.default.temporaryDirectory.appendingPathComponent("Relive-" + UUID().uuidString)
        try? FileManager.default.createDirectory(at: workspace, withIntermediateDirectories: true)
        observer = player.addPeriodicTimeObserver(forInterval: CMTime(seconds: 1.0 / 30, preferredTimescale: 60000), queue: .main) { [weak self] time in
            Task { @MainActor in
                guard let self, time.seconds.isFinite else { return }
                self.playhead = max(0, time.seconds)
                self.isPlaying = self.player.rate > 0
            }
        }
        endObserver = NotificationCenter.default.addObserver(forName: .AVPlayerItemDidPlayToEndTime, object: nil, queue: .main) { [weak self] note in
            Task { @MainActor in
                guard let self, let item = note.object as? AVPlayerItem, item === self.player.currentItem else { return }
                self.isPlaying = false
                self.seek(0)
            }
        }
        if let stored = UserDefaults.standard.string(forKey: "exportDirectory") { exportDirectory = URL(fileURLWithPath: stored) }
    }

    func chooseFiles() {
        guard !busy else { return }
        let panel = NSOpenPanel()
        panel.title = "为 Relive 导入素材"
        panel.message = "SVG、GIF、MOV、MP4、MPV、MKV、WebM 或图片"
        panel.allowsMultipleSelection = true
        panel.canChooseDirectories = false
        if panel.runModal() == .OK { importFiles(panel.urls) }
    }

    func importFiles(_ urls: [URL]) {
        guard !busy, !urls.isEmpty else { return }
        let allowed: Set<String> = ["svg", "gif", "mov", "mp4", "mpv", "m4v", "mkv", "webm", "avi", "mpg", "mpeg", "wmv", "apng", "png", "jpg", "jpeg", "heic", "heif", "webp", "bmp", "tif", "tiff"]
        let accepted = urls.filter { $0.isFileURL && allowed.contains($0.pathExtension.lowercased()) }
        guard !accepted.isEmpty else { error = "请选择 SVG、GIF 或视频素材。MPV 指 .mpv 视频文件，不是播放器工程。"; return }
        let ignored = urls.count - accepted.count
        begin("正在读取素材…")
        let token = JobToken(); activeToken = token
        let seconds = min(30, max(1, svgDuration))
        let background = backgroundHex
        task = Task {
            var imported: MediaItem?
            var failures: [String] = []
            for (index, source) in accepted.enumerated() {
                do {
                    try token.check()
                    status = "正在转换 \(source.lastPathComponent)（\(index + 1)/\(accepted.count)）"
                    let id = UUID()
                    let directory = workspace.appendingPathComponent(id.uuidString)
                    try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
                    let scoped = source.startAccessingSecurityScopedResource()
                    defer { if scoped { source.stopAccessingSecurityScopedResource() } }
                    let input = directory.appendingPathComponent("input." + source.pathExtension.lowercased())
                    // Read the user-selected file in the app; child tools only touch this private copy.
                    try FileManager.default.copyItem(at: source, to: input)
                    let preview = directory.appendingPathComponent("preview.mp4")
                    let update: (Double) -> Void = { [weak self] fraction in
                        Task { @MainActor in self?.progress = (Double(index) + fraction) / Double(accepted.count) }
                    }
                    let info: MediaInfo
                    if source.pathExtension.lowercased() == "svg" {
                        info = try await SVGRenderer().render(source: input, destination: preview, duration: seconds, background: background, token: token, progress: update)
                    } else {
                        info = try await MediaEngine.normalize(source: input, destination: preview, durationForImage: seconds, background: background, token: token, progress: update)
                    }
                    guard info.duration > 0 else { throw ReliveError.message("素材时长为零。") }
                    let thumbnail = try? MediaEngine.image(preview, at: 0, size: CGSize(width: 200, height: 200))
                    // Audio encoder padding is longer than the picture in some files; only real video frames are selectable.
                    let item = MediaItem(id: id, sourceURL: source, previewURL: preview, name: source.deletingPathExtension().lastPathComponent, kind: source.pathExtension.uppercased(), width: info.width, height: info.height, duration: Double(info.frames) / info.fps, fps: info.fps, frames: info.frames, thumbnail: thumbnail)
                    items.append(item); imported = item
                } catch {
                    if token.isCancelled { break }
                    failures.append(source.lastPathComponent + "：" + error.localizedDescription)
                }
            }
            finish()
            if let imported { select(imported) }
            if token.isCancelled { status = "已取消，已导入的素材仍可继续编辑。" }
            else if accepted.count == failures.count { status = "没有成功导入素材，请检查提示后重新选择。" }
            else { status = "已导入 \(accepted.count - failures.count) 个素材" + (ignored > 0 ? "，跳过 \(ignored) 个不支持的文件。" : (exportFormat == .livePhoto ? "，选择封面后即可导出。" : "，选择片段后即可导出 WebP。")) }
            if !failures.isEmpty { error = failures.joined(separator: "\n\n") }
        }
    }

    func select(_ item: MediaItem) {
        guard !busy, selectedID != item.id else { return }
        player.pause(); isPlaying = false
        lastExport = nil; lastWebP = nil
        selectedID = item.id; playhead = 0; coverFrame = 1
        trimStart = 0; trimEnd = item.duration
        player.replaceCurrentItem(with: AVPlayerItem(url: item.previewURL))
        thumbnails = []
        thumbnailTask?.cancel()
        thumbnailTask = Task {
            for index in 0..<10 {
                if Task.isCancelled || selectedID != item.id { return }
                let time = Double(index) / 9 * max(0, item.duration - 1 / item.fps)
                if let image = try? MediaEngine.image(item.previewURL, at: time, size: CGSize(width: 150, height: 100)) {
                    thumbnails.append(FrameThumbnail(id: index, time: time, image: image))
                }
                await Task.yield()
            }
        }
    }

    func seek(_ seconds: Double) {
        guard let item = current else { return }
        guard seconds.isFinite else { return }
        let index = min(frameCount - 1, max(0, Int((seconds * item.fps).rounded())))
        let time = Double(index) / item.fps
        playhead = time
        player.seek(to: CMTime(seconds: time, preferredTimescale: 60000), toleranceBefore: .zero, toleranceAfter: .zero)
    }
    func step(_ delta: Int) { player.pause(); isPlaying = false; guard let item = current else { return }; seek(Double(min(frameCount, max(1, currentFrame + delta)) - 1) / item.fps) }
    func togglePlayback() {
        guard current != nil, !busy else { return }
        if player.rate > 0 { player.pause(); isPlaying = false } else { player.play(); isPlaying = true }
    }
    func chooseCover() { guard exportFormat == .livePhoto else { return }; coverFrame = currentFrame; lastExport = nil; lastWebP = nil; status = "已将第 \(coverFrame) 帧设为封面。" }
    func setFirstCover() { setCoverFrame(1) }
    func setCoverFrame(_ frame: Int) { guard exportFormat == .livePhoto else { return }; coverFrame = min(frameCount, max(1, frame)); lastExport = nil; lastWebP = nil; seek(coverTime); status = "封面：第 \(coverFrame) 帧。" }
    func chooseOutputDirectory() {
        guard !busy else { return }
        let panel = NSOpenPanel(); panel.title = "选择 Relive 导出位置"; panel.canChooseDirectories = true; panel.canChooseFiles = false; panel.canCreateDirectories = true; panel.directoryURL = exportDirectory
        if panel.runModal() == .OK, let url = panel.url { exportDirectory = url; UserDefaults.standard.set(url.path, forKey: "exportDirectory") }
    }

    func export() {
        guard !busy, let item = current else { return }
        guard trimStart.isFinite, trimEnd.isFinite, trimStart >= 0, trimEnd <= item.duration + 0.01, clipDuration + 0.000001 >= 1 / item.fps else { error = "请设置有效的导出片段：开始时间小于结束时间，且位于素材范围内。"; return }
        if exportFormat == .livePhoto {
            guard coverTime + 0.0001 >= trimStart, coverTime < trimEnd else { error = "封面帧必须位于导出片段内。请重新选择封面，或调整片段范围。"; return }
        }
        let startFrame = Int((trimStart * item.fps).rounded())
        let start = Double(startFrame) / item.fps
        let end = min(item.duration, Double(Int((trimEnd * item.fps).rounded())) / item.fps)
        let duration = end - start
        let cover = max(0, coverTime - start)
        guard Int((end * item.fps).rounded()) > startFrame, exportFormat == .webP || cover < duration else { error = "导出范围不足一帧，请扩大片段。"; return }
        let format = exportFormat
        let output = exportDirectory, side = maxSide, audio = keepAudio
        let directory = workspace.appendingPathComponent("export-" + UUID().uuidString)
        let token = JobToken(); activeToken = token
        player.pause(); isPlaying = false
        begin("正在制作 \(format.title)…")
        task = Task {
            defer { try? FileManager.default.removeItem(at: directory) }
            do {
                try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
                try FileManager.default.createDirectory(at: output, withIntermediateDirectories: true)
                if format == .webP {
                    let mediaInfo = MediaInfo(width: item.width, height: item.height, duration: item.duration, fps: item.fps, frames: item.frames, hasAudio: audio)
                    let result = try await WebPEncoder.write(source: item.previewURL, info: mediaInfo, startFrame: startFrame,
                        endFrame: Int((end * item.fps).rounded()), maxSide: side, outputDirectory: output, name: item.name,
                        temporaryDirectory: directory, token: token) { [weak self] fraction in
                            Task { @MainActor in self?.progress = fraction }
                        }
                    lastExport = result.url; lastWebP = result.info
                    finish(); progress = 1
                    status = result.info.isAnimated ? "WebP 动图已导出 · 保留片段原始顺序 · 无限循环" : "静态 WebP 已导出 · 片段画面相同或仅有一帧"
                    return
                }
                let normalized = directory.appendingPathComponent("clip.mp4")
                try await MediaEngine.clip(source: item.previewURL, destination: normalized, start: start, duration: duration, maxSide: side, keepAudio: audio, fps: item.fps, token: token) { [weak self] fraction in
                    Task { @MainActor in self?.progress = fraction * 0.72 }
                }
                try token.check()
                status = "正在写入封面和实况时间标记…"; progress = 0.78
                let package = try await LivePhotoWriter.write(video: normalized, coverTime: cover, outputDirectory: directory, name: "LivePhoto")
                try token.check()
                status = "正在校验 Apple Live Photo…"; progress = 0.94
                try await LivePhotoWriter.validate(package: package)
                try token.check()
                let name = safeName(item.name)
                var destination = output.appendingPathComponent(name + ".pvt")
                var number = 2
                while FileManager.default.fileExists(atPath: destination.path) { destination = output.appendingPathComponent(name + " \(number).pvt"); number += 1 }
                let staging = output.appendingPathComponent(".Relive-" + UUID().uuidString + ".pvt")
                do {
                    try FileManager.default.copyItem(at: package, to: staging)
                    try token.check()
                    try FileManager.default.moveItem(at: staging, to: destination)
                } catch { try? FileManager.default.removeItem(at: staging); throw error }
                lastExport = destination
                finish(); progress = 1
                status = "Live Photo 已导出 · 第 \(coverFrame) 帧封面 · 已通过系统识别"
            } catch {
                finish()
                if token.isCancelled || error is CancellationError { status = "已取消导出，素材仍可继续编辑。" }
                else { self.error = error.localizedDescription; status = "导出未完成，请检查提示。" }
            }
        }
    }

    func revealOutput() { if let lastExport { NSWorkspace.shared.activateFileViewerSelecting([lastExport]) } else { NSWorkspace.shared.open(exportDirectory) } }
    func openPhotos() { if exportFormat == .livePhoto, let lastExport { NSWorkspace.shared.open(lastExport) } }
    func clearError() { error = nil }
    func cancel() { activeToken?.cancel(); task?.cancel(); status = "正在取消…" }
    func cleanUp() { activeToken?.cancel(); task?.cancel(); thumbnailTask?.cancel(); player.pause(); try? FileManager.default.removeItem(at: workspace) }
    private func begin(_ message: String) { busy = true; progress = 0; error = nil; lastExport = nil; lastWebP = nil; status = message }
    private func finish() { busy = false; activeToken = nil; task = nil }
    private func safeName(_ name: String) -> String {
        let invalid = CharacterSet(charactersIn: "/:\0\n\r")
        let result = name.components(separatedBy: invalid).joined(separator: "_").trimmingCharacters(in: .whitespacesAndNewlines)
        return String((result.isEmpty ? "Relive" : result).prefix(100))
    }
}
