import AppKit

// 菜单栏胶囊:环形进度 + 已用%,随阈值变色(工具区分放在点开的弹窗里)。
final class StatusPill {
    private let item: NSStatusItem
    private let onClick: (NSStatusBarButton) -> Void

    init(onClick: @escaping (NSStatusBarButton) -> Void) {
        self.onClick = onClick
        item = NSStatusBar.system.statusItem(withLength: NSStatusItem.variableLength)
        if let b = item.button {
            b.imagePosition = .imageLeading
            b.font = NSFont.monospacedDigitSystemFont(ofSize: 12, weight: .medium)
            b.title = " 用量"
            b.target = self
            b.action = #selector(clicked)
            b.sendAction(on: [.leftMouseUp, .rightMouseUp])
        }
    }

    @objc private func clicked() {
        guard let b = item.button else { return }
        if NSApp.currentEvent?.type == .rightMouseUp {
            showMenu(from: b)
        } else {
            onClick(b)
        }
    }

    // 右键菜单:开机自启 + 退出(胶囊盯哪个工具的切换放在左键弹窗里,更显眼)
    private func showMenu(from button: NSStatusBarButton) {
        let menu = NSMenu()
        let login = NSMenuItem(title: "开机自启", action: #selector(toggleLogin), keyEquivalent: "")
        login.target = self
        login.state = LoginItem.enabled ? .on : .off
        menu.addItem(login)
        menu.addItem(.separator())
        menu.addItem(NSMenuItem(title: "退出", action: #selector(NSApplication.terminate(_:)), keyEquivalent: "q"))
        menu.popUp(positioning: nil, at: NSPoint(x: 0, y: button.bounds.maxY + 4), in: button)
    }

    @objc private func toggleLogin() { LoginItem.toggle() }

    func update(with snap: PillSnapshot) {
        guard let b = item.button else { return }
        if !snap.hasLimit {
            b.image = nil
            b.title = "用量 —"
            return
        }
        b.image = Self.ringImage(pct: snap.pct)
        b.title = " \(Int(snap.pct.rounded()))%"
    }

    // 环形进度:灰色轨道整圈 + 按阈值上色的弧(从 12 点顺时针),亮/暗菜单栏都可读。
    private static func ringImage(pct: Double) -> NSImage {
        let s: CGFloat = 15
        let lw: CGFloat = 2.6
        let img = NSImage(size: NSSize(width: s, height: s))
        img.lockFocus()
        let center = NSPoint(x: s / 2, y: s / 2)
        let r = s / 2 - lw / 2 - 0.5

        let track = NSBezierPath()
        track.appendArc(withCenter: center, radius: r, startAngle: 0, endAngle: 360)
        track.lineWidth = lw
        NSColor(white: 0.5, alpha: 0.30).setStroke()
        track.stroke()

        let frac = max(0, min(1, pct / 100))
        if frac > 0 {
            let sweep = 360 * frac
            let arc = NSBezierPath()
            arc.appendArc(withCenter: center, radius: r, startAngle: 90, endAngle: 90 - sweep, clockwise: true)
            arc.lineWidth = lw
            arc.lineCapStyle = .round
            color(for: pct).setStroke()
            arc.stroke()
        }
        img.unlockFocus()
        img.isTemplate = false
        return img
    }

    // 按使用率分 4 档(暖色渐进,蓝背景上也清晰):绿→金→橙→红(≥80% 告警)
    private static func color(for pct: Double) -> NSColor {
        switch pct {
        case ..<50:  return rgb(0x54, 0xB2, 0x66) // 绿:充裕
        case ..<70:  return rgb(0xE6, 0xB3, 0x3C) // 金/琥珀:中等
        case ..<80:  return rgb(0xE2, 0x7D, 0x2C) // 橙:接近
        default:     return rgb(0xD2, 0x3F, 0x2E) // 红:≥80 告警
        }
    }

    private static func rgb(_ r: Int, _ g: Int, _ b: Int) -> NSColor {
        NSColor(srgbRed: CGFloat(r)/255, green: CGFloat(g)/255, blue: CGFloat(b)/255, alpha: 1)
    }
}
