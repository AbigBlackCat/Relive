import SwiftUI
import AppKit
import AVKit
import UniformTypeIdentifiers

private enum RelivePalette {
    static let background = Color(red: 8 / 255, green: 9 / 255, blue: 11 / 255)
    static let panel = Color(red: 18 / 255, green: 20 / 255, blue: 22 / 255)
    static let elevated = Color(red: 29 / 255, green: 32 / 255, blue: 35 / 255)
    static let accent = Color(red: 52 / 255, green: 178 / 255, blue: 123 / 255)
    static let text = Color(red: 238 / 255, green: 241 / 255, blue: 240 / 255)
    static let secondary = Color(red: 163 / 255, green: 172 / 255, blue: 168 / 255)
    static let line = Color.white.opacity(0.08)
}

@MainActor
struct MainView: View {
    @ObservedObject var model: ReliveModel
    @State private var dropTargeted = false
    @State private var frameInput = "1"
    @State private var frameInputError: String?
    @State private var showSVGOptions = false
    @State private var showPublishingHelp = false

    init(model: ReliveModel) {
        self.model = model
    }

    var body: some View {
        VStack(spacing: 0) {
            toolbar
            HStack(alignment: .top, spacing: 12) {
                mediaSidebar.frame(width: 200)
                editor.frame(maxWidth: .infinity, maxHeight: .infinity)
                inspector.frame(width: 290)
            }
            .padding(.horizontal, 14)
            .padding(.bottom, 12)
            .frame(maxWidth: .infinity, maxHeight: .infinity)
            if let error = model.error {
                errorBanner(error)
            }
            statusBar
        }
        .frame(minWidth: 1100, minHeight: 720)
        .background(RelivePalette.background)
        .foregroundColor(RelivePalette.text)
        .font(.system(size: 13))
        .tint(RelivePalette.accent)
        .preferredColorScheme(.dark)
        .onDrop(of: [UTType.fileURL.identifier], isTargeted: $dropTargeted, perform: acceptDrop)
        .overlay {
            if dropTargeted && !model.busy {
                RoundedRectangle(cornerRadius: 14)
                    .strokeBorder(RelivePalette.accent, style: StrokeStyle(lineWidth: 2, dash: [8, 5]))
                    .padding(6)
                    .allowsHitTesting(false)
            }
        }
        .onChange(of: model.coverFrame) { value in
            frameInput = String(value)
            frameInputError = nil
        }
        .onChange(of: model.selectedID) { _ in
            frameInput = String(model.coverFrame)
            frameInputError = nil
        }
        .onAppear { frameInput = String(model.coverFrame) }
    }

    private var toolbar: some View {
        HStack(spacing: 10) {
            Image(systemName: "livephoto")
                .font(.system(size: 25, weight: .medium))
                .foregroundColor(RelivePalette.accent)
                .accessibilityHidden(true)
            Text("Relive")
                .font(.system(size: 21, weight: .semibold))
            Rectangle().fill(RelivePalette.line).frame(width: 1, height: 20).padding(.horizontal, 6)
            Text("把喜欢的瞬间，变成 Live Photo")
                .font(.system(size: 12))
                .foregroundColor(RelivePalette.secondary)
            Spacer()
            Text("本地处理")
                .font(.system(size: 11))
                .foregroundColor(RelivePalette.secondary)
            Button(action: model.chooseFiles) {
                Label("导入素材", systemImage: "plus")
            }
            .buttonStyle(ReliveButtonStyle())
            .keyboardShortcut("o", modifiers: .command)
            .disabled(model.busy)
        }
        .padding(.horizontal, 20)
        .frame(height: 62)
    }

    private var mediaSidebar: some View {
        VStack(alignment: .leading, spacing: 0) {
            HStack {
                Text("素材").font(.system(size: 13, weight: .semibold))
                Spacer()
                Text("\(model.items.count)")
                    .font(.system(size: 11, design: .monospaced))
                    .foregroundColor(RelivePalette.secondary)
            }
            .padding(16)
            Divider().overlay(RelivePalette.line)
            if model.items.isEmpty {
                VStack(alignment: .leading, spacing: 10) {
                    Image(systemName: "square.and.arrow.down")
                        .font(.system(size: 23, weight: .light))
                        .foregroundColor(RelivePalette.secondary)
                    Text("从一个素材开始")
                        .font(.system(size: 13, weight: .medium))
                    Text("拖入文件，或点击上方\n「导入素材」。")
                        .font(.system(size: 12))
                        .foregroundColor(RelivePalette.secondary)
                        .lineSpacing(3)
                }
                .padding(18)
                .frame(maxWidth: .infinity, alignment: .leading)
                Spacer(minLength: 20)
            } else {
                ScrollView {
                    LazyVStack(spacing: 6) {
                        ForEach(model.items) { item in
                            mediaRow(item)
                        }
                    }
                    .padding(8)
                }
            }
            Divider().overlay(RelivePalette.line)
            VStack(alignment: .leading, spacing: 12) {
                Text("视频 · GIF · SVG")
                    .font(.system(size: 11, weight: .medium))
                    .foregroundColor(RelivePalette.secondary)
                DisclosureGroup("SVG 导入设置", isExpanded: $showSVGOptions) {
                    VStack(alignment: .leading, spacing: 10) {
                        HStack {
                            Text("录制时长")
                            Spacer()
                            Text("\(Int(model.svgDuration)) 秒")
                                .monospacedDigit()
                        }
                        Stepper("SVG 录制时长", value: $model.svgDuration, in: 1...30, step: 1)
                            .labelsHidden()
                            .accessibilityLabel("SVG 录制时长")
                        Picker("背景", selection: $model.backgroundHex) {
                            Text("白色").tag("#FFFFFF")
                            Text("黑色").tag("#000000")
                        }
                        .pickerStyle(.segmented)
                        Text("导入前设置。录制 SMIL / CSS 动画；静态 SVG 保持静态。外链与脚本不运行。")
                            .font(.system(size: 11))
                            .foregroundColor(RelivePalette.secondary)
                            .fixedSize(horizontal: false, vertical: true)
                            .lineSpacing(3)
                    }
                    .padding(.top, 10)
                }
                .font(.system(size: 12))
                .disabled(model.busy)
            }
            .padding(16)
        }
        .background(RelivePalette.panel)
        .clipShape(RoundedRectangle(cornerRadius: 12))
        .frame(maxHeight: .infinity)
    }

    private func mediaRow(_ item: MediaItem) -> some View {
        let selected = model.selectedID == item.id
        return Button {
            model.select(item)
        } label: {
            VStack(alignment: .leading, spacing: 9) {
                ZStack {
                    RoundedRectangle(cornerRadius: 6).fill(RelivePalette.background)
                    if let thumbnail = item.thumbnail {
                        Image(nsImage: thumbnail)
                            .resizable()
                            .scaledToFit()
                    } else {
                        Image(systemName: "film")
                            .font(.system(size: 23, weight: .light))
                            .foregroundColor(RelivePalette.secondary)
                    }
                    VStack {
                        Spacer()
                        HStack {
                            Spacer()
                            Text(timecode(item.duration))
                                .font(.system(size: 10, design: .monospaced))
                                .padding(.horizontal, 5)
                                .padding(.vertical, 3)
                                .background(Color.black.opacity(0.75), in: RoundedRectangle(cornerRadius: 4))
                        }
                        .padding(5)
                    }
                }
                .frame(height: 88)
                .clipShape(RoundedRectangle(cornerRadius: 6))
                Text(item.name)
                    .font(.system(size: 12, weight: .medium))
                    .lineLimit(1)
                    .truncationMode(.middle)
                HStack(spacing: 5) {
                    Text(item.kind.uppercased())
                    Text("·")
                    Text("\(item.width) × \(item.height)")
                }
                .font(.system(size: 10))
                .foregroundColor(RelivePalette.secondary)
            }
            .padding(10)
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(selected ? RelivePalette.elevated : Color.clear)
            .overlay(alignment: .topTrailing) {
                if selected {
                    Image(systemName: "checkmark.circle.fill")
                        .foregroundColor(RelivePalette.accent)
                        .padding(15)
                }
            }
            .clipShape(RoundedRectangle(cornerRadius: 9))
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .disabled(model.busy)
        .help(item.sourceURL.path)
        .accessibilityLabel("\(item.name)，\(item.kind)，时长 \(timecode(item.duration))")
        .accessibilityAddTraits(selected ? [.isSelected] : [])
    }

    private var editor: some View {
        VStack(spacing: 12) {
            VStack(spacing: 0) {
                HStack(spacing: 8) {
                    Text("预览").font(.system(size: 13, weight: .semibold))
                    if let item = model.current {
                        Text(item.name)
                            .font(.system(size: 11))
                            .foregroundColor(RelivePalette.secondary)
                            .lineLimit(1)
                            .truncationMode(.middle)
                    }
                    Spacer(minLength: 8)
                    Image(systemName: "rectangle.dashed")
                        .foregroundColor(RelivePalette.secondary)
                        .accessibilityHidden(true)
                    Text("保持原比例")
                        .font(.system(size: 10))
                        .foregroundColor(RelivePalette.secondary)
                }
                .padding(.horizontal, 16)
                .frame(height: 44)
                ZStack {
                    RelivePalette.background
                    if model.current != nil {
                        RelivePlayerView(player: model.player)
                            .padding(10)
                            .accessibilityLabel("素材视频预览")
                    } else {
                        emptyPreview
                    }
                }
                .frame(maxWidth: .infinity, maxHeight: .infinity)
                playbackControls
            }
            .background(RelivePalette.panel)
            .clipShape(RoundedRectangle(cornerRadius: 12))
            .frame(maxWidth: .infinity, maxHeight: .infinity)
            timeline
        }
    }

    private var emptyPreview: some View {
        VStack(spacing: 16) {
            Image(systemName: "livephoto")
                .font(.system(size: 54, weight: .ultraLight))
                .foregroundColor(RelivePalette.accent)
                .accessibilityHidden(true)
            Text("让瞬间再次发生")
                .font(.system(size: 23, weight: .medium))
            Text("导入素材，找到喜欢的一帧，导出 Live Photo。")
                .font(.system(size: 12))
                .foregroundColor(RelivePalette.secondary)
            Button(action: model.chooseFiles) {
                Label("选择素材", systemImage: "folder")
                    .padding(.horizontal, 10)
            }
            .buttonStyle(ReliveButtonStyle(primary: true))
            .disabled(model.busy)
        }
        .padding(28)
    }

    private var playbackControls: some View {
        HStack(spacing: 8) {
            iconButton("backward.frame", label: "上一帧") { model.step(-1) }
            iconButton(model.isPlaying ? "pause.fill" : "play.fill", label: model.isPlaying ? "暂停" : "播放") {
                model.togglePlayback()
            }
            iconButton("forward.frame", label: "下一帧") { model.step(1) }
            Text("\(timecode(model.playhead)) / \(timecode(model.current?.duration ?? 0))")
                .font(.system(size: 10, design: .monospaced))
                .foregroundColor(RelivePalette.secondary)
                .padding(.leading, 3)
            Spacer(minLength: 4)
            Button(action: model.chooseCover) {
                Label("当前帧设为封面", systemImage: "photo.badge.checkmark")
                    .font(.system(size: 11, weight: .medium))
            }
            .buttonStyle(ReliveButtonStyle())
        }
        .padding(.horizontal, 14)
        .frame(height: 56)
        .disabled(model.current == nil || model.busy)
    }

    private var timeline: some View {
        VStack(alignment: .leading, spacing: 12) {
            HStack {
                Text("帧时间线").font(.system(size: 12, weight: .semibold))
                Spacer()
                if model.current != nil {
                    Text("当前第 \(model.currentFrame) 帧")
                        .font(.system(size: 10, design: .monospaced))
                        .foregroundColor(RelivePalette.secondary)
                } else {
                    Text("选取一帧作为封面")
                        .font(.system(size: 11))
                        .foregroundColor(RelivePalette.secondary)
                }
            }
            if model.thumbnails.isEmpty {
                RoundedRectangle(cornerRadius: 6)
                    .fill(RelivePalette.background)
                    .frame(height: 62)
                    .overlay {
                        Text(model.current == nil ? "导入后显示帧预览" : "正在读取帧预览…")
                            .font(.system(size: 11))
                            .foregroundColor(RelivePalette.secondary)
                    }
            } else {
                ScrollView(.horizontal, showsIndicators: false) {
                    HStack(spacing: 4) {
                        ForEach(model.thumbnails) { thumbnail in
                            timelineFrame(thumbnail)
                        }
                    }
                }
                .frame(height: 64)
            }
            HStack(spacing: 10) {
                Text("00:00").font(.system(size: 10, design: .monospaced))
                Slider(value: Binding(get: { model.playhead }, set: { model.seek($0) }), in: 0...max(0.01, model.current?.duration ?? 0))
                    .accessibilityLabel("预览时间")
                Text(timecode(model.current?.duration ?? 0))
                    .font(.system(size: 10, design: .monospaced))
            }
            .foregroundColor(RelivePalette.secondary)
            .disabled(model.current == nil || model.busy)
            HStack(spacing: 6) {
                Image(systemName: "pin.fill").foregroundColor(RelivePalette.accent)
                Text(model.current == nil ? "拖动定位，然后使用逐帧按钮确认封面。" : "封面：第 \(model.coverFrame) 帧 · \(timecode(model.coverTime))")
                    .foregroundColor(RelivePalette.secondary)
            }
            .font(.system(size: 10))
        }
        .padding(16)
        .background(RelivePalette.panel)
        .clipShape(RoundedRectangle(cornerRadius: 12))
    }

    private func timelineFrame(_ thumbnail: FrameThumbnail) -> some View {
        let coverID = model.thumbnails.min { abs($0.time - model.coverTime) < abs($1.time - model.coverTime) }?.id
        return Button {
            model.seek(thumbnail.time)
        } label: {
            ZStack(alignment: .bottomLeading) {
                Image(nsImage: thumbnail.image)
                    .resizable()
                    .scaledToFill()
                    .frame(width: 82, height: 62)
                    .clipped()
                Text(timecode(thumbnail.time))
                    .font(.system(size: 9, design: .monospaced))
                    .foregroundColor(.white)
                    .padding(3)
                    .background(Color.black.opacity(0.72), in: RoundedRectangle(cornerRadius: 3))
                    .padding(4)
            }
            .overlay(alignment: .topTrailing) {
                if thumbnail.id == coverID {
                    Image(systemName: "pin.fill")
                        .font(.system(size: 9))
                        .foregroundColor(RelivePalette.background)
                        .padding(5)
                        .background(RelivePalette.accent, in: RoundedRectangle(cornerRadius: 4))
                        .padding(3)
                }
            }
            .clipShape(RoundedRectangle(cornerRadius: 5))
        }
        .buttonStyle(.plain)
        .disabled(model.busy)
        .accessibilityLabel("定位到 \(timecode(thumbnail.time))")
    }

    private var inspector: some View {
        VStack(alignment: .leading, spacing: 0) {
            HStack(spacing: 8) {
                Image(systemName: "livephoto").foregroundColor(RelivePalette.accent)
                Text("导出 Live Photo").font(.system(size: 14, weight: .semibold))
                Spacer()
            }
            .padding(18)
            Divider().overlay(RelivePalette.line)
            ScrollView {
                VStack(alignment: .leading, spacing: 22) {
                    coverSettings
                    clipSettings
                    exportSettings
                    publishingHelp
                }
                .padding(18)
            }
            Divider().overlay(RelivePalette.line)
            exportActions.padding(18)
        }
        .background(RelivePalette.panel)
        .clipShape(RoundedRectangle(cornerRadius: 12))
        .frame(maxHeight: .infinity)
    }

    private var coverSettings: some View {
        VStack(alignment: .leading, spacing: 11) {
            inspectorHeading("封面", systemImage: "photo")
            HStack(spacing: 8) {
                Button("使用首帧", action: model.setFirstCover)
                    .frame(maxWidth: .infinity)
                Button("使用当前帧", action: model.chooseCover)
                    .frame(maxWidth: .infinity)
            }
            .buttonStyle(ReliveButtonStyle())
            HStack(spacing: 8) {
                Text("第")
                    .foregroundColor(RelivePalette.secondary)
                TextField("帧号", text: $frameInput)
                    .textFieldStyle(.roundedBorder)
                    .monospacedDigit()
                    .onSubmit(applyCoverFrame)
                    .accessibilityLabel("封面帧号，从第 1 帧开始")
                Text("帧")
                    .foregroundColor(RelivePalette.secondary)
                Button("确定", action: applyCoverFrame)
                    .buttonStyle(ReliveButtonStyle())
            }
            if let frameInputError {
                Text(frameInputError)
                    .font(.system(size: 11))
                    .foregroundColor(.orange)
            } else {
                Text(model.current == nil ? "首帧从第 1 帧开始计数。" : "共 \(model.frameCount) 帧 · 已选第 \(model.coverFrame) 帧")
                    .font(.system(size: 11))
                    .foregroundColor(RelivePalette.secondary)
            }
        }
        .disabled(model.current == nil || model.busy)
    }

    private var clipSettings: some View {
        VStack(alignment: .leading, spacing: 11) {
            inspectorHeading("片段", systemImage: "scissors")
            HStack(spacing: 10) {
                VStack(alignment: .leading, spacing: 6) {
                    Text("开始 / 秒")
                        .font(.system(size: 10))
                        .foregroundColor(RelivePalette.secondary)
                    TextField("开始时间", value: $model.trimStart, format: .number.precision(.fractionLength(2)))
                        .textFieldStyle(.roundedBorder)
                        .monospacedDigit()
                        .accessibilityLabel("片段开始时间，单位秒")
                }
                VStack(alignment: .leading, spacing: 6) {
                    Text("结束 / 秒")
                        .font(.system(size: 10))
                        .foregroundColor(RelivePalette.secondary)
                    TextField("结束时间", value: $model.trimEnd, format: .number.precision(.fractionLength(2)))
                        .textFieldStyle(.roundedBorder)
                        .monospacedDigit()
                        .accessibilityLabel("片段结束时间，单位秒")
                }
            }
            Text(model.current == nil ? "默认保留完整视频，可按需选取片段。" : "导出时长 \(String(format: "%.2f", model.clipDuration)) 秒 · 默认保留完整视频")
                .font(.system(size: 11))
                .foregroundColor(RelivePalette.secondary)
                .fixedSize(horizontal: false, vertical: true)
        }
        .disabled(model.current == nil || model.busy)
    }

    private var exportSettings: some View {
        VStack(alignment: .leading, spacing: 11) {
            inspectorHeading("输出", systemImage: "square.and.arrow.up")
            HStack {
                Text("最长边")
                Spacer()
                Text("像素").foregroundColor(RelivePalette.secondary)
            }
            .font(.system(size: 11))
            Picker("输出最长边", selection: $model.maxSide) {
                Text("1080").tag(1080)
                Text("1920").tag(1920)
            }
            .pickerStyle(.segmented)
            Toggle("保留原声音", isOn: $model.keepAudio)
                .toggleStyle(.switch)
                .font(.system(size: 12))
            Button(action: model.chooseOutputDirectory) {
                HStack(spacing: 8) {
                    Image(systemName: "folder")
                        .foregroundColor(RelivePalette.secondary)
                    VStack(alignment: .leading, spacing: 3) {
                        Text("保存位置")
                            .font(.system(size: 10))
                            .foregroundColor(RelivePalette.secondary)
                        Text(model.exportDirectory.lastPathComponent)
                            .font(.system(size: 12))
                            .lineLimit(1)
                            .truncationMode(.middle)
                    }
                    Spacer(minLength: 0)
                    Image(systemName: "chevron.right")
                        .font(.system(size: 10))
                        .foregroundColor(RelivePalette.secondary)
                }
                .padding(10)
                .background(RelivePalette.elevated, in: RoundedRectangle(cornerRadius: 7))
            }
            .buttonStyle(.plain)
            .help(model.exportDirectory.path)
            .accessibilityLabel("选择导出文件夹，目前为 \(model.exportDirectory.path)")
        }
        .disabled(model.busy)
    }

    private var publishingHelp: some View {
        DisclosureGroup("如何在小红书发布", isExpanded: $showPublishingHelp) {
            VStack(alignment: .leading, spacing: 10) {
                publishingStep("1", text: "导出后点击「导入照片」，保存到 Mac「照片」。")
                publishingStep("2", text: "从「照片」用 AirDrop 传到 iPhone，确认相册显示 LIVE。")
                publishingStep("3", text: "打开小红书，从相册选取这张 Live 图，再发布笔记。")
                Text("导出文件需要先进入系统相册。小红书识别结果以手机当前版本为准。")
                    .font(.system(size: 10))
                    .foregroundColor(RelivePalette.secondary)
                    .fixedSize(horizontal: false, vertical: true)
            }
            .padding(.top, 10)
        }
        .font(.system(size: 11))
        .foregroundColor(RelivePalette.secondary)
    }

    private func publishingStep(_ number: String, text: String) -> some View {
        HStack(alignment: .top, spacing: 8) {
            Text(number)
                .font(.system(size: 10, weight: .semibold, design: .monospaced))
                .foregroundColor(RelivePalette.accent)
                .frame(width: 13)
            Text(text)
                .font(.system(size: 11))
                .lineSpacing(3)
                .fixedSize(horizontal: false, vertical: true)
        }
    }

    private var exportActions: some View {
        VStack(alignment: .leading, spacing: 12) {
            if model.busy {
                HStack {
                    Text(model.status.isEmpty ? "正在处理…" : model.status)
                        .font(.system(size: 11))
                        .lineLimit(2)
                    Spacer()
                    Text("\(Int(max(0, min(1, model.progress)) * 100))%")
                        .font(.system(size: 11, design: .monospaced))
                        .foregroundColor(RelivePalette.secondary)
                }
                ProgressView(value: max(0, min(1, model.progress)))
                    .progressViewStyle(.linear)
                    .accessibilityLabel("处理进度")
                Button("取消", action: model.cancel)
                    .buttonStyle(ReliveButtonStyle())
                    .frame(maxWidth: .infinity)
            } else {
                Button(action: model.export) {
                    HStack(spacing: 8) {
                        Image(systemName: "livephoto")
                        Text("导出 Live Photo").fontWeight(.semibold)
                        Spacer()
                        Image(systemName: "arrow.right")
                    }
                    .frame(maxWidth: .infinity)
                    .padding(.vertical, 5)
                }
                .buttonStyle(ReliveButtonStyle(primary: true))
                .disabled(model.current == nil)
                if model.lastExport != nil {
                    HStack(spacing: 6) {
                        Image(systemName: "checkmark.circle.fill")
                            .foregroundColor(RelivePalette.accent)
                        Text("已导出：\(model.lastExport?.deletingPathExtension().lastPathComponent ?? "Live Photo")")
                            .font(.system(size: 11))
                            .lineLimit(1)
                            .truncationMode(.middle)
                    }
                    HStack(spacing: 8) {
                        Button("打开文件夹", action: model.revealOutput)
                        Button("导入照片", action: model.openPhotos)
                    }
                    .buttonStyle(ReliveButtonStyle())
                }
            }
        }
    }

    private var statusBar: some View {
        HStack(spacing: 7) {
            Circle()
                .fill(model.busy ? Color.orange : RelivePalette.accent)
                .frame(width: 5, height: 5)
                .accessibilityHidden(true)
            Text(model.status.isEmpty ? "就绪" : model.status)
                .lineLimit(1)
                .truncationMode(.middle)
            Spacer()
            Text("⌘O 导入素材")
            Rectangle().fill(RelivePalette.line).frame(width: 1, height: 11).padding(.horizontal, 5)
            Text("Relive")
        }
        .font(.system(size: 10))
        .foregroundColor(RelivePalette.secondary)
        .padding(.horizontal, 20)
        .frame(height: 30)
        .background(RelivePalette.panel.opacity(0.5))
    }

    private func errorBanner(_ error: String) -> some View {
        HStack(alignment: .top, spacing: 9) {
            Image(systemName: "exclamationmark.circle")
                .foregroundColor(.orange)
            Text(error)
                .font(.system(size: 12))
                .textSelection(.enabled)
                .fixedSize(horizontal: false, vertical: true)
            Spacer(minLength: 10)
            Button(action: model.clearError) {
                Image(systemName: "xmark")
            }
            .buttonStyle(.plain)
            .accessibilityLabel("关闭错误信息")
        }
        .padding(.horizontal, 18)
        .padding(.vertical, 11)
        .background(Color.orange.opacity(0.1))
        .accessibilityElement(children: .contain)
    }

    private func inspectorHeading(_ title: String, systemImage: String) -> some View {
        HStack(spacing: 7) {
            Image(systemName: systemImage)
                .font(.system(size: 11))
                .foregroundColor(RelivePalette.secondary)
                .frame(width: 14)
                .accessibilityHidden(true)
            Text(title).font(.system(size: 12, weight: .semibold))
        }
    }

    private func iconButton(_ image: String, label: String, action: @escaping () -> Void) -> some View {
        Button(action: action) {
            Image(systemName: image)
                .font(.system(size: 12, weight: .medium))
                .frame(width: 19, height: 18)
        }
        .buttonStyle(ReliveButtonStyle())
        .help(label)
        .accessibilityLabel(label)
    }

    private func applyCoverFrame() {
        guard let frame = Int(frameInput.trimmingCharacters(in: .whitespacesAndNewlines)),
              frame >= 1, frame <= model.frameCount else {
            frameInputError = "请输入 1 到 \(max(1, model.frameCount)) 之间的帧号。"
            return
        }
        frameInputError = nil
        model.setCoverFrame(frame)
        model.seek(model.coverTime)
        frameInput = String(model.coverFrame)
    }

    private func acceptDrop(_ providers: [NSItemProvider]) -> Bool {
        guard !model.busy, !providers.isEmpty else { return false }
        Task { @MainActor in
            var urls: [URL] = []
            for provider in providers {
                let url: URL? = await withCheckedContinuation { continuation in
                    provider.loadItem(forTypeIdentifier: UTType.fileURL.identifier, options: nil) { item, _ in
                        if let url = item as? URL {
                            continuation.resume(returning: url)
                        } else if let data = item as? Data {
                            continuation.resume(returning: URL(dataRepresentation: data, relativeTo: nil))
                        } else if let string = item as? String {
                            continuation.resume(returning: URL(string: string))
                        } else {
                            continuation.resume(returning: nil)
                        }
                    }
                }
                if let url, url.isFileURL { urls.append(url) }
            }
            if !urls.isEmpty { model.importFiles(urls) }
        }
        return true
    }

    private func timecode(_ seconds: Double) -> String {
        let safe = seconds.isFinite ? max(0, seconds) : 0
        let minutes = Int(safe) / 60
        let remainder = Int(safe) % 60
        let hundredths = Int((safe - floor(safe)) * 100)
        return String(format: "%02d:%02d.%02d", minutes, remainder, hundredths)
    }
}

private struct RelivePlayerView: NSViewRepresentable {
    let player: AVPlayer

    func makeNSView(context: Context) -> AVPlayerView {
        let view = AVPlayerView()
        view.player = player
        view.controlsStyle = .none
        view.videoGravity = .resizeAspect
        view.showsFullScreenToggleButton = false
        view.showsSharingServiceButton = false
        view.setContentHuggingPriority(.defaultLow, for: .horizontal)
        view.setContentHuggingPriority(.defaultLow, for: .vertical)
        return view
    }

    func updateNSView(_ view: AVPlayerView, context: Context) {
        if view.player !== player { view.player = player }
    }
}

private struct ReliveButtonStyle: ButtonStyle {
    var primary = false
    @Environment(\.isEnabled) private var isEnabled
    @State private var hovered = false

    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .font(.system(size: 12, weight: .medium))
            .foregroundColor(primary ? RelivePalette.background : RelivePalette.text)
            .padding(.horizontal, 10)
            .padding(.vertical, 8)
            .background(primary ? RelivePalette.accent : RelivePalette.elevated)
            .clipShape(RoundedRectangle(cornerRadius: 7))
            .brightness(configuration.isPressed ? -0.06 : (hovered && isEnabled ? 0.035 : 0))
            .opacity(isEnabled ? 1 : 0.38)
            .onHover { hovered = $0 }
    }
}
