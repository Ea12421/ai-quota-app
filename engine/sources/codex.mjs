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
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";
import { dayKeyUTC8, projectOf, round4 } from "../lib.mjs";

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

function limitPoolKey(rl) {
  return String(rl?.limit_id || rl?.limit_name || "codex");
}

function chooseLimitEntry(pools, field) {
  let best = null;
  for (const pool of pools) {
    const entry = pool.snapshot?.[field];
    if (!entry || entry.pct == null) continue;
    if (!best || entry.pct > best.entry.pct || (entry.pct === best.entry.pct && pool.t > best.t)) {
      best = { entry, ts: pool.ts, t: pool.t };
    }
  }
  return best;
}

function conservativeLimitsFromPools(latestByPool) {
  const pools = [...latestByPool.values()]
    .map((pool) => ({ ...pool, snapshot: mapRateLimits(pool.rl) }))
    .filter((pool) => pool.snapshot);
  if (!pools.length) return null;
  const five = chooseLimitEntry(pools, "fiveHour");
  const seven = chooseLimitEntry(pools, "sevenDay");
  if (!five && !seven) return null;
  const asOfMs = Math.max(five?.t || 0, seven?.t || 0);
  return {
    fiveHour: five?.entry || null,
    sevenDay: seven?.entry || null,
    asOf: asOfMs ? new Date(asOfMs).toISOString() : null,
  };
}

function safeSessionId(file) {
  return `${TOOL}-${crypto.createHash("sha1").update(file).digest("hex").slice(0, 12)}`;
}

function zeroBreakdown() {
  return { input: 0, output: 0, cacheWrite: 0, cacheRead: 0 };
}

function addBreakdown(target, src) {
  target.input += src.input || 0;
  target.output += src.output || 0;
  target.cacheWrite += src.cacheWrite || 0;
  target.cacheRead += src.cacheRead || 0;
}

function noteTime(session, timestamp) {
  const t = Date.parse(timestamp);
  if (!Number.isFinite(t)) return;
  const iso = new Date(t).toISOString();
  if (!session.startedAt || iso < session.startedAt) session.startedAt = iso;
  if (!session.endedAt || iso > session.endedAt) session.endedAt = iso;
}

function noteAgentDay(agentDaily, day, modelCalls, userTurns) {
  if (!day) return;
  const row = agentDaily[day] || (agentDaily[day] = { modelCallCount: 0, userTurnCount: 0 });
  row.modelCallCount += modelCalls || 0;
  row.userTurnCount += userTurns || 0;
}

function materializeSession(s) {
  const totalTok = s.tokBreakdown.input + s.tokBreakdown.output + s.tokBreakdown.cacheWrite + s.tokBreakdown.cacheRead;
  const totalUsd = s.usdBreakdown.input + s.usdBreakdown.output + s.usdBreakdown.cacheWrite + s.usdBreakdown.cacheRead;
  const userTurnCount = s.userTurnCount > 0 ? s.userTurnCount : null;
  return {
    id: s.id,
    tool: TOOL,
    projectId: s.project.id,
    projectName: s.project.name,
    startedAt: s.startedAt,
    endedAt: s.endedAt,
    modelCallCount: s.modelCallCount,
    userTurnCount,
    amplification: userTurnCount ? round4(s.modelCallCount / userTurnCount) : null,
    tok: totalTok,
    usd: round4(totalUsd),
    tokBreakdown: s.tokBreakdown,
    usdBreakdown: {
      input: round4(s.usdBreakdown.input),
      output: round4(s.usdBreakdown.output),
      cacheWrite: round4(s.usdBreakdown.cacheWrite),
      cacheRead: round4(s.usdBreakdown.cacheRead),
    },
    models: [...s.models].sort(),
  };
}

export function collect() {
  const prices = loadPrices();
  const agg = {}; // day -> project -> model -> {input, cached, output}
  const models = new Set();
  const unpriced = new Set();
  const projects = {};
  const sessions = [];
  const agentDaily = {};
  const usageEvents = [];
  const limitSnapshots = [];
  let filesWithTok = 0;
  let filesSkipped = 0;
  const latestRLByPool = new Map(); // limit_id/limit_name -> 最新 rate_limits。避免模型专属 0% 覆盖主 Codex 限额。
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
    let curProject = projectOf(null);
    let prevTotal = null;
    let prevTotalKey = null;
    let hadTok = false;
    const session = {
      id: safeSessionId(file),
      project: curProject,
      startedAt: null,
      endedAt: null,
      modelCallCount: 0,
      userTurnCount: 0,
      tokBreakdown: zeroBreakdown(),
      usdBreakdown: zeroBreakdown(),
      models: new Set(),
    };
    for (const line of lines) {
      if (!line) continue;
      let o;
      try {
        o = JSON.parse(line);
      } catch {
        continue;
      }
      if (o.type === "session_meta" && o.payload && o.payload.cwd) {
        curProject = projectOf(o.payload.cwd);
        projects[curProject.id] = curProject;
        continue;
      }
      if (o.type === "turn_context" && o.payload) {
        if (o.payload.model) curModel = o.payload.model;
        if (o.payload.cwd) {
          curProject = projectOf(o.payload.cwd);
          projects[curProject.id] = curProject;
        }
        const turnDay = dayKeyUTC8(o.timestamp);
        noteAgentDay(agentDaily, turnDay, 0, 1);
        session.userTurnCount += 1;
        session.project = session.project.id === "unknown" && curProject.id !== "unknown" ? curProject : session.project;
        noteTime(session, o.timestamp);
        continue;
      }
      if (o.type === "event_msg" && o.payload && o.payload.type === "token_count") {
        if (o.payload.rate_limits) {
          const t = Date.parse(o.timestamp); // 用数值比时间,避免 ISO 字符串格式混用排错
          const poolKey = limitPoolKey(o.payload.rate_limits);
          const prev = latestRLByPool.get(poolKey);
          if (!Number.isNaN(t) && (!prev || t > prev.t)) {
            latestRLByPool.set(poolKey, { ts: o.timestamp, t, rl: o.payload.rate_limits });
          }
          const snapshot = mapRateLimits(o.payload.rate_limits);
          if (snapshot && Number.isFinite(t)) {
            limitSnapshots.push({
              timestamp: new Date(t).toISOString(),
              fiveHour: snapshot.fiveHour,
              sevenDay: snapshot.sevenDay,
            });
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
        projects[curProject.id] = curProject;
        hadTok = true;
        session.project = session.project.id === "unknown" && curProject.id !== "unknown" ? curProject : session.project;
        session.modelCallCount += 1;
        session.models.add(model);
        noteTime(session, o.timestamp);
        noteAgentDay(agentDaily, day, 1, 0);
        const callBreak = { input: Math.max(0, input - cached), output, cacheWrite: 0, cacheRead: cached };
        const callUsd = usdBreakdownOf(model, { input, cached, output });
        addBreakdown(session.tokBreakdown, callBreak);
        addBreakdown(session.usdBreakdown, callUsd);
        usageEvents.push({
          timestamp: new Date(Date.parse(o.timestamp)).toISOString(),
          project: curProject,
          model,
          tok: callBreak.input + callBreak.output + callBreak.cacheWrite + callBreak.cacheRead,
          usd: round4(callUsd.input + callUsd.output + callUsd.cacheRead),
          tokBreakdown: callBreak,
          usdBreakdown: {
            input: round4(callUsd.input),
            output: round4(callUsd.output),
            cacheWrite: 0,
            cacheRead: round4(callUsd.cacheRead),
          },
        });

        (agg[day] || (agg[day] = {}));
        (agg[day][curProject.id] || (agg[day][curProject.id] = {}));
        const slot = agg[day][curProject.id][model] || (agg[day][curProject.id][model] = { input: 0, cached: 0, output: 0 });
        slot.input += input;
        slot.cached += cached;
        slot.output += output;
      }
    }
    if (hadTok) filesWithTok += 1;
    else filesSkipped += 1;
    if (session.modelCallCount > 0) sessions.push(materializeSession(session));
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
    for (const [projectId, byModel] of Object.entries(agg[date])) {
      for (const [model, s] of Object.entries(byModel)) {
        const fresh = Math.max(0, s.input - s.cached);
        const ub = usdBreakdownOf(model, s);
        entries.push({
          date,
          project: projects[projectId] || projectOf(null),
          model,
          tok: s.input + s.output, // = fresh + cached + output
          usd: ub.input + ub.output + ub.cacheRead,
          tokBreakdown: { input: fresh, output: s.output, cacheWrite: 0, cacheRead: s.cached },
          usdBreakdown: {
            input: ub.input,
            output: ub.output,
            cacheWrite: 0,
            cacheRead: ub.cacheRead,
          },
        });
      }
    }
  }

  const pricing = {};
  for (const m of models) {
    const r = priceForModel(m);
    pricing[m] = r
      ? { tool: TOOL, input: r.p.input, output: r.p.output, cacheWrite1h: null, cacheWrite5m: null, cacheRead: r.p.cachedInput, estimated: r.estimated }
      : { tool: TOOL, input: 0, output: 0, cacheWrite1h: null, cacheWrite5m: null, cacheRead: 0, estimated: false };
  }

  // Codex 可能同时写入多个 limit_id(例如主 Codex 与模型专属池)。总入口取已用%更高的池,避免较新的 0% 模型池误导用户。
  const limits = conservativeLimitsFromPools(latestRLByPool);

  return {
    tool: TOOL,
    entries,
    models: [...models],
    unpriced: [...unpriced],
    pricing,
    limits,
    source: roots.join(", ") || codexHomes().join(", ") + " (无 sessions 目录)",
    stats: { filesWithTok, filesSkipped },
    sessions,
    agentDaily,
    usageEvents,
    limitSnapshots,
  };
}
