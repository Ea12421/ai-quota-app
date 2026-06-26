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

        // 用弱代理接消息:userContentController 会强持有 handler,直接 add(self) 会和
        // webView 互相强引用成循环。弱代理让这一环"松手",从根上断掉循环引用。
        cfg.userContentController.add(WeakScriptMessageHandler(self), name: "app")
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
            popover.show(relativeTo: button.bounds, of: button, preferredEdge: .minY)
        }
    }

    // 引擎就绪后预加载一次,常驻留着。避免每次点开都重载 → 消除"先白一下"。
    // 数据不靠重载刷新(引擎本就 60s 才重算),靠网页自身的 60s 自刷新保持新鲜。
    func preload() {
        webView.load(URLRequest(url: url, cachePolicy: .reloadIgnoringLocalCacheData))
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
            // 宽度固定(内容 width:100% 自适配),只按内容真实高度调高;防 NaN/Infinity/超大值
            guard let h = numeric(body["h"]), h.isFinite else { break }
            let maxH = (NSScreen.main?.visibleFrame.height ?? 1000) - 40
            popover.contentSize = NSSize(width: kPopoverWidth, height: min(max(120, h), maxH))
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

// 弱代理:userContentController 强持有它,它只弱持有真正的 handler → 打破循环引用。
private final class WeakScriptMessageHandler: NSObject, WKScriptMessageHandler {
    private weak var target: WKScriptMessageHandler?
    init(_ target: WKScriptMessageHandler) { self.target = target }
    func userContentController(_ ucc: WKUserContentController, didReceive message: WKScriptMessage) {
        target?.userContentController(ucc, didReceive: message)
    }
}
