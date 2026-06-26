import Foundation

// 胶囊要显示的一刻状态:最紧那条限额。
struct PillSnapshot {
    let toolLetter: String   // "C"=Claude Code / "X"=Codex / ""=无
    let pct: Double          // 已用 %(跨工具取最紧)
    let hasLimit: Bool
}

// 轮询引擎的 /api/usage.json,解码出"最紧那条限额"喂给胶囊。
final class UsageStore {
    private let port: Int
    private var timer: Timer?
    var onUpdate: ((PillSnapshot) -> Void)?

    init(port: Int) { self.port = port }

    func start() {
        fetch()
        let t = Timer.scheduledTimer(withTimeInterval: 30, repeats: true) { [weak self] _ in self?.fetch() }
        RunLoop.main.add(t, forMode: .common)
        timer = t
    }

    func stop() { timer?.invalidate(); timer = nil }

    // 偏好变化后立刻重算一次(不等下个 30s 轮询)
    func refresh() { fetch() }

    private func fetch() {
        guard let url = URL(string: "http://127.0.0.1:\(port)/api/usage.json") else { return }
        var req = URLRequest(url: url)
        req.timeoutInterval = 4
        req.cachePolicy = .reloadIgnoringLocalCacheData
        URLSession.shared.dataTask(with: req) { [weak self] data, _, _ in
            guard let self = self, let data = data,
                  let doc = try? JSONDecoder().decode(UsageDoc.self, from: data) else { return }
            let snap = Self.tightest(doc.limits)
            DispatchQueue.main.async { self.onUpdate?(snap) }
        }.resume()
    }

    // 按偏好取一条已用%:auto=跨 Claude/Codex 的 5h/7d 四条取最高;指定工具=只看该工具两条。
    static func tightest(_ limits: Limits?) -> PillSnapshot {
        var best: (letter: String, pct: Double)?
        func consider(_ tool: Limits.Tool?, _ letter: String) {
            guard let tool = tool else { return }
            for w in [tool.fiveHour, tool.sevenDay] {
                guard let w = w else { continue }
                if best == nil || w.pct > best!.pct { best = (letter, w.pct) }
            }
        }
        switch Settings.pillTool {
        case .auto:
            consider(limits?.claudeCode, "C")
            consider(limits?.codex, "X")
        case .claudeCode:
            consider(limits?.claudeCode, "C")
        case .codex:
            consider(limits?.codex, "X")
        }
        if let b = best { return PillSnapshot(toolLetter: b.letter, pct: b.pct, hasLimit: true) }
        return PillSnapshot(toolLetter: "", pct: 0, hasLimit: false)
    }
}

// MARK: - JSON 模型(只解码胶囊需要的 limits,其余字段忽略)
struct UsageDoc: Decodable {
    let limits: Limits?
}
struct Limits: Decodable {
    struct Window: Decodable { let pct: Double }
    struct Tool: Decodable { let fiveHour: Window?; let sevenDay: Window? }
    let claudeCode: Tool?
    let codex: Tool?
    enum CodingKeys: String, CodingKey {
        case claudeCode = "claude-code"
        case codex
    }
}
