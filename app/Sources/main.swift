import AppKit

// 入口:菜单栏常驻 app(无 Dock 图标)。真正的装配在 AppDelegate。
let app = NSApplication.shared
app.setActivationPolicy(.accessory)
let delegate = AppDelegate()
app.delegate = delegate
app.run()
