// 数据源:Codex —— 扫 $CODEX_HOME(默认 ~/.codex,支持逗号分隔多目录)下
// sessions/**/rollout-*.jsonl(只读),按「天×模型」聚合 token 与等价美元。
//
// Codex 口径(已实测):
//  - token_count 事件的 info.last_token_usage 就是「本轮增量」(等于累计值的逐条差),
//    直接按事件求和即可,且能正确处理「累计中途重置」(求和不会出负数)。
//    缺 last_token_usage 时退化为「当前累计 − 上一条累计」(clamp ≥0)。
//  - total_tokens = input + output;cached_input 是 input 中命中缓存的子集;
//    reasoning_output 已含在 output 内。tok = input + output。
//  - 计价(OpenAI 三类价,来自本地缓存价格表 prices.codex.json,非硬编码):
//    usd = ((input − cached)*pin + cached*pCached + output*pout) / 1e6
//  - 模型名取该事件前最近的 turn_context.model;2025-09 前无计数的旧日志自动跳过。
// 隐私:绝不读取/打印对话正文。
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { dayKeyUTC8, round4 } from "../lib.mjs";

export const TOOL = "codex";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PRICE_FILE = path.join(__dirname, "..", "prices.codex.json");

function codexHomes() {
  const raw = process.env.CODEX_HOME;
  if (raw && raw.trim()) {
    return raw.split(",").map((s) => s.trim()).filter(Boolean);
  }
  return [path.join(process.env.HOME, ".codex")];
}

function loadPrices() {
  try {
    return JSON.parse(fs.readFileSync(PRICE_FILE, "utf8")).prices || {};
  } catch {
    return {};
  }
}

// Codex rate_limits → { fiveHour:{pct,resetAt}, sevenDay:{pct,resetAt} }
// primary≈5h(window_minutes 300)、secondary≈7d(10080);resets_at 是 unix 秒
function mapRateLimits(rl) {
  if (!rl) return null;
  const toEntry = (w) => {
    if (!w || w.used_percent == null) return null;
    return { pct: Math.round(w.used_percent), resetAt: w.resets_at ? new Date(w.resets_at * 1000).toISOString() : null };
  };
  let five = null;
  let seven = null;
  for (const w of [rl.primary, rl.secondary]) {
    if (!w || !w.window_minutes) continue;
    if (w.window_minutes <= 600) five = toEntry(w);
    else seven = toEntry(w);
  }
  if (!five && rl.primary) five = toEntry(rl.primary);
  if (!seven && rl.secondary) seven = toEntry(rl.secondary);
  if (!five && !seven) return null;
  return { fiveHour: five, sevenDay: seven };
}

export function collect() {
  const prices = loadPrices();
  const agg = {}; // day -> model -> {input, cached, output}
  const models = new Set();
  const unpriced = new Set();
  let filesWithTok = 0;
  let filesSkipped = 0;
  let latestRL = null; // 最新一条 rate_limits 快照(Codex 自带的 5h/7d 额度)
  const roots = [];

  // 别名/估价:Codex 内部模型不在价格表里时,按相近主力模型估算
  const ALIASES = { "codex-auto-review": "gpt-5.5" };
  function priceForModel(model) {
    if (prices[model]) return { p: prices[model], estimated: false };
    const stripped = model.replace(/-\d{4}-\d{2}-\d{2}$/, ""); // 去掉日期后缀
    if (prices[stripped]) return { p: prices[stripped], estimated: false };
    if (ALIASES[model] && prices[ALIASES[model]]) return { p: prices[ALIASES[model]], estimated: true };
    return null;
  }

  function walk(dir, files) {
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) walk(p, files);
      else if (/^rollout-.*\.jsonl$/.test(e.name)) files.push(p);
    }
  }

  function scanFile(file) {
    let lines;
    try {
      lines = fs.readFileSync(file, "utf8").split("\n");
    } catch {
      return;
    }
    let curModel = null;
    let prevTotal = null;
    let prevTotalKey = null;
    let hadTok = false;
    for (const line of lines) {
      if (!line) continue;
      let o;
      try {
        o = JSON.parse(line);
      } catch {
        continue;
      }
      if (o.type === "turn_context" && o.payload && o.payload.model) {
        curModel = o.payload.model;
        continue;
      }
      if (o.type === "event_msg" && o.payload && o.payload.type === "token_count") {
        if (o.payload.rate_limits) {
          const t = Date.parse(o.timestamp); // 用数值比时间,避免 ISO 字符串格式混用排错
          if (!Number.isNaN(t) && (!latestRL || t > latestRL.t)) {
            latestRL = { ts: o.timestamp, t, rl: o.payload.rate_limits };
          }
        }
        const info = o.payload.info;
        if (!info || !info.total_token_usage) continue;
        // 跳过与上一条完全相同的累计快照(日志会重复记同一快照),否则 last_token_usage 被重复累加(实测多算 ~27%)
        const tt = info.total_token_usage;
        const totalKey =
          (tt.input_tokens || 0) + "|" + (tt.cached_input_tokens || 0) + "|" + (tt.output_tokens || 0) + "|" + (tt.total_tokens || 0);
        if (totalKey === prevTotalKey) continue;
        prevTotalKey = totalKey;
        let lu = info.last_token_usage;
        if (!lu) {
          // 退化:当前累计 − 上一条累计;累计回退(=窗口重置)则把当前累计当新周期首个增量,别 clamp 成 0
          const cur = info.total_token_usage;
          const reset = prevTotal && (cur.total_tokens || 0) < (prevTotal.total_tokens || 0);
          if (prevTotal && !reset) {
            lu = {
              input_tokens: Math.max(0, (cur.input_tokens || 0) - (prevTotal.input_tokens || 0)),
              cached_input_tokens: Math.max(0, (cur.cached_input_tokens || 0) - (prevTotal.cached_input_tokens || 0)),
              output_tokens: Math.max(0, (cur.output_tokens || 0) - (prevTotal.output_tokens || 0)),
            };
          } else {
            lu = cur; // 首条 或 重置后:当前累计即本轮增量
          }
        }
        prevTotal = info.total_token_usage;

        const input = lu.input_tokens || 0;
        const cached = lu.cached_input_tokens || 0;
        const output = lu.output_tokens || 0;
        if (input === 0 && output === 0) continue;

        const model = curModel || "codex-unknown";
        const day = dayKeyUTC8(o.timestamp);
        if (!day) continue;

        models.add(model);
        if (!priceForModel(model)) unpriced.add(model);
        hadTok = true;

        (agg[day] || (agg[day] = {}));
        const slot = agg[day][model] || (agg[day][model] = { input: 0, cached: 0, output: 0 });
        slot.input += input;
        slot.cached += cached;
        slot.output += output;
      }
    }
    if (hadTok) filesWithTok += 1;
    else filesSkipped += 1;
  }

  for (const home of codexHomes()) {
    const sessions = path.join(home, "sessions");
    if (!fs.existsSync(sessions)) continue;
    roots.push(sessions);
    const files = [];
    walk(sessions, files);
    for (const f of files) scanFile(f);
  }

  // 四分类:输入(非缓存)/ 输出 / 写缓存(Codex 无,记 0)/ 读缓存(cached_input)
  function usdBreakdownOf(model, s) {
    const r = priceForModel(model);
    const p = r ? r.p : { input: 0, output: 0, cachedInput: 0 };
    const billedInput = Math.max(0, s.input - s.cached);
    return {
      input: (billedInput * p.input) / 1e6,
      output: (s.output * p.output) / 1e6,
      cacheWrite: 0,
      cacheRead: (s.cached * p.cachedInput) / 1e6,
    };
  }

  const entries = [];
  for (const date of Object.keys(agg)) {
    for (const [model, s] of Object.entries(agg[date])) {
      const fresh = Math.max(0, s.input - s.cached);
      const ub = usdBreakdownOf(model, s);
      entries.push({
        date,
        model,
        tok: s.input + s.output, // = fresh + cached + output
        usd: round4(ub.input + ub.output + ub.cacheRead),
        tokBreakdown: { input: fresh, output: s.output, cacheWrite: 0, cacheRead: s.cached },
        usdBreakdown: {
          input: round4(ub.input),
          output: round4(ub.output),
          cacheWrite: 0,
          cacheRead: round4(ub.cacheRead),
        },
      });
    }
  }

  const pricing = {};
  for (const m of models) {
    const r = priceForModel(m);
    pricing[m] = r
      ? { tool: TOOL, input: r.p.input, output: r.p.output, cacheWrite1h: null, cacheWrite5m: null, cacheRead: r.p.cachedInput, estimated: r.estimated }
      : { tool: TOOL, input: 0, output: 0, cacheWrite1h: null, cacheWrite5m: null, cacheRead: 0, estimated: false };
  }

  // Codex 自带的 5h/7d 额度(取最新快照)→ 归一成 {fiveHour, sevenDay, asOf}
  const limits = mapRateLimits(latestRL ? latestRL.rl : null);
  if (limits && latestRL) limits.asOf = latestRL.ts; // 快照时间(日志写下时),用于界面标"截至"

  return {
    tool: TOOL,
    entries,
    models: [...models],
    unpriced: [...unpriced],
    pricing,
    limits,
    source: roots.join(", ") || codexHomes().join(", ") + " (无 sessions 目录)",
    stats: { filesWithTok, filesSkipped },
  };
}
