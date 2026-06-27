# AI 用量看板 Decision Log

状态: Active

负责人: 产品经理

更新时间: 2026-06-26

## 使用规则

本文件记录产品方向、范围、口径和开放问题。用户后续讨论中一旦形成明确结论，应追加到这里，避免只存在聊天上下文中。

## 已定决策

### D-001: Product Agent 接管长期产品规划

日期: 2026-06-26

决策: Product Agent 负责长期产品规划、需求方向、功能取舍、验收标准和下一阶段 brief。

影响:

- Product Agent 可以重新排序下一阶段优先级，但不写代码、不改 engine、不重构 UI。
- 产品讨论需要沉淀到 `docs/product/*`。
- `.agent-team/team-status.md` 仍由 Coordinator 统一维护。

### D-002: 隐私边界不变

日期: 2026-06-26

决策: 新功能不读取、不展示 `message.content` 或对话正文。

影响:

- 任务自动分类、语义分析、正文摘要不进入近期路线。
- 后续功能只能使用 usage、timestamp、cwd、sessionId、error、rate limit 等非正文记账字段。

### D-003: 不重写已 vet 的 engine 核心口径

日期: 2026-06-26

决策: 新需求不得要求重写 `engine/` 核心计费、去重、UTC+8 按天、cache write 5m/1h、cache read、`<synthetic>` 过滤和防路径泄露口径。

影响:

- 下一阶段优先做可由现有 `usage.json` 推导的功能。
- 若必须新增字段，优先做低风险摘要字段，不改变原总账。

### D-004: 下一阶段仍推荐 v0.2 Decision Layer

日期: 2026-06-26

决策: 下一阶段推荐继续聚焦 Burn-down Forecast、Real Cost View、Today's Top Projects。

理由:

- 三项都直接回答“能不能继续跑、真实成本是什么、哪个项目在烧”。
- 均能基于现有数据结构实现，风险低。
- session/window 和上下文监控价值高，但需要更谨慎的数据建模，放到 v0.3。

### D-005: Burn-down Forecast 使用百分比窗口预测

日期: 2026-06-26

决策: v0.2 不展示剩余 token 绝对值，只展示基于 `pct + resetAt` 的相对燃尽预测。

理由:

- 当前限额数据只有百分比和 reset 时间，没有明确绝对 quota。
- 编造剩余 token 会误导用户。

影响:

- 文案必须标注这是“限额百分比预测”。
- 显示 ETA / reset-first / unknown，不显示“还能用 X token”。

### D-006: Real Cost View 以 equivalent USD 和 fresh tokens 为核心

日期: 2026-06-26

决策: `total token` 不再作为唯一成本解释指标。v0.2 首屏需要突出 equivalent USD、fresh tokens、cache read share。

理由:

- cache read 会让 token 数显得大，但成本和 fresh generation 不同。

影响:

- `usd` 必须继续标注为 API 价折合的等价价值，非真实账单。
- Codex `cacheWrite = 0` 属正常口径。

### D-007: v0.2 接受 project 归因数据层改动

日期: 2026-06-26

决策: v0.2 接受 `engine/` 中 project 归因、路径脱敏显示、`projects[]` / `daily[].byProject` 派生输出。

理由:

- Today's Top Projects 和项目筛选需要稳定项目维度。
- 质量评审已验证该改动未改变核心计费、去重、UTC+8、cache 和正文读取边界。
- 开发工程师已补充说明实际改动文件和未改变口径。

影响:

- 本次不要求回滚 `engine/` project 归因改动。
- 后续仍不得借此重写已 vet 的核心计费/去重/cache 逻辑。

### D-008: home-relative path v0.2 接受，v0.3 优化

日期: 2026-06-26

决策: v0.2 接受 `~/...` home-relative path 展示；v0.3 建议默认只显示项目名，path 放到 hover/title、详情态或调试态。

理由:

- `~/...` 不违反 raw HOME 绝对路径禁止要求。
- 但截图或分享时仍可能透露个人项目结构。

### D-009: v0.3 第一轮做 Project Focus Drill-down

日期: 2026-06-26

决策: v0.3 第一轮不直接做完整 session/window 数据模型，先做 Project Focus Drill-down。

理由:

- 当前 `usage.json` 没有正式 session/window 输出。
- 用户要测试多 Agent 协作稳定性，适合选择中等复杂度、可验证、低风险的小版本。
- Project Focus 能解决 v0.2 留下的路径展示隐私问题，并用现有数据提供项目级下钻价值。

影响:

- 本轮 Dev 优先只改 `web/index.html`。
- 不新增依赖。
- 不读取或展示对话正文。
- session/window 下钻和当前窗口上下文监控继续延后。

## 待确认问题

### Q-001: 是否在 v0.2 显示 RMB 估算?

当前判断: 延后。

原因: live 汇率需要联网，固定汇率需要用户确认口径。下一阶段先保留 USD equivalent。

### Q-002: 是否提前做当前窗口上下文监控?

当前判断: 延后到 v0.3。

原因: 价值高，但需要 session/window 粒度数据和更谨慎的上下文占用估算。v0.2 先做决策层。

### Q-003: 最近 1h / 3h token velocity 是否进入 v0.2?

当前判断: 不作为必做。

原因: 当前统一 entries 已按天聚合。若做真实小时速度，需要保留 timestamp 或新增小时聚合，不能为 v0.2 阻塞。

### Q-004: Product Agent 是否需要维护版本化专项 brief?

当前判断: 是。`next-brief.md` 是活动执行 brief，`v0.2-brief.md` 作为版本快照保留。

## 暂缓事项

- session/window 下钻。
- 当前窗口上下文监控。
- 错误 / retry 浪费统计。
- 模型降级省钱假设计算器。
- 任务级成本和手动标签。
- 企业 BI、云同步、多用户权限。
- 读取正文的语义分析和自动任务分类。
