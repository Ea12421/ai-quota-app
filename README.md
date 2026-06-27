# AI 额度 App

一个本机运行的 macOS 菜单栏用量看板，用来把 Claude Code 与 Codex 的本地使用记录整理成统一的额度和用量视图。

## 功能

- 菜单栏常驻胶囊，显示当前最紧的 5h / 7d 额度使用情况。
- 左键打开弹窗，查看 Claude Code / Codex 的实时限额、重置时间和近 7 天用量。
- 支持胶囊偏好：自动显示最紧额度，或固定查看 Claude Code / Codex。
- 可打开完整窗口，查看工具分页、Token/美元切换、Project Monitor、任务标签、Agent 趋势、趋势图、价格表和限额卡片。
- 菜单栏 App 启动时会确保本机 quota API 在 `127.0.0.1:8765` 可用。
- 支持开机自启。

## 隐私边界

数据引擎只读取本机日志里的用量、模型、时间与计费相关字段，不读取或展示对话正文。

生成的 `usage.json` 包含真实 token、等价金额与限额百分比，属于个人数据，已在 `.gitignore` 中排除，不应提交到 GitHub。

## 运行数据服务

```bash
node engine/usage-data.mjs --serve 7799
```

启动后访问：

- `http://127.0.0.1:7799/`
- `http://127.0.0.1:7799/api/usage.json`

## 本地额度 API

本地额度 API 是只读服务，默认只监听 `127.0.0.1:8765`，供 Atmo Agent 开工前查询当前额度策略。

菜单栏 App 会随启动检查 `http://127.0.0.1:8765/health`：

- 如果返回 `service: "quota-app"`，App 复用已有 quota API。
- 如果端口空闲，App 会拉起 `engine/quota-api.mjs --port 8765`。
- 如果端口被其他服务占用，App 不会误复用，也不会强抢端口；可查看系统日志后手动处理。
- App 退出时只停止自己拉起的 quota API 子进程，不会停止外部已有服务。

手动兜底启动：

```bash
node engine/quota-api.mjs
```

接口：

- `GET http://127.0.0.1:8765/health`
- `GET http://127.0.0.1:8765/quota`

`/quota` 从 `usage.json` 读取 `limits`，同时输出 `5h` 和 `7d` 两个窗口：

- `windows.5h`: 控制当前任务是否继续推进、是否暂停运行中 Agent。
- `windows.7d`: 控制是否允许多 Agent 并发、是否启动新项目或高消耗任务。
- `overall_status`: `normal` / `tight` / `danger` / `exhausted` / `unknown`。
- `policy`: `正常运行` / `只允许P0/P1` / `不允许新Agent` / `只允许checkpoint` / `全部等额度`。
- `resume_after`: 建议恢复时间，通常比窗口 `reset_at` 晚 5 分钟。
- `should_pause_running_agents`: 为 `true` 时，运行中 Agent 应写 handoff 并进入暂停队列。
- `should_resume_paused_agents`: 只有两个窗口都为 `normal`，且已晚于可用 `resume_after` 后才为 `true`。

状态映射使用剩余额度百分比：

| 剩余额度 | 状态 | 策略 |
|---|---|---|
| `> 30%` | `normal` | 正常运行 |
| `> 15%` 且 `<= 30%` | `tight` | 只允许 P0/P1，避免低优先级和高消耗任务 |
| `> 5%` 且 `<= 15%` | `danger` | 不启动新 Agent，只允许 checkpoint / handoff |
| `<= 5%` | `exhausted` | 全部等额度 |
| 不可判断 | `unknown` | 保守处理，不启动高消耗任务 |

策略合成规则：

- `overall_status` 取 `5h` 和 `7d` 中更严重的状态，严重度为 `exhausted > danger > tight > unknown > normal`。
- 任一窗口 `exhausted` 时，整体 `policy = 全部等额度`，并暂停运行中 Agent。
- 任一窗口 `danger` 时，整体 `policy = 只允许checkpoint`。
- `5h` 为 `danger` / `exhausted` 时，运行中 Agent 应写 handoff 并进入暂停队列。
- `7d` 为 `tight` / `danger` / `exhausted` 时，不启动新并发 Agent 或新大任务。
- 数据源不可读或字段不可判断时，返回 `overall_status: "unknown"`，不返回 HTML、乱码或堆栈。

Mock 验证：

```bash
node engine/quota-api.mjs --port 8766 --mock /tmp/quota-normal.json
curl http://127.0.0.1:8766/quota
```

mock 文件可使用与 `usage.json` 相同的 `limits` 结构，例如：

```json
{
  "updatedAt": "2026-06-26T20:00:00.000Z",
  "limits": {
    "codex": {
      "fiveHour": { "pct": 70, "resetAt": "2026-06-26T21:00:00.000Z" },
      "sevenDay": { "pct": 20, "resetAt": "2026-07-03T21:00:00.000Z" }
    }
  }
}
```

隐私边界：额度 API 不读取对话正文，不提供写接口，不暴露 secret、token、cookie、账号密码或完整授权头。

## 打包 macOS App

```bash
./app/build.sh
```

打包结果：

```text
app/build/用量看板.app
```

`app/build/` 是构建产物，已在 `.gitignore` 中排除。

## 项目结构

```text
engine/  数据采集、归一化与本地服务
web/     用量看板页面
app/     macOS 菜单栏 App 外壳
```
