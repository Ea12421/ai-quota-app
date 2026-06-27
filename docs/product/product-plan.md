# AI 用量看板 Product Plan

状态: Active

负责人: AI Dashboard - Product

更新时间: 2026-06-26

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

v0.1 已具备:

- macOS 菜单栏常驻入口、小弹窗、完整窗口。
- Claude Code / Codex 本地用量聚合。
- ClaudeMeter / Codex rate limit 的 5h / 7d 限额展示。
- 工具分页、时间段切换、Token / USD 切换。
- 模型级 token / USD / pricing 展示。
- 项目级聚合和项目筛选。
- `tokBreakdown` / `usdBreakdown`: input、output、cacheWrite、cacheRead。

当前缺口:

- 首屏还不能直接判断“会不会撞限额”。
- 总 token 仍容易掩盖 fresh token 与 cache read 的差异。
- 项目分布已有基础，但“今日谁在烧”还不够突出。
- session/window、上下文占用、错误重试和任务级成本还没有下钻层。

## 5. 长期路线图

### v0.2 Decision Layer

目标: 从“用了多少”变成“还能不能继续跑”。

必做:

- Burn-down Forecast: 基于 5h / 7d 限额百分比和 reset 时间给出 ETA / reset-first 结论。
- Real Cost View: 首屏突出 equivalent USD、fresh tokens、cache read share。
- Today's Top Projects: 展示今日 UTC+8 Top 项目，并可点击进入项目筛选。

验收: 首屏能在 10 秒内回答剩余额度风险、真实成本结构、今日主要消耗项目。

### v0.3 Drill-down Layer

目标: 从项目定位到具体窗口 / session。

候选功能:

- Project -> Session 列表。
- session 起止时间、调用数、token、fresh token、cache read share。
- 当前窗口上下文占用估算。
- 多窗口并行时区分哪个窗口在烧。

进入条件:

- v0.2 指标稳定，项目级榜单能解释大部分异常上涨。
- Dev 能在不破坏现有计费口径的前提下输出 session 粒度字段。

### v0.4 Diagnostic Layer

目标: 解释浪费、异常和高风险状态。

候选功能:

- 错误 / retry / overloaded / rate limit 相关浪费统计。
- 上下文卫生提醒: 何时 clear、handoff、开新窗口。
- 限额快照 stale 提醒。
- 异常上涨解释: 项目、模型、cache、重试四个维度拆因。

### v0.5 Analysis Layer

目标: 支持长期使用方式复盘和策略优化。

候选功能:

- 任务级成本与手动标签。
- 模型降级假设计算器。
- Agent 放大倍数趋势。
- 长周期周报 / 月报。

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

v0.2 Decision Layer 已完成并验收通过。下一阶段进入 v0.3 Drill-down Layer 的低风险第一步: Project Focus Drill-down。

本轮不直接做完整 session/window 数据模型，原因:

- 当前 `usage.json` 仍只有 `projects[]` 和 `daily[].byProject`，没有正式 session/window 输出。
- 强行做 session/window 会扩大 engine adapter 改动，增加隐私和数据口径风险。
- v0.2 验收已留下更明确的 v0.3 小切口: 默认隐藏 home-relative project path。

v0.3 第一轮推荐:

- 默认隐藏项目路径，降低截图分享时暴露个人项目结构的风险。
- 选中项目后展示 Project Focus 面板。
- 用现有 `daily.byProject` 和 `projects[]` 展示项目今日用量、当前区间用量、fresh/cache 结构和 Top 模型。

当前执行 brief: `docs/product/next-brief.md`

历史专项 brief:

- `docs/product/v0.2-brief.md`
- `docs/product/v0.3-brief.md`

## 8. 产品文档维护规则

- `product-plan.md`: 长期定位、路线图、优先级原则。
- `decision-log.md`: 明确决策、待确认问题、暂缓事项。
- `next-brief.md`: 下一阶段可直接交给 Dev Agent 的执行 brief。
- 专项 brief 可按版本保留，例如 `v0.2-brief.md`。
- 用户在聊天里确认的重要产品决定，必须沉淀到 `decision-log.md`，不能只留在对话上下文。
