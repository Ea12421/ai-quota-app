import Foundation
import ServiceManagement

// 开机自启:用 macOS 13+ 的 SMAppService 把本 app 注册/注销为登录项。
// 注册的是 .app 当前所在路径,所以装到哪儿就从哪儿自启(build.sh 重打同路径不受影响)。
enum LoginItem {
    static var enabled: Bool {
        if #available(macOS 13.0, *) { return SMAppService.mainApp.status == .enabled }
        return false
    }

    static func toggle() {
        guard #available(macOS 13.0, *) else { return }
        do {
            if SMAppService.mainApp.status == .enabled {
                try SMAppService.mainApp.unregister()
            } else {
                try SMAppService.mainApp.register()
            }
        } catch {
            NSLog("UsageBar: 开机自启切换失败 \(error)")
        }
    }
}
