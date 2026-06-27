# Next Brief: v0.5 Quota Velocity Forecast

状态: Ready for Implementation

负责人: 产品经理

更新时间: 2026-06-27

当前下一阶段执行 brief 是:

- `docs/product/v0.5-brief.md`

## 本阶段目标

v0.5 把 Burn-down Forecast 从窗口平均预测升级为更接近实时的额度速度预测:

1. 最近 15 分钟 / 60 分钟限额百分比速度。
2. 窗口平均速度兜底。
3. quota API 输出最保守 ETA 和暂停策略。
4. 看板展示预测口径、百分比速度和 token/hour 辅助速度。
5. 数据陈旧时不误报完全安全。

## 必做

- `usage.json` 新增只读派生 `usageVelocity` 和 `limitSnapshots`。
- `engine/quota-api.mjs` 新增 `forecast`、`token_velocity`、`data_freshness` 字段。
- Burn-down Forecast 和限额卡展示 basis、pct/hour、15m token/hour。
- README 说明 v0.5 数据契约、策略和验证命令。
- 保持 `daily/projects/sessions/limits` 向后兼容。

## 非目标

- 不读取或展示对话正文。
- 不做绝对剩余 token quota。
- 不做语义分析。
- 不做自动任务分类。
- 不做机器学习预测。
- 不做人民币估算。
- 不重写 engine 核心计费、去重、UTC+8、cache、`<synthetic>` 过滤口径。

## 验收

按 `docs/product/v0.5-brief.md` 执行。

## Dev Agent 起点

建议先读:

1. `docs/product/v0.5-brief.md`
2. `engine/sources/claude.mjs`
3. `engine/sources/codex.mjs`
4. `engine/usage-data.mjs`
5. `web/index.html`
6. `engine/quota-api.mjs`
7. `README.md`
