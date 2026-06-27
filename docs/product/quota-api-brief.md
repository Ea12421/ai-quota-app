# 本地额度 API Brief

更新时间: 2026-06-26T13:56:21-07:00

## 背景

Atmo Agent Team 需要在开工前判断当前 AI 额度是否足够，避免额度耗尽后长任务丢状态。当前项目已有本地用量和限额数据引擎，但其主要面向看板 UI；本任务新增一个稳定、只读、低风险的本地 HTTP API，供 Codex / Atmo Agent 在启动前查询。

## v1 目标

提供本机只读 API：

- `GET http://127.0.0.1:8765/health`
- `GET http://127.0.0.1:8765/quota`

必须同时监控两个额度窗口：

- `5h`: 控制当前能不能继续推进，是否启动新 Agent，是否执行长任务、重验证、大量文件读取。
- `7d`: 控制是否允许多 Agent 并发，是否开启新项目 / 大任务，整体节奏是否需要降速。

API 必须：

- 只监听 `127.0.0.1`
- 返回 JSON
- 不暴露 secret、token、cookie、账号、完整授权头
- 不要求 Agent 登录
- 不做写操作
- 数据源失败时返回 `overall_status: "unknown"` 且两个窗口尽量保守，不能返回 HTML、乱码或抛出未处理异常
- 响应尽量在 1 秒内完成

## 建议实现

新增独立脚本：

- `engine/quota-api.mjs`

推荐原因：

- 与现有 `engine/usage-data.mjs --serve 7799` 解耦，避免影响当前看板服务。
- 不引入依赖，使用 Node 内置 `http` / `fs`。
- 只读现有数据或复用现有 limits 口径，接口失败时保守返回 `unknown`。

可选数据来源优先级：

1. 优先读取现有 `usage.json` 的 `limits` 和 `updatedAt`。
2. 如果 `usage.json` 不存在或不可解析，直接返回 `unknown`。
3. 本期不要为此重构 `engine/usage-data.mjs` 导出结构。
4. 不直接读取账号 secret、cookie、token 或授权头。
5. 为验收模拟提供只读 mock 输入，例如 `node engine/quota-api.mjs --mock /tmp/quota-normal.json`；mock 只能在本地启动时读取文件，API 不提供写接口。

## `/health` 响应

```json
{
  "ok": true,
  "service": "quota-app",
  "updated_at": "2026-06-26T13:40:00-07:00"
}
```

## `/quota` 响应

```json
{
  "overall_status": "danger",
  "overall_status_cn": "危险",
  "policy": "只允许checkpoint",
  "windows": {
    "5h": {
      "status": "danger",
      "status_cn": "危险",
      "remaining_percent": 12,
      "remaining_text": "5小时额度剩余约 12%",
      "reset_at": "2026-06-26T18:00:00-07:00",
      "resume_after": "2026-06-26T18:05:00-07:00",
      "safe_to_start_agent": false,
      "safe_to_start_heavy_task": false,
      "should_pause_running_agents": true
    },
    "7d": {
      "status": "tight",
      "status_cn": "紧张",
      "remaining_percent": 38,
      "remaining_text": "7天额度剩余约 38%",
      "reset_at": "2026-07-03T00:00:00-07:00",
      "resume_after": "2026-07-03T00:05:00-07:00",
      "safe_to_start_agent": false,
      "safe_to_start_heavy_task": false,
      "should_pause_running_agents": false
    }
  },
  "safe_to_start_agent": false,
  "safe_to_start_heavy_task": false,
  "should_pause_running_agents": true,
  "should_resume_paused_agents": false,
  "next_check_at": "2026-06-26T17:55:00-07:00",
  "message": "5小时额度危险，暂停新任务，只允许 checkpoint 和 handoff",
  "updated_at": "2026-06-26T14:10:00-07:00",
  "source": "quota-app"
}
```

## 字段约定

- `overall_status`: 只能是 `normal`, `tight`, `danger`, `exhausted`, `unknown`
- `overall_status_cn`: 对应 `正常`, `紧张`, `危险`, `耗尽`, `未知`
- `policy`: 只能是 `正常运行`, `只允许P0/P1`, `不允许新Agent`, `只允许checkpoint`, `全部等额度`
- `windows.5h.status` / `windows.7d.status`: 只能是 `normal`, `tight`, `danger`, `exhausted`, `unknown`
- `windows.*.status_cn`: 对应 `正常`, `紧张`, `危险`, `耗尽`, `未知`
- `windows.*.remaining_percent`: 不知道填 `null`
- `windows.*.remaining_text`: 给人看的窗口额度说明
- `windows.*.reset_at`: 额度预计恢复时间，不知道填 `null`
- `windows.*.resume_after`: 建议恢复时间，不知道填 `null`，通常比 `reset_at` 晚 3-5 分钟
- `windows.*.safe_to_start_agent`: 单窗口是否允许启动新 Agent
- `windows.*.safe_to_start_heavy_task`: 单窗口是否允许长任务 / 高消耗任务
- `windows.*.should_pause_running_agents`: 单窗口是否建议暂停运行中 Agent
- `windows.*.forecast`: v0.5 新增，额度速度预测结果。
- `windows.*.forecast.basis`: `15m`, `60m`, `window_avg`, `insufficient`。
- `windows.*.forecast.basis_cn`: 给人看的预测口径。
- `windows.*.forecast.pct_per_hour`: 当前采用口径下的限额百分比速度。
- `windows.*.forecast.eta_minutes`: 预计耗尽分钟数，不可判断为 `null`。
- `windows.*.forecast.eta_text`: 给人看的 ETA 文案。
- `windows.*.forecast.will_exhaust_before_reset`: 是否预计早于 reset 耗尽。
- `windows.*.forecast.risk_reason`: 当前判断原因。
- `windows.*.token_velocity`: 最近 15m / 60m token/hour 辅助速度，不代表绝对剩余 token。
- `windows.*.data_freshness`: `fresh`, `stale`, `unknown`。
- `safe_to_start_agent`: 是否允许启动新 Agent
- `safe_to_start_heavy_task`: 是否允许长任务 / 高消耗任务
- `should_pause_running_agents`: 是否要求运行中 Agent 写 handoff 并进入暂停队列
- `should_resume_paused_agents`: 是否允许 Coordinator 从暂停队列恢复任务
- `next_check_at`: 建议下一次检查时间
- `message`: 给 Coordinator 和人看的策略说明
- `source`: 固定 `quota-app`

## 状态映射

输入数据来自现有 `limits`。现有 `limits` 多半是 used percent，所以需换算：

- `5h.remaining_percent = 100 - limits.*.fiveHour.pct`
- `7d.remaining_percent = 100 - limits.*.sevenDay.pct`
- 如果同时存在多个工具窗口，窗口状态取同一窗口中最严重的工具结果。
- `reset_at` 取对应最严重工具窗口的 `resetAt`。

单窗口推荐阈值：

| remaining_percent | status | status_cn | policy | safe_to_start_agent | safe_to_start_heavy_task | message |
|---|---|---|---|---|---|---|
| `null` | `unknown` | `未知` | `只允许P0/P1` | `true` | `false` | `额度状态未知，保守处理` |
| `> 30` | `normal` | `正常` | `正常运行` | `true` | `true` | `额度充足` |
| `> 15` 且 `<= 30` | `tight` | `紧张` | `只允许P0/P1` | `true` | `false` | `额度偏紧，减少低优先级任务` |
| `> 5` 且 `<= 15` | `danger` | `危险` | `不允许新Agent` | `false` | `false` | `额度危险，只允许关键任务和 checkpoint` |
| `<= 5` | `exhausted` | `耗尽` | `只允许checkpoint` | `false` | `false` | `额度接近耗尽，不启动新任务` |

如果数据源读取失败、JSON 解析失败、无 `limits` 或限额字段不可判断，则返回 `unknown`。

## v0.5 速度预测规则

1. 优先使用 `limitSnapshots` 中同一工具、同一窗口、同一 reset 周期的最近 15 分钟百分比差值计算 `%/h`。
2. 其次使用最近 60 分钟百分比差值。
3. 如果短窗口样本不足，使用 `limits[tool][window].pct + resetAt` 推导窗口平均速度。
4. 取 `%/h` 最大的口径作为最保守 ETA basis。
5. `usageVelocity` 的 token/hour 只用于解释最近是否爆量，不换算成绝对剩余 token。
6. 快照明显陈旧时，`data_freshness = stale`，不允许误报完全安全的 heavy task。

## 策略合成规则

状态严重度：

`exhausted > danger > tight > unknown > normal`

合成规则：

1. `overall_status` 取 `5h` 和 `7d` 中更严重的状态。
2. 任一窗口为 `exhausted`: `policy = 全部等额度`。
3. 任一窗口为 `danger`: `policy = 只允许checkpoint`，不允许开新 Agent。
4. 任一窗口为 `tight`: 不允许低优先级任务和新并发 Agent。
5. 两个窗口都 `normal`: `policy = 正常运行`。
6. 任一窗口 `unknown`: 保守处理，不允许高消耗任务。
7. `5h` 比 `7d` 更直接控制当前任务是否暂停；`7d` 主要控制并发和大任务节奏。

## 暂停与恢复规则

- `5h.status` 为 `danger` 或 `exhausted` 时，`should_pause_running_agents = true`。
- `7d.status` 为 `danger` 或 `exhausted` 时，不允许新并发 Agent，不允许新项目 / 大任务；是否暂停运行中 Agent 由 `5h` 决定。
- 任一窗口 `exhausted` 时，全局 `should_pause_running_agents = true`，`safe_to_start_agent = false`，`safe_to_start_heavy_task = false`。
- `should_resume_paused_agents = true` 只有在两个窗口均 `normal`，且当前时间晚于所有可用 `resume_after` 后才允许。
- 如果刚刷新但数据不稳定，继续返回 `unknown` 或 `tight`，不要误报 `normal`。
- 如果 `5h` 已恢复但 `7d` 仍危险，仍然不能高并发。
- 如果 `7d` 正常但 `5h` 危险，当前任务仍要暂停。

## Atmo Coordinator 使用规则

1. 开新 Agent 前查 `/quota`。
2. Agent 开始重任务前查 `/quota`。
3. 长任务每个阶段开始前查 `/quota`。
4. 如果 `should_pause_running_agents = true`，要求运行中的 Agent 写 handoff 接力包，并进入暂停队列。
5. 如果 `should_resume_paused_agents = true`，Coordinator 才能从暂停队列恢复任务。
6. 恢复时不要一次拉起所有 Agent，建议一次恢复 1-2 个，避免刚恢复又打满额度。
7. API 不可用或状态 `unknown` 时，Atmo 只能把额度状态记为“未知”，不能破坏项目状态。

## README 要求

新增或更新 README，说明：

- 默认端口 `8765`
- 本地启动命令，例如 `node engine/quota-api.mjs`
- `/health` 和 `/quota` 字段说明
- `5h` / `7d` 窗口说明
- 状态映射、策略合成规则、暂停与恢复规则
- mock / 模拟验证方式
- 隐私边界：不读正文、不暴露 secret/token/cookie/账号敏感信息

## 验收标准

1. `curl http://127.0.0.1:8765/health` 返回可解析 JSON。
2. `curl http://127.0.0.1:8765/quota` 返回可解析 JSON。
3. 能模拟 `5h` 和 `7d` 的 `normal` / `tight` / `danger` / `exhausted` / `unknown` 状态。
4. `danger` / `exhausted` 状态下明确给出暂停策略。
5. `normal` 恢复后能给出 `should_resume_paused_agents = true`。
6. quota 响应不包含 token、cookie、账号密码、完整授权头。
7. 服务挂掉或数据源失败时，返回 `overall_status: "unknown"`，不要返回乱码或 HTML。
8. 有 README 说明端口、字段、状态映射、策略合成规则和本地启动命令。

## 明确不做

- 不新增登录流程。
- 不做写操作。
- 不读取或展示对话正文。
- 不引入外部依赖。
- 不接公网、不监听 `0.0.0.0`。
- 不重构现有 UI。

## 任务建议

- 开发任务: `T-QUOTA-001`
- Review 任务: `T-QUOTA-002`
- 产品验收: `T-QUOTA-003`

当前额度约 10%，本任务先排队。建议在 2026-06-26T15:07:00-07:00 后再启动开发和 Review。
