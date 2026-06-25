import AppKit
import WebKit

let kPopoverWidth: CGFloat = 300

// 点开的弹窗:NSPopover 里装现有网页的 ?view=popover 视图(双工具限额 + 今日 + 近7天)。
// 网页里的菜单项("打开完整窗口"/"退出")通过 JS→原生消息回调到这里。
final class PopoverController: NSObject, WKScriptMessageHandler {
    private let popover = NSPopover()
    private let webView: WKWebView
    private let onOpenFull: () -> Void
    private let url: URL

    init(baseURL: URL, onOpenFull: @escaping () -> Void) {
        self.onOpenFull = onOpenFull
        self.url = URL(string: baseURL.absoluteString + "/?view=popover")!

        let cfg = WKWebViewConfiguration()
        cfg.userContentController = WKUserContentController()
        webView = WKWebView(frame: NSRect(x: 0, y: 0, width: kPopoverWidth, height: 380), configuration: cfg)
        super.init()

        cfg.userContentController.add(self, name: "app")
        webView.setValue(false, forKey: "drawsBackground") // 透出原生 popover 衬底(磨砂)
        webView.autoresizingMask = [.width, .height]       // 随 popover 尺寸变化填满

        let vc = NSViewController()
        vc.view = webView
        popover.contentViewController = vc
        popover.behavior = .transient
        popover.contentSize = NSSize(width: kPopoverWidth, height: 380)
        popover.appearance = NSAppearance(named: .aqua) // 设计是浅色主题,锁浅色避免暗黑模式不可读
    }

    func toggle(relativeTo button: NSStatusBarButton) {
        if popover.isShown {
            popover.performClose(nil)
        } else {
            webView.load(URLRequest(url: url, cachePolicy: .reloadIgnoringLocalCacheData))
            popover.show(relativeTo: button.bounds, of: button, preferredEdge: .minY)
        }
    }

    func close() { popover.performClose(nil) }

    // JS → 原生
    func userContentController(_ ucc: WKUserContentController, didReceive message: WKScriptMessage) {
        guard let body = message.body as? [String: Any],
              let action = body["action"] as? String else { return }
        switch action {
        case "openFull":
            onOpenFull()
        case "quit":
            NSApp.terminate(nil)
        case "resize":
            // 宽度固定(内容 width:100% 自适配),只按内容真实高度调高
            let h = numeric(body["h"]) ?? 380
            popover.contentSize = NSSize(width: kPopoverWidth, height: max(120, h))
        default:
            break
        }
    }

    private func numeric(_ v: Any?) -> CGFloat? {
        if let d = v as? Double { return CGFloat(d) }
        if let i = v as? Int { return CGFloat(i) }
        return nil
    }
}
