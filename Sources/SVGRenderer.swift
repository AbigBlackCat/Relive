import AppKit
import WebKit
import Foundation

@MainActor
final class SVGRenderer: NSObject, WKNavigationDelegate {
    private var webView: WKWebView?
    private var window: NSWindow?
    private var navigation: CheckedContinuation<Void, Error>?
    private var navigationTimeout: Task<Void, Never>?

    static func dimensions(_ document: XMLDocument) throws -> CGSize {
        guard let root = document.rootElement(), root.localName == "svg" || root.name == "svg" else { throw ReliveError.message("这个文件不是有效的 SVG。") }
        func number(_ value: String?) -> Double? {
            guard let value else { return nil }
            let digits = String(value.prefix { $0.isNumber || $0 == "." || $0 == "-" })
            guard let n = Double(digits), n.isFinite, n > 0 else { return nil }; return n
        }
        let viewBox = (root.attribute(forName: "viewBox")?.stringValue ?? "").split { $0 == " " || $0 == "," || $0 == "\n" || $0 == "\t" }.compactMap { Double($0) }
        var width = number(root.attribute(forName: "width")?.stringValue)
        var height = number(root.attribute(forName: "height")?.stringValue)
        if viewBox.count == 4 && viewBox[2].isFinite && viewBox[3].isFinite && viewBox[2] > 0 && viewBox[3] > 0 {
            if width == nil || root.attribute(forName: "width")?.stringValue?.contains("%") == true { width = viewBox[2] }
            if height == nil || root.attribute(forName: "height")?.stringValue?.contains("%") == true { height = viewBox[3] }
        }
        let w = width ?? 1080, h = height ?? 1080
        guard w / h < 100, h / w < 100 else { throw ReliveError.message("SVG 的宽高比例过大，请调整画布后再导入。") }
        let scale = min(1, 1920 / max(w, h))
        return CGSize(width: max(2, floor(w * scale / 2) * 2), height: max(2, floor(h * scale / 2) * 2))
    }

    func render(source: URL, destination: URL, duration: Double, background: String, token: JobToken, progress: @escaping (Double) -> Void) async throws -> MediaInfo {
        let attributes = try FileManager.default.attributesOfItem(atPath: source.path)
        guard ((attributes[.size] as? NSNumber)?.intValue ?? 0) <= 20_971_520 else { throw ReliveError.message("SVG 超过 20 MB，请先精简文件。") }
        let data = try Data(contentsOf: source)
        guard data.count <= 20_971_520 else { throw ReliveError.message("SVG 超过 20 MB，请先精简文件。") }
        guard let text = String(data: data, encoding: .utf8) else { throw ReliveError.message("请将 SVG 保存为 UTF-8 编码后再导入。") }
        guard !text.uppercased().contains("<!DOCTYPE"), !text.uppercased().contains("<!ENTITY") else { throw ReliveError.message("SVG 包含 DTD 或实体定义，请先导出为普通 SVG。") }
        let document = try XMLDocument(data: data, options: [.nodeLoadExternalEntitiesNever])
        let size = try Self.dimensions(document)
        guard let root = document.rootElement() else { throw ReliveError.message("SVG 没有可读取的画面。") }
        root.removeAttribute(forName: "width"); root.removeAttribute(forName: "height")
        root.addAttribute(XMLNode.attribute(withName: "width", stringValue: "100%") as! XMLNode)
        root.addAttribute(XMLNode.attribute(withName: "height", stringValue: "100%") as! XMLNode)
        let background = background == "#000000" ? "#000000" : "#FFFFFF"
        let svg = root.xmlString
        let config = WKWebViewConfiguration()
        config.websiteDataStore = .nonPersistent()
        let web = WKWebView(frame: NSRect(origin: .zero, size: size), configuration: config)
        web.navigationDelegate = self
        web.setValue(false, forKey: "drawsBackground")
        let host = NSWindow(contentRect: NSRect(origin: NSPoint(x: -10000, y: -10000), size: size), styleMask: [.borderless], backing: .buffered, defer: false)
        host.contentView = web
        host.isReleasedWhenClosed = false
        host.ignoresMouseEvents = true
        host.collectionBehavior = [.transient, .ignoresCycle]
        host.orderFrontRegardless()
        webView = web; window = host
        defer { navigationTimeout?.cancel(); web.stopLoading(); host.close(); self.webView = nil; self.window = nil }
        let html = """
        <!doctype html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src data: blob:; style-src 'unsafe-inline'; script-src 'none'; connect-src 'none'; font-src data:; media-src data:"><style>html,body{margin:0;width:100%;height:100%;overflow:hidden;background:\(background)}svg{display:block;width:100%;height:100%}*{animation-play-state:paused!important}</style></head><body>\(svg)</body></html>
        """
        try await withCheckedThrowingContinuation { (continuation: CheckedContinuation<Void, Error>) in
            navigation = continuation
            navigationTimeout = Task { [weak self] in
                try? await Task.sleep(nanoseconds: 15_000_000_000)
                guard !Task.isCancelled, let self, let waiting = self.navigation else { return }
                self.navigation = nil; waiting.resume(throwing: ReliveError.message("SVG 渲染超时，请检查文件。"))
            }
            web.loadHTMLString(html, baseURL: nil)
        }
        try token.check()
        _ = try await web.evaluateJavaScript("document.querySelector('svg').pauseAnimations(); document.getAnimations().forEach(a=>a.pause());")
        let frames = destination.deletingLastPathComponent().appendingPathComponent("svg-frames-" + UUID().uuidString)
        try FileManager.default.createDirectory(at: frames, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: frames) }
        let fps = 30.0
        let count = max(1, Int(ceil(duration * fps)))
        for index in 0..<count {
            try token.check()
            let seconds = Double(index) / fps
            _ = try await web.evaluateJavaScript("document.querySelector('svg').setCurrentTime(\(seconds)); document.getAnimations().forEach(a=>{a.pause();a.currentTime=\(seconds * 1000)}); document.body.offsetHeight;")
            // A presentation turn lets WebKit commit both SMIL and CSS animation positions.
            try await Task.sleep(nanoseconds: 20_000_000)
            let snapshot = WKSnapshotConfiguration()
            snapshot.rect = NSRect(origin: .zero, size: size)
            snapshot.snapshotWidth = NSNumber(value: Double(size.width))
            let image = try await web.takeSnapshot(configuration: snapshot)
            guard let tiff = image.tiffRepresentation, let bitmap = NSBitmapImageRep(data: tiff), let png = bitmap.representation(using: .png, properties: [:]) else { throw ReliveError.message("无法保存 SVG 画面。") }
            try png.write(to: frames.appendingPathComponent(String(format: "%06d.png", index)))
            progress(Double(index + 1) / Double(count) * 0.8)
        }
        _ = try await Tools.run("ffmpeg", ["-v", "error", "-nostdin", "-framerate", "30", "-i", frames.appendingPathComponent("%06d.png").path, "-vf", "scale=\(Int(size.width)):\(Int(size.height)),format=yuv420p", "-c:v", "libx264", "-preset", "fast", "-crf", "18", "-movflags", "+faststart", destination.path], token: token)
        progress(1)
        return try await MediaEngine.probe(destination, token: token)
    }

    func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
        navigationTimeout?.cancel(); let waiting = self.navigation; self.navigation = nil; waiting?.resume()
    }
    func webView(_ webView: WKWebView, decidePolicyFor navigationAction: WKNavigationAction, decisionHandler: @escaping (WKNavigationActionPolicy) -> Void) {
        let url = navigationAction.request.url
        decisionHandler(url == nil || url?.absoluteString == "about:blank" ? .allow : .cancel)
    }
    func webView(_ webView: WKWebView, didFail navigation: WKNavigation!, withError error: Error) { fail(error) }
    func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) { fail(error) }
    private func fail(_ error: Error) { navigationTimeout?.cancel(); let waiting = navigation; navigation = nil; waiting?.resume(throwing: error) }
}
