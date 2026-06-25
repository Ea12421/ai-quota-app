import AppKit

let kPort = 7799

// 装配各部件:引擎子进程 → 数据轮询 → 菜单栏胶囊 / 弹窗 / 完整窗口。
// 数据/界面解耦延续到这里:本壳只起引擎 + 消费它产的 JSON,绝不碰原始日志。
final class AppDelegate: NSObject, NSApplicationDelegate {
    private let engine = EngineProcess(port: kPort)
    private let store = UsageStore(port: kPort)
    private var pill: StatusPill!
    private var popover: PopoverController!
    private var mainWindow: MainWindowController!

    func applicationDidFinishLaunching(_ notification: Notification) {
        let base = URL(string: "http://127.0.0.1:\(kPort)")!

        popover = PopoverController(baseURL: base, onOpenFull: { [weak self] in
            self?.openMainWindow()
        })
        mainWindow = MainWindowController(baseURL: base)
        pill = StatusPill(onClick: { [weak self] button in
            self?.popover.toggle(relativeTo: button)
        })

        store.onUpdate = { [weak self] snap in self?.pill.update(with: snap) }

        // 已有引擎在跑就复用,否则拉起;就绪后开始轮询喂胶囊。
        engine.ensureRunning { [weak self] _ in
            DispatchQueue.main.async { self?.store.start() }
        }
    }

    func applicationWillTerminate(_ notification: Notification) {
        engine.stop()
    }

    private func openMainWindow() {
        popover.close()
        mainWindow.show()
    }
}
