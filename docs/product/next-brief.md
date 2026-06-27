# Next Brief: v0.4 Project Monitor + Usage Diagnostics

状态: Ready for Dev Agent

负责人: 产品经理

更新时间: 2026-06-26

当前下一阶段执行 brief 是:

- `docs/product/v0.4-brief.md`

## 本阶段目标

v0.4 继续把看板从“项目分布”推进到“项目监控和复盘诊断”:

1. 项目监控: 识别今日高消耗、升温、高缓存项目。
2. 项目视图增强: 在 Project Focus 中展示趋势、结构和状态摘要。
3. 任务级成本手动标签: 用户手动标注任务，按现有用量粗略复盘。
4. Agent 放大倍数趋势: 用元数据估算模型调用 / 用户回合趋势，缺数据时明确显示“数据不足”。
5. quota API 常驻: 菜单栏 App 启动后让 `127.0.0.1:8765` 默认可用。

## 必做

- Project Monitor。
- Project View Enhancement。
- Session / Task 数据基础。
- 手动任务标签 UI。
- Agent 放大倍数趋势。
- Quota API 常驻接入。

## 非目标

- 不读取或展示对话正文。
- 不做人民币估算。
- 不做自动任务分类。
- 不做语义分析。
- 不重写 engine 核心计费、去重、UTC+8、cache、`<synthetic>` 过滤口径。

## 验收

按 `docs/product/v0.4-brief.md` 执行。

## Dev Agent 起点

建议先读:

1. `docs/product/v0.4-brief.md`
2. `engine/sources/claude.mjs`
3. `engine/sources/codex.mjs`
4. `engine/usage-data.mjs`
5. `web/index.html`
6. `app/Sources/EngineProcess.swift`
7. `app/Sources/AppDelegate.swift`
8. `README.md`
