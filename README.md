# AI 额度监控产品

一个本机运行的 AI 用量与额度看板，用来把 Claude Code 与 Codex 的本地使用记录整理成统一视图，并给人和 Atmo Agent Team 提供开工前额度判断。

它不是云端 SaaS，也不需要登录账号。核心原则是：只读本机用量数据、本地计算、本机展示、不提交真实用量数据。

## 安装和使用边界

这个仓库脱敏后仍然是可运行项目，不是空壳。需要注意的是：当前版本不是“只拷贝一个 `.app` 就能在任意机器独立运行”的发布包，它仍依赖仓库里的 `engine/` 和 `web/` 源码目录。

推荐给别人或给其他 AI 使用时，发整个仓库或 GitHub 链接，不要只发 `app/build/用量看板.app`。

### 最小依赖

- macOS。
- Node.js，建议用 Homebrew 安装到常见路径，例如 `/opt/homebrew/bin/node` 或 `/usr/local/bin/node`。
- 如果要打包菜单栏 App，需要 macOS Command Line Tools 里的 `swiftc`、`codesign`。
- Claude Code / Codex 本机日志。没有对应日志时不会崩，但看板会显示空数据或未知额度。
- Claude Code 的 5h / 7d 限额如果要点亮，依赖本机已有的 ClaudeMeter 导出；没有也可以使用其他用量能力。

### 从零运行

```bash
git clone https://github.com/Ea12421/ai-quota-app.git
cd ai-quota-app
node --check engine/usage-data.mjs engine/quota-api.mjs
node engine/usage-data.mjs --serve 7799
```

然后打开：

```text
http://127.0.0.1:7799/
```

### 打包并运行菜单栏 App

```bash
./app/build.sh
open app/build/用量看板.app
```

App 默认按这个相对结构找项目根目录：

```text
<项目目录>/app/build/用量看板.app
<项目目录>/engine/
<项目目录>/web/
```

所以如果把 `.app` 单独拖到 `/Applications`，它可能找不到 `engine/` 和 `web/`。当前建议保持 `.app` 在仓库的 `app/build/` 里运行。

如果确实要从其他位置启动，可以用环境变量指定项目根目录并直接运行二进制：

```bash
AI_QUOTA_APP_ROOT="/path/to/ai-quota-app" "/path/to/用量看板.app/Contents/MacOS/UsageBar"
```

这仍然要求 `/path/to/ai-quota-app` 里有 `engine/` 和 `web/`。

### 数据为空时怎么判断

- `usage.json` 不在 GitHub 里，第一次运行会在本机生成。
- 没有 Claude Code / Codex 日志时，`daily` 和 `projects` 可能为空。
- 没有限额快照时，quota API 会返回 `unknown`，这是保守降级，不是项目损坏。
- 如果 App 胶囊不显示数据，先确认数据服务能打开：`http://127.0.0.1:7799/api/usage.json`。

## 现在能做什么

### 1. macOS 菜单栏看板

位置：

- `app/`: macOS 菜单栏 App 外壳。
- `app/Sources/AppDelegate.swift`: App 生命周期、菜单、完整窗口入口、quota API 启动。
- `app/Sources/StatusPill.swift`: 菜单栏胶囊样式。
- `app/Sources/PopoverController.swift`: 弹窗 WebView。
- `app/Sources/MainWindowController.swift`: 完整窗口 WebView。
- `app/Sources/EngineProcess.swift`: 拉起/复用本地用量服务和 quota API。
- `app/Sources/UsageStore.swift`: 读取 `/api/usage.json` 并驱动菜单栏状态。

能力：

- 菜单栏常驻胶囊，显示当前最紧的 5h / 7d 额度。
- 左键打开弹窗，快速看 Claude Code / Codex 的额度和近 7 天用量。
- 菜单可打开完整窗口。
- 支持开机自启。
- App 启动时会确保本机 quota API 可用。

打包：

```bash
./app/build.sh
```

产物：

```text
app/build/用量看板.app
```

`app/build/` 是构建产物，已被 `.gitignore` 排除。

### 2. 完整用量看板 UI

位置：

- `web/index.html`: 完整 UI，原生 HTML/CSS/JS，无前端框架。

能力：

- 工具切换：全部 / Claude Code / Codex。
- 时间切换：当天 / 近 7 天 / 近 30 天 / 全部。
- 指标切换：Token / 美元。
- Burn-down Forecast：基于 5h / 7d 限额百分比、reset 时间、15m / 60m 短窗口速度和窗口平均速度做燃尽判断。
- Real Cost View：突出等价 USD、Fresh Tokens、Cache Read Share。
- Today's Top Project：显示今日最高消耗项目。
- Project Monitor：按项目聚合当前区间用量、成本、Fresh Tokens、Cache Read Share。
- Project Focus：选择项目后展示项目专属用量、Top Models、今日用量和区间表现。
- 今日 Top 项目：按 UTC+8 今日统计项目排行。
- 当前区间项目分布：展示所选时间段内项目分布。
- 任务标签 / 手动归因：用户可以手动创建任务标签，用本地筛选范围做粗略成本归因。
- Agent 使用趋势：在有可靠数据时展示 Agent 相关趋势；数据不足时明确显示不足，不造假。
- 每日用量图：柱状 / 折线切换，tooltip 已做边缘避让。
- 区块折叠：低频区块可展开/收起，状态保存在浏览器 `localStorage`。
- 单价表：展示各模型 USD / 百万 token 估算价。

UI 数据来源只来自本地 `/api/usage.json`，不直接读取 Claude / Codex 原始日志。

### 3. 本地数据引擎

位置：

- `engine/usage-data.mjs`: 主入口，聚合数据、生成 `usage.json`、提供本地 HTTP 服务。
- `engine/lib.mjs`: 通用工具，包括 UTC+8 切天、日期补齐、项目名脱敏等。
- `engine/sources/claude.mjs`: Claude Code 数据源适配器。
- `engine/sources/codex.mjs`: Codex 数据源适配器。
- `engine/prices.codex.json`: Codex / OpenAI 本地价格表。

能力：

- 只读本机 Claude Code 与 Codex 使用记录。
- 按天、模型、工具、项目聚合 token 与等价 USD。
- 支持 input / output / cache write / cache read 四类拆分。
- 支持项目归因，默认展示脱敏项目名，不暴露完整本机路径。
- 支持 5h / 7d 限额快照。
- 支持 `limitSnapshots` 和 `usageVelocity` 派生输出，用于短窗口额度速度预测。
- 输出统一 JSON，供 `web/` 和 `app/` 使用。

手动启动数据服务：

```bash
node engine/usage-data.mjs --serve 7799
```

访问：

```text
http://127.0.0.1:7799/
http://127.0.0.1:7799/api/usage.json
```

生成一次静态数据：

```bash
node engine/usage-data.mjs
```

生成的 `usage.json` 包含真实 token、等价金额和额度百分比，属于个人数据，已被 `.gitignore` 排除，不应提交到 GitHub。

### 4. 本地额度 API

位置：

- `engine/quota-api.mjs`: 本地只读 quota API。
- `docs/product/quota-api-brief.md`: quota API 产品与验收说明。

默认接口：

```text
GET http://127.0.0.1:8765/health
GET http://127.0.0.1:8765/quota
```

手动启动：

```bash
node engine/quota-api.mjs
```

它会读取本地 `usage.json` 的 `limits`、`limitSnapshots` 和 `usageVelocity` 字段，输出 5h / 7d 双窗口策略：

- `windows.5h`: 判断当前能否继续推进、是否启动新 Agent、是否需要暂停运行中 Agent。
- `windows.7d`: 判断是否允许多 Agent 并发、新项目、大任务。
- `overall_status`: `normal` / `tight` / `danger` / `exhausted` / `unknown`。
- `policy`: `正常运行` / `只允许P0/P1` / `不允许新Agent` / `只允许checkpoint` / `全部等额度`。
- `safe_to_start_agent`: 是否允许启动新 Agent。
- `safe_to_start_heavy_task`: 是否允许长任务或高消耗任务。
- `should_pause_running_agents`: 是否要求运行中 Agent 写 handoff 并暂停。
- `should_resume_paused_agents`: 是否允许 Coordinator 恢复暂停队列。
- `resume_after`: 建议恢复时间，通常比 `reset_at` 晚几分钟。
- `windows.*.forecast`: 额度速度预测，包含 basis、pct/hour、ETA、是否会早于 reset 耗尽。
- `windows.*.token_velocity`: 最近 15m / 60m token/hour 辅助速度，不代表绝对剩余 token。
- `windows.*.data_freshness`: `fresh` / `stale` / `unknown`，用于避免陈旧快照误报安全。

v0.5 的预测口径：

1. 优先从 rate limit 百分比快照计算最近 15 分钟速度。
2. 再计算最近 60 分钟速度。
3. 样本不足时回退窗口平均速度。
4. 取最保守的百分比速度作为 ETA basis。
5. token/hour 只做辅助解释，不换算成“还能用多少 token”。

状态合成规则：

| 剩余额度 | 状态 | 策略 |
|---|---|---|
| `> 30%` | `normal` | 正常运行 |
| `> 15%` 且 `<= 30%` | `tight` | 只允许 P0/P1，减少低优先级任务 |
| `> 5%` 且 `<= 15%` | `danger` | 不启动新 Agent，只允许 checkpoint / handoff |
| `<= 5%` | `exhausted` | 全部等额度 |
| 不可判断 | `unknown` | 保守处理，不启动高消耗任务 |

`overall_status` 取 5h 和 7d 中更严重的状态，严重度为：

```text
exhausted > danger > tight > unknown > normal
```

mock 验证：

```bash
node engine/quota-api.mjs --port 8766 --mock /tmp/quota-normal.json
curl http://127.0.0.1:8766/quota
```

mock 文件示例：

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

### 5. 产品文档

位置：

- `docs/product/product-plan.md`: 产品路线与阶段目标。
- `docs/product/decision-log.md`: 产品决策记录。
- `docs/product/next-brief.md`: 下一阶段入口。
- `docs/product/v0.2-brief.md`: Burn-down Forecast、Real Cost View、Today Top Project。
- `docs/product/v0.3-brief.md`: Project Focus Drill-down。
- `docs/product/v0.3-defect-brief.md`: tooltip 遮挡和项目分布空态修复 brief。
- `docs/product/v0.4-brief.md`: Project Monitor、任务标签、Agent 趋势、quota API 常驻。
- `docs/product/quota-api-brief.md`: 本地额度 API 需求与验收标准。

这些文档是给后续 Dev Agent / Review Agent / 人类维护者看的，不包含真实用量数据。

## 数据流

```text
Claude Code logs      Codex logs
       │                 │
       ▼                 ▼
engine/sources/*.mjs  只读解析用量字段
       │
       ▼
engine/usage-data.mjs  聚合、脱敏、生成统一 usage.json
       │
       ├── web/index.html                 完整看板 UI
       ├── app/Sources/UsageStore.swift   菜单栏胶囊状态
       └── engine/quota-api.mjs           Atmo Agent quota gate
```

## 统一数据契约

`usage.json` 的核心结构：

```json
{
  "updatedAt": "ISO time",
  "tools": ["claude-code", "codex"],
  "models": [],
  "pricing": {},
  "limits": {
    "claude-code": {
      "fiveHour": {},
      "sevenDay": {},
      "asOf": "ISO time"
    },
    "codex": {
      "fiveHour": {},
      "sevenDay": {},
      "asOf": "ISO time"
    }
  },
  "usageVelocity": {
    "windows": {
      "15m": { "tokPerHour": 0, "usdPerHour": 0, "modelCallCount": 0, "byTool": {} },
      "60m": { "tokPerHour": 0, "usdPerHour": 0, "modelCallCount": 0, "byTool": {} }
    }
  },
  "limitSnapshots": [],
  "projects": [],
  "daily": []
}
```

重要约定：

- `daily[].byModel`: 每天按模型聚合。
- `daily[].byProject`: 每天按项目聚合。
- `projects[]`: 当前可选项目列表，项目路径默认脱敏。
- `tokBreakdown`: input / output / cache write / cache read。
- `usdBreakdown`: input / output / cache write / cache read 的等价 USD。
- `usageVelocity`: 15m / 60m token/hour 聚合，只输出派生统计。
- `limitSnapshots`: 最近限额百分比快照，用于 quota API 和 Burn-down 的短窗口预测。
- 价格是按本地价格表折算的等价值，不等于真实账单。

## 隐私与安全边界

本项目默认只在本机使用。

明确不会做：

- 不读取或展示对话正文。
- 不上传本机日志。
- 不提供写接口。
- 不暴露 secret、token、cookie、账号密码或完整授权头。
- 不把真实 `usage.json` 提交到 GitHub。
- 不把本地多 Agent 协作记录 `.agent-team/` 提交到 GitHub。
- 不把 macOS build 产物 `app/build/` 提交到 GitHub。

`.gitignore` 已排除：

```text
usage.json
.agent-team/
node_modules/
app/build/
*.log
```

## 给后续 AI / 维护者的修改入口

先判断你要改哪一层：

| 目标 | 主要文件 | 注意事项 |
|---|---|---|
| 改 UI 展示、折叠、图表、筛选 | `web/index.html` | 不直接读原始日志，只消费 `/api/usage.json` |
| 改 Claude Code 解析 | `engine/sources/claude.mjs` | 不读取正文，不改已验证的 token 分类口径 |
| 改 Codex 解析 | `engine/sources/codex.mjs` | 注意累计快照去重、reset、cache input 口径 |
| 改统一 JSON 输出 | `engine/usage-data.mjs` | 保持 `daily`, `projects`, `limits` 向后兼容 |
| 改 quota API | `engine/quota-api.mjs` | 保持只监听 `127.0.0.1`，失败返回 `unknown` JSON |
| 改菜单栏行为 | `app/Sources/*.swift` | 不硬编码本机路径，优先从 bundle 或环境变量推导 |
| 改产品范围 | `docs/product/*.md` | brief 要写清楚必做、延后、验收标准 |

推荐先读：

1. `README.md`
2. `docs/product/product-plan.md`
3. `docs/product/next-brief.md`
4. 目标功能对应的 `docs/product/*-brief.md`
5. 目标代码文件

## 本地验证命令

语法检查：

```bash
node --check engine/lib.mjs engine/sources/claude.mjs engine/sources/codex.mjs engine/usage-data.mjs engine/quota-api.mjs
```

内联脚本编译检查：

```bash
node -e "const fs=require('fs');const html=fs.readFileSync('web/index.html','utf8');const scripts=[...html.matchAll(/<script>([\\s\\S]*?)<\\/script>/g)].map(m=>m[1]);for(const s of scripts)new Function(s);console.log('inline scripts ok',scripts.length);"
```

生成数据：

```bash
node engine/usage-data.mjs
```

启动完整看板：

```bash
node engine/usage-data.mjs --serve 7799
```

检查 quota API：

```bash
node engine/quota-api.mjs --port 8765
curl http://127.0.0.1:8765/health
curl http://127.0.0.1:8765/quota
```

打包 App：

```bash
./app/build.sh
```

提交前检查：

```bash
git diff --check
git status --short
git ls-files .agent-team usage.json app/build
```

最后一条命令正常应无输出，表示这些本地/隐私文件没有进入 Git。

## 当前版本重点

当前主线已经做到：

- v0.2: Burn-down Forecast、Real Cost View、今日 Top 项目。
- v0.3: Project Focus Drill-down、项目筛选联动、tooltip 边缘避让。
- v0.4: Project Monitor、项目视图增强、任务标签 / 手动归因、Agent 使用趋势、quota API 常驻。
- v0.5: Quota Velocity Forecast，基于 15m / 60m / window average 的最保守额度速度预测。
- 最新 UI 增强: 完整窗口多个区块可折叠，状态本地持久化。

后续可继续做：

- 更完整的 session/window 下钻。
- 更可靠的 Agent 趋势数据源。
- 任务标签批量管理和导出。
- quota API 与外部 Coordinator 工具的更深接入。
- 错误 / retry / overloaded 浪费统计。
