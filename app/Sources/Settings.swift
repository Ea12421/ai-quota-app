import Foundation

// 胶囊盯哪个工具的额度:auto=跨工具取最紧(默认),或固定 Claude Code / Codex。
enum PillTool: String {
    case auto
    case claudeCode = "claude-code"
    case codex
}

enum Settings {
    private static let key = "pillTool"

    static var pillTool: PillTool {
        get { PillTool(rawValue: UserDefaults.standard.string(forKey: key) ?? "") ?? .auto }
        set { UserDefaults.standard.set(newValue.rawValue, forKey: key) }
    }
}
