# Handoff: 数据层+浏览器UI 完成 → 菜单栏打包

**日期**:2026-06-25
**前一阶段**:数据引擎(Claude Code + Codex 双源)+ 浏览器 UI + 双源限额
**下一阶段**:打包成常驻 macOS 菜单栏 App
**项目目录**:`/Users/m4air/ai额度app`
**git**:❌ 非 git 仓库(改动都直接在磁盘上,没有 commit 概念)
**怎么跑**:`node engine/usage-data.mjs --serve` → 浏览器开 `http://localhost:7799`(`.claude/launch.json` 已配 preview server)

> 这是「**给自己用**的工具」,不是面向市场的产品。核心原则:**数据层与界面层解耦**,通过一份统一 JSON 对接;架构留了「加新本地 CLI = 加一个 `engine/sources/*.mjs` 适配器」的口子。

---

## 一、已完成的能力(新窗口别重做)

### 数据引擎(零依赖 Node,数据源适配器架构)
- `engine/usage-data.mjs` — 编排器:跑所有源 → 合并 → 产 `usage.json` / `--serve`(:7799,JSON API + 托管 web/ + 每 60s 重算)
- `engine/sources/claude.mjs` — Claude Code 源:扫 `~/.claude/projects/**/*.jsonl`(只读),去重(`requestId|message.id`)、过滤 `<synthetic>`、UTC+8 切天
- `engine/sources/codex.mjs` — Codex 源:扫 `$CODEX_HOME`(默认 `~/.codex`)下 `sessions/**/rollout-*.jsonl`
- `engine/lib.mjs` — 共享工具(UTC+8 切天、连续日期、round4)
- `engine/prices.codex.json` — Codex/OpenAI 缓存价格表(从 LiteLLM 抓的 gpt-5* 价)

### 计费(已对账,别再动口径)
- ✅ 修了旧脚本的 bug:1h 缓存写入 = 输入价×2、5m = ×1.25、缓存读取 = ×0.1(旧脚本统一按 1.25× 低估了 1h)
- ✅ 美元 = 按 API 价折合的「等价价值」,**非真实账单**(UI/输出都标注)
- ✅ Codex 计价:`(input−cached)×in + cached×cachedIn + output×out`;模型从 `turn_context.model`;token 用 `token_count.last_token_usage` 求和(已验证 = 每轮增量、能处理累计重置)
- ✅ `codex-auto-review` 按 `gpt-5.5` **估价**(codex.mjs 的 `ALIASES`,JSON 标 `estimated:true`)

### 统一 JSON 契约
```
{ updatedAt, notice,
  tools: ["claude-code","codex"],
  models: [...按总量降序],
  pricing: { [model]: {tool,input,output,cacheWrite1h,cacheWrite5m,cacheRead,estimated} },
  limits: { "claude-code": {fiveHour,sevenDay,asOf}|null, "codex": {...}|null },
  daily: [ { date, byModel: { [model]: {tok,usd,tool,tokBreakdown,usdBreakdown} } } ] }
```
- `daily` 从最早有用量天 → 今天连续补齐(空天补 0)
- `tokBreakdown`/`usdBreakdown` 四类:输入/输出/写缓存/读缓存(四类相加 = tok)

### 浏览器 UI(`web/index.html`,零框架原生 JS)
把设计交接稿(原 dc-runtime/React 原型)剥成原生 JS,接 `/api/usage.json`,逐像素还原。已实现:
- ✅ 菜单栏小窗 + 弹窗 + 完整窗口
- ✅ 工具分页(全部 / Claude Code / Codex,默认全部,以后加 CLI 自动多一页)
- ✅ 时间段(当天/近7/近30默认/全部)+ Token/美元 切换
- ✅ Hero 四分类拆分(token & 美元两种)
- ✅ 柱状/折线、图例点击隐显、tooltip(已上移到柱状图**上方**不挡柱)
- ✅ 单价表(每模型各类 USD/1M)
- ✅ 限额卡跟工具分页走;百分比标「已用」;Codex 卡标「截至 HH:mm」(快照新鲜度)

### 双源限额(已全部点亮)
- ✅ **Codex**:从日志 `token_count.rate_limits`(primary=5h/secondary=7d,`resets_at` 是 unix 秒)取最新快照
- ✅ **Claude Code**:从 ClaudeMeter 的 `~/.claudemeter/usage.json` 读(`session_usage`/`weekly_usage` 的 `.utilization`)。**ClaudeMeter 已装好、已授权,卡已亮(当时 15%/25%)**

---

## 二、未完成 / 下一步

### ⏳ 主线:菜单栏打包(本次交接的目标)
把现在"跑命令 + 开浏览器"变成**真·常驻 macOS 菜单栏 App**(开机自启、点一下弹窗)。**第一件事是定技术栈**(见下方决策点)。

### ⏳ 字体本地化(打包时一并做)
现在浏览器版 JetBrains Mono 走 **Google Fonts CDN**。设计 README 明说成品要改**本地打包字体避免联网**——打包时处理。从 bundle 解出的 6 个 woff2 在 `/tmp/dc_asset_*_font_woff_`(临时,可能已清,需要时重新从设计包解)。

### ⏳ 上 GitHub(打包做完后的最后一步)
- 环境已就绪:`git`✅、`gh`✅ **已登录**(账号 `Ea12421`,scopes 含 `repo`/`workflow`)。
- **必须先 `.gitignore` 掉 `usage.json`** —— 它是用户真实用量数据(token/花费/限额),不能公开。
- 建议流程:`git init`(若还没)→ 补 README → `gh repo create`(可先 `--private`)→ push。**用户共识:等菜单栏打包做完再一次性推**,别推半成品。
- 用户机器上 `codex-auto-review`(Codex 的 GitHub PR 自动审查)已接通 → 上 GitHub 后开 PR 会被 Codex 自动 review。

### 可选(非必须)
- 按项目 `cwd` 归因视图(两源日志都有 cwd)
- ClaudeMeter 令牌过期需重新导入(用户已知)
- **用 `codex review` 做 QA**:`codex review --uncommitted`(需先 git init+commit)或交互式 `codex "review 这项目"`。用户机器 `codex` v0.142 已装。

---

## 三、关键决策(不显然的,别推翻)

- **数据/界面解耦**:这是 SPEC 的核心架构,两边只通过 JSON 对接,UI 绝不碰原始日志。
- **Codex 自解析 而非复用 @ccusage/codex**(用户拍板 B 方案):token 解析很干净(`last_token_usage`),真正会变的只有 OpenAI 价格 → 用可更新的本地价格表解决,换来零运行时依赖 + 离线 + 和 Claude 侧同构。
- **限额是「已用%」**,不是「剩余%」(Codex app / Claude app 显示剩余,两者相加=100%)。卡上已标「已用」。
- **Codex 限额是日志快照不是实时**:5h 窗口滚动快,闲置时会滞后,一用 Codex 就刷新 → 卡上加了「截至」时间。
- **ClaudeMeter 风险已和用户对齐**:MIT 开源、凭证进 Keychain → 凭证风险低;剩「非公开接口会失效」+「ToS 灰色地带(小概率)」,都波及不到核心功能。用户共识:**只在开 VPN 时让它跑,关 VPN 前先退掉**(菜单栏图标 → Quit)。

---

## 四、下阶段起点

### 入口 prompt(新窗口开场粘这个)
```
我接手「AI 用量看板」项目(/Users/m4air/ai额度app),从「菜单栏打包」阶段开始。
请先读 HANDOFF_数据层完成_TO_菜单栏打包.md 和你的 memory(claude-usage-dashboard / claudemeter-tool),
然后告诉我:你理解的当前状态、打包技术栈的推荐(及理由)、需要我确认的事。
先别写代码,plan-first。
```

### 🔑 第一个要拍板的决策:打包技术栈
- **Electron / Tauri**:可直接复用现成的 `web/index.html`(前端翻成 Tray + popover 窗口)。Tauri 更轻(系统 webview),Electron 更省心但重。
- **原生 Swift / SwiftUI**:体验最像系统(`NSStatusItem` + `NSPopover` + vibrancy),但前端要重写。
- 判断维度(用户是非程序员、要长期自己维护):优先「AI 好写 + 后期改起来方便 + 轻」。设计 README 的「技术选型建议」段落有详细对照,**先读它再推荐**。

### 打包阶段注意点
- 弹窗的「磨砂半透明」= 原生 vibrancy(`NSVisualEffectView`)/ Electron `vibrancy` / 前端兜底 `backdrop-filter: blur(40px)`
- 数据引擎(`engine/`)可直接复用 —— 打包时让它作为后台进程/子进程产 JSON,UI 消费
- 开机自启、字体本地化一并做

---

## 五、不要做的事

- ❌ 不要重写数据引擎 —— 已逐项验证(token 总量对账、usd 手算、隐私 grep 确认不读正文)
- ❌ 不要改计费口径 —— 已对账,改了会引入静默错误
- ❌ 不要动 ClaudeMeter 对接字段(`session_usage`/`weekly_usage.utilization`)—— 已对准它的真实导出格式
- ❌ 不要把限额从「已用%」改成「剩余%」—— 已和用户确认用已用%

---

## 六、补充上下文

- **活日志漂移**:`~/.claude/projects` 是活的,当前会话在写,两次扫描 token 总量会有微小差异 —— 正常,别当 bug。
- **隐私铁律**:两源都**只读记账字段,绝不读 `message.content` / 对话正文**。新增任何解析都要守住这条(已 grep 验证过)。
- **审批过的 plan 文件**:`~/.claude/plans/wiggly-forging-turtle.md`(范围 B 的原始计划)。
- **memory 已写**:`claude-usage-dashboard`(项目进度 + 口径坑)、`claudemeter-tool`(ClaudeMeter 仓库/字段)。新窗口开场会自动加载 MEMORY.md。
- **设计交接包原件**:`/Users/m4air/Downloads/Claude Code 用量看板.zip`;解出的设计源(含全部 CSS token + 图表逻辑)当时在 `/tmp/dc_template.html`(临时,需要时重新解)。
