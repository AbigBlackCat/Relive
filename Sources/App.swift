import SwiftUI
import AppKit

final class AppDelegate: NSObject, NSApplicationDelegate {
    func applicationDidFinishLaunching(_ notification: Notification) {
        NSApplication.shared.setActivationPolicy(.regular)
        NSApplication.shared.activate(ignoringOtherApps: true)
        let args = CommandLine.arguments
        if let index = args.firstIndex(of: "--self-test"), args.count > index + 1 {
            Task { @MainActor in
                do { try await SelfTests.run(directory: URL(fileURLWithPath: args[index + 1])); print("RELIVE_SELF_TEST_PASS"); exit(0) }
                catch { fputs("RELIVE_SELF_TEST_FAIL: \(error)\n", stderr); exit(1) }
            }
        } else if let index = args.firstIndex(of: "--open"), args.count > index + 1 {
            Task { @MainActor in ReliveModel.shared.importFiles([URL(fileURLWithPath: args[index + 1])]) }
        }
    }
    func application(_ sender: NSApplication, openFiles filenames: [String]) {
        Task { @MainActor in ReliveModel.shared.importFiles(filenames.map { URL(fileURLWithPath: $0) }) }
        sender.reply(toOpenOrPrint: .success)
    }
    func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool { true }
    func applicationWillTerminate(_ notification: Notification) { MainActor.assumeIsolated { ReliveModel.shared.cleanUp() } }
}

@main
struct ReliveApp: App {
    @NSApplicationDelegateAdaptor(AppDelegate.self) var appDelegate
    @StateObject private var model = ReliveModel.shared
    var body: some Scene {
        WindowGroup("Relive") {
            MainView(model: model)
                .preferredColorScheme(.dark)
                .frame(minWidth: 1100, minHeight: 720)
        }
        .windowStyle(.hiddenTitleBar)
        .defaultSize(width: 1360, height: 860)
        .commands {
            CommandGroup(replacing: .newItem) { Button("导入素材…", action: model.chooseFiles).keyboardShortcut("o").disabled(model.busy) }
            CommandGroup(replacing: .saveItem) { Button("导出 \(model.exportFormat.title)", action: model.export).keyboardShortcut("e").disabled(model.busy || model.current == nil) }
            CommandMenu("封面") {
                if model.exportFormat == .livePhoto {
                    Button("将当前帧设为封面", action: model.chooseCover).keyboardShortcut("k").disabled(model.busy || model.current == nil)
                    Button("使用首帧", action: model.setFirstCover).disabled(model.busy || model.current == nil)
                }
                Button("上一帧") { model.step(-1) }.keyboardShortcut(.leftArrow, modifiers: []).disabled(model.busy || model.current == nil)
                Button("下一帧") { model.step(1) }.keyboardShortcut(.rightArrow, modifiers: []).disabled(model.busy || model.current == nil)
            }
            CommandGroup(after: .help) {
                Button("Relive 使用说明") { if let url = Bundle.main.url(forResource: "使用说明", withExtension: "html") { NSWorkspace.shared.open(url) } }
                Button("第三方许可") { if let url = Bundle.main.resourceURL?.appendingPathComponent("licenses") { NSWorkspace.shared.open(url) } }
            }
        }
    }
}
