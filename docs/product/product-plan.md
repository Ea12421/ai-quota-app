# AI 用量看板 Product Plan

状态: Active

负责人: 产品经理

更新时间: 2026-06-27

## 1. 产品定位

AI 用量看板是一个本机运行的个人 AI usage decision dashboard。它不是企业 BI，也不是完整账单系统，而是帮助重度使用 Claude Code / Codex 的用户回答三个问题:

1. 我现在还能不能继续跑?
2. 今天主要消耗发生在哪里?
3. 哪些 token / 成本是真正需要关心的?

产品方向是从“账单展示”升级为“使用决策助手”: 先把现有本地日志和限额数据讲清楚，再逐步增加下钻、诊断和复盘能力。

## 2. 目标用户

主要用户:

- 本机重度使用 Claude Code / Codex 的个人开发者。
- 同时跑多个项目、多个窗口、多个 agent 的 AI product builder。
- 关心额度、等价成本、上下文和任务效率，但不希望上传日志或读取对话正文的用户。

非目标用户:

- 团队级财务 / procurement / FinOps 管理者。
- 需要多人权限、组织账单、云端同步的企业用户。
- 需要读取对话正文做语义分析或自动任务分类的用户。

## 3. 核心原则

- 本地优先: 数据只在本机读取、聚合和展示。
- 隐私优先: 不读取、不展示 `message.content` 或对话正文。
- 数据口径稳定: 继续尊重 UTC+8 按天、cache write 5m/1h、cache read、去重、`<synthetic>` 过滤、防路径泄露等已 vet 口径。
- 决策优先: 优先回答能影响当下行为的问题，而不是堆更多图表。
- 增量实现: 优先复用现有 `usage.json` 和 `web/index.html` 结构，不为一个展示需求重写 engine。
- 低维护成本: 不引入重依赖，不默认联网，不做难以长期维护的复杂 BI。

## 4. 当前能力基线

当前已具备:

- macOS 菜单栏常驻入口、小弹窗、完整窗口。
- Claude Code / Codex 本地用量聚合。
- ClaudeMeter / Codex rate limit 的 5h / 7d 限额展示。
- 工具分页、时间段切换、Token / USD 切换。
- 模型级 token / USD / pricing 展示。
- 项目级聚合和项目筛选。
- `tokBreakdown` / `usdBreakdown`: input、output、cacheWrite、cacheRead。
- Burn-down Forecast、Real Cost View、今日 Top 项目。
- Project Focus、Project Monitor、按项目自动用量。
- 任务标签 / 手动归因。
- Agent 使用趋势。
- 本地 quota API 和菜单栏 App 常驻接入。
- 区块折叠 / 展开。

当前缺口:

- Burn-down Forecast 第一版主要是窗口平均预测，不能充分反映最近 15 / 60 分钟突然加速。
- quota API 需要把短窗口速度、ETA basis 和数据陈旧状态输出给 Atmo gate。
- 完整 session/window 下钻、上下文占用、错误重试浪费统计还未产品化。
- 任务标签已经支持手动归因，但批量管理、导出和自动归因未做。

## 5. 长期路线图

### v0.2 Decision Layer

状态: 已完成。

目标: 从“用了多少”变成“还能不能继续跑”。

必做:

- Burn-down Forecast: 基于 5h / 7d 限额百分比和 reset 时间给出 ETA / reset-first 结论。
- Real Cost View: 首屏突出 equivalent USD、fresh tokens、cache read share。
- Today's Top Projects: 展示今日 UTC+8 Top 项目，并可点击进入项目筛选。

验收: 首屏能在 10 秒内回答剩余额度风险、真实成本结构、今日主要消耗项目。

### v0.3 Drill-down Layer

状态: 已完成低风险第一步；完整 session/window 下钻延后。

已完成:

- Project Focus Drill-down。
- 默认隐藏项目路径。
- 项目筛选联动。
- tooltip 边缘避让和项目分布空态修复。

延后:

- Project -> Session 列表。
- session 起止时间、调用数、token、fresh token、cache read share。
- 当前窗口上下文占用估算。

### v0.4 Project Monitor + Usage Diagnostics

状态: 已完成。

已完成:

- Project Monitor。
- Project View Enhancement。
- Session / Task 数据基础。
- 任务标签 / 手动归因。
- Agent 放大倍数趋势。
- quota API 常驻。
- 看板区块折叠 / 展开。

### v0.5 Quota Velocity Forecast

状态: 当前阶段。

目标: 把额度判断从窗口平均预测升级为短窗口速度预测。

必做:

- 最近 15 分钟 / 60 分钟限额百分比速度。
- 窗口平均速度兜底。
- token/hour 辅助速度。
- quota API 输出 `forecast`、`token_velocity`、`data_freshness`。
- Dashboard 展示预测口径、百分比速度和快照陈旧提示。

验收: 用户和 Atmo Agent 能判断当前是否继续、降速、checkpoint 或暂停。

### v0.6 Drill-down / Diagnostics

候选功能:

- 完整 session/window 下钻。
- 当前窗口上下文占用估算。
- 错误 / retry / overloaded / rate limit 浪费统计。
- 上下文卫生提醒: 何时 clear、handoff、开新窗口。
- 任务标签批量管理和导出。

### v0.7 Analysis Layer

候选功能:

- 模型降级假设计算器。
- 长周期周报 / 月报。
- 多任务复盘报表。

## 6. 功能优先级原则

P0:

- 能直接影响“继续跑 / 暂停 / 切项目 / 切工具”的决策。
- 可复用现有 JSON 字段，低风险实现。
- 不触碰隐私边界和已 vet engine 口径。

P1:

- 需要新增聚合字段，但不需要读取正文。
- 能明显提升定位能力，例如 session/window 下钻。
- 对数据正确性有明确验收办法。

P2:

- 偏复盘、策略模拟或长期趋势。
- 价值存在，但不影响基础看板决策。
- 可能需要更多产品讨论或数据建模。

暂不做:

- 读取对话正文做语义分析。
- 自动任务分类。
- 企业级 BI、多用户权限、云同步。
- 自动判断任务是否应从 Opus 降级到 Sonnet。
- 每秒全量扫描日志。
- live 汇率或联网价格服务。

## 7. 下一阶段推荐

v0.4 已完成并验收通过。下一阶段进入 v0.5 Quota Velocity Forecast。

本轮不直接做完整 session/window 数据模型，原因:

- 当前用户最关心的是额度快耗尽前的暂停和恢复判断。
- v0.2 的窗口平均 Burn-down 已有价值，但对短时间爆量不够敏感。
- session/window 下钻价值高，但对当前开工决策不如 velocity gate 直接。

v0.5 推荐:

- 新增 `usageVelocity` 和 `limitSnapshots` 派生输出。
- quota API 用 15m / 60m / window average 合成最保守 ETA。
- Dashboard 展示 basis、pct/hour、15m token/hour 和数据陈旧提示。

当前执行 brief: `docs/product/next-brief.md`

历史专项 brief:

- `docs/product/v0.2-brief.md`
- `docs/product/v0.3-brief.md`
- `docs/product/v0.4-brief.md`
- `docs/product/v0.5-brief.md`

## 8. 产品文档维护规则

- `product-plan.md`: 长期定位、路线图、优先级原则。
- `decision-log.md`: 明确决策、待确认问题、暂缓事项。
- `next-brief.md`: 下一阶段可直接交给 Dev Agent 的执行 brief。
- 专项 brief 可按版本保留，例如 `v0.2-brief.md`。
- 用户在聊天里确认的重要产品决定，必须沉淀到 `decision-log.md`，不能只留在对话上下文。
