import AppKit
import WebKit

// 完整窗口:独立 NSWindow 里装现有网页的 ?view=full(完整仪表盘)。
final class MainWindowController {
    private var window: NSWindow?
    private let url: URL

    init(baseURL: URL) {
        self.url = URL(string: baseURL.absoluteString + "/?view=full")!
    }

    func show() {
        if window == nil { build() }
        NSApp.activate(ignoringOtherApps: true) // 无 Dock 图标的 accessory app 要主动激活才能聚焦窗口
        window?.makeKeyAndOrderFront(nil)
    }

    private func build() {
        let web = WKWebView(frame: NSRect(x: 0, y: 0, width: 820, height: 900))
        web.load(URLRequest(url: url, cachePolicy: .reloadIgnoringLocalCacheData))

        let win = NSWindow(
            contentRect: NSRect(x: 0, y: 0, width: 820, height: 900),
            styleMask: [.titled, .closable, .miniaturizable, .resizable],
            backing: .buffered, defer: false)
        win.title = "用量看板"
        win.contentView = web
        win.center()
        win.isReleasedWhenClosed = false
        win.appearance = NSAppearance(named: .aqua)
        window = win
    }
}
