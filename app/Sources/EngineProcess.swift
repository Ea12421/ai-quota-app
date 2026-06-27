import Foundation

// 把现成的数据引擎(engine/usage-data.mjs --serve)当子进程拉起。
// 引擎已彻底 vet,一行不改;这里只负责"起/复用/停"。
final class EngineProcess {
    private let port: Int
    private var process: Process?

    init(port: Int) { self.port = port }

    func ensureRunning(completion: @escaping (Bool) -> Void) {
        healthCheck { [weak self] alive in
            guard let self = self else { completion(false); return }
            if alive { completion(true); return }   // 已有实例在服务 → 复用,不重复拉起
            self.spawn()
            self.waitUntilUp(retries: 30, completion: completion)
        }
    }

    func stop() {
        process?.terminate()
        process = nil
    }

    private func healthCheck(_ cb: @escaping (Bool) -> Void) {
        guard let url = URL(string: "http://127.0.0.1:\(port)/api/usage.json") else { cb(false); return }
        var req = URLRequest(url: url)
        req.timeoutInterval = 1.5
        URLSession.shared.dataTask(with: req) { data, resp, _ in
            // 不只看 200:校验响应确实是我们自家引擎的契约(含 tools/updatedAt),
            // 避免把占用 7799 的其他服务误认成自己的引擎而去复用/加载它的页面。
            guard (resp as? HTTPURLResponse)?.statusCode == 200, let data = data,
                  let obj = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
                  obj["tools"] is [Any], obj["updatedAt"] is String else { cb(false); return }
            cb(true)
        }.resume()
    }

    private func spawn() {
        guard let node = Self.resolveNode(), let root = Self.resolveProjectRoot() else {
            NSLog("UsageBar: 找不到 node 或项目目录,引擎未启动")
            return
        }
        let script = root.appendingPathComponent("engine/usage-data.mjs")
        let p = Process()
        p.executableURL = node
        p.arguments = [script.path, "--serve", String(port)]
        p.currentDirectoryURL = root
        p.standardOutput = FileHandle.nullDevice
        p.standardError = FileHandle.nullDevice
        do {
            try p.run()
            DispatchQueue.main.async { self.process = p }  // process 只在主线程读写,避免与 stop() 竞态
        } catch { NSLog("UsageBar: 引擎启动失败 \(error)") }
    }

    private func waitUntilUp(retries: Int, completion: @escaping (Bool) -> Void) {
        healthCheck { [weak self] alive in
            if alive { completion(true); return }
            if retries <= 0 { completion(false); return }
            DispatchQueue.global().asyncAfter(deadline: .now() + 0.3) {
                self?.waitUntilUp(retries: retries - 1, completion: completion)
            }
        }
    }

    // GUI app 的 PATH 很窄,直接探常见 node 安装位置。
    static func resolveNode() -> URL? {
        for c in ["/opt/homebrew/bin/node", "/usr/local/bin/node", "/usr/bin/node"]
        where FileManager.default.isExecutableFile(atPath: c) {
            return URL(fileURLWithPath: c)
        }
        return nil
    }

    // 项目根:从 .app 位置上溯 <root>/app/build/X.app;也支持调试时用环境变量指定。
    static func resolveProjectRoot() -> URL? {
        let fm = FileManager.default
        var candidates: [URL] = []
        if let envRoot = ProcessInfo.processInfo.environment["AI_QUOTA_APP_ROOT"], !envRoot.isEmpty {
            candidates.append(URL(fileURLWithPath: envRoot))
        }
        candidates.append(
            Bundle.main.bundleURL
                .deletingLastPathComponent()   // build
                .deletingLastPathComponent()   // app
                .deletingLastPathComponent()   // <root>
        )
        for root in candidates where fm.fileExists(atPath: root.appendingPathComponent("engine/usage-data.mjs").path) {
            return root
        }
        return nil
    }
}

final class QuotaAPIProcess {
    private let port: Int
    private var process: Process?

    init(port: Int) { self.port = port }

    func ensureRunning(completion: @escaping (Bool) -> Void) {
        healthCheck { [weak self] alive in
            guard let self = self else { completion(false); return }
            if alive { completion(true); return }
            self.spawn()
            self.waitUntilUp(retries: 20, completion: completion)
        }
    }

    func stop() {
        process?.terminate()
        process = nil
    }

    private func healthCheck(_ cb: @escaping (Bool) -> Void) {
        guard let url = URL(string: "http://127.0.0.1:\(port)/health") else { cb(false); return }
        var req = URLRequest(url: url)
        req.timeoutInterval = 1.5
        URLSession.shared.dataTask(with: req) { data, resp, _ in
            guard (resp as? HTTPURLResponse)?.statusCode == 200, let data = data,
                  let obj = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
                  obj["service"] as? String == "quota-app",
                  (obj["ok"] as? Bool) == true else { cb(false); return }
            cb(true)
        }.resume()
    }

    private func spawn() {
        guard let node = EngineProcess.resolveNode(), let root = EngineProcess.resolveProjectRoot() else {
            NSLog("UsageBar: 找不到 node 或项目目录,quota API 未启动")
            return
        }
        let script = root.appendingPathComponent("engine/quota-api.mjs")
        let p = Process()
        p.executableURL = node
        p.arguments = [script.path, "--port", String(port)]
        p.currentDirectoryURL = root
        p.standardOutput = FileHandle.nullDevice
        p.standardError = FileHandle.nullDevice
        do {
            try p.run()
            DispatchQueue.main.async { self.process = p }
        } catch { NSLog("UsageBar: quota API 启动失败 \(error)") }
    }

    private func waitUntilUp(retries: Int, completion: @escaping (Bool) -> Void) {
        healthCheck { [weak self] alive in
            if alive { completion(true); return }
            if retries <= 0 { completion(false); return }
            DispatchQueue.global().asyncAfter(deadline: .now() + 0.3) {
                self?.waitUntilUp(retries: retries - 1, completion: completion)
            }
        }
    }
}
