// 数据源:Claude Code —— 扫 ~/.claude/projects/**/*.jsonl(只读)
// 取记账字段聚合按「天×模型」的 tok 与等价美元。修正缓存写入计费(1h=2×、5m=1.25×)。
// 隐私:绝不读取/打印对话正文(message.content)。
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { dayKeyUTC8, projectOf, round4 } from "../lib.mjs";

export const TOOL = "claude-code";

const LOG_ROOT = path.join(process.env.HOME, ".claude", "projects");
const CLAUDEMETER_FILE = path.join(process.env.HOME, ".claudemeter", "usage.json");

// Claude 账号的 5h/7d 额度只有 ClaudeMeter 有(走非公开接口)。没装 → null(界面显示"未接入")。
// 注:Claude Code 的本地日志里不含限额数据,本机也无其他来源,这是唯一可选源。
function readClaudeMeterLimits() {
  let raw;
  try {
    raw = fs.readFileSync(CLAUDEMETER_FILE, "utf8");
  } catch {
    return null;
  }
  let j;
  try {
    j = JSON.parse(raw);
  } catch {
    return null;
  }
  const pick = (...c) => { for (const x of c) if (x !== undefined && x !== null) return x; return null; };
  const mapOne = (x) => {
    if (!x || typeof x !== "object") return null;
    // ClaudeMeter(eddmann/ClaudeMeter)用 utilization + reset_at;另留通用兜底
    const pct = pick(x.utilization, x.pct, x.percent, x.percentage, x.used_pct, x.used_percent);
    const resetAt = pick(x.reset_at, x.resetAt, x.reset, x.resetsAt);
    if (pct == null && resetAt == null) return null;
    return { pct: pct == null ? null : Math.round(pct), resetAt };
  };
  // ClaudeMeter 真实字段:session_usage(5h)/ weekly_usage(7d)
  const fiveHour = mapOne(j.session_usage || j.fiveHour || j.five_hour || j["5h"] || j.fiveHourLimit);
  const sevenDay = mapOne(j.weekly_usage || j.sevenDay || j.seven_day || j["7d"] || j.sevenDayLimit);
  if (!fiveHour && !sevenDay) return null;
  return { fiveHour, sevenDay, asOf: j.last_updated || null };
}

// 每百万 token 单价(美元):[输入价 pin, 输出价 pout]
const PRICES = [
  [/opus/, [5, 25]],
  [/sonnet/, [3, 15]],
  [/haiku/, [1, 5]],
  [/fable/, [10, 50]],
];
function priceFor(model) {
  for (const [re, p] of PRICES) if (re.test(model)) return p;
  return null; // 未知模型:tok 照计,usd 计 0
}

function tokOf(s) {
  return s.inp + s.out + s.cw1h + s.cw5m + s.cr;
}
// token 四分类:输入 / 输出 / 写缓存(1h+5m) / 读缓存
function tokBreakdownOf(s) {
  return { input: s.inp, output: s.out, cacheWrite: s.cw1h + s.cw5m, cacheRead: s.cr };
}
// 美元四分类(未计价模型全 0)
function usdBreakdownOf(model, s) {
  const p = priceFor(model);
  const pin = p ? p[0] : 0;
  const pout = p ? p[1] : 0;
  return {
    input: (s.inp * pin) / 1e6,
    output: (s.out * pout) / 1e6,
    cacheWrite: (s.cw1h * pin * 2 + s.cw5m * pin * 1.25) / 1e6, // 1h=2×、5m=1.25×
    cacheRead: (s.cr * pin * 0.1) / 1e6, // 读取=0.1×
  };
}
// 单价表(每百万 token 美元),供界面展示
function pricingOf(model) {
  const p = priceFor(model);
  if (!p) return { tool: TOOL, input: 0, output: 0, cacheWrite1h: 0, cacheWrite5m: 0, cacheRead: 0, estimated: false };
  const pin = p[0];
  return { tool: TOOL, input: pin, output: p[1], cacheWrite1h: round4(pin * 2), cacheWrite5m: round4(pin * 1.25), cacheRead: round4(pin * 0.1), estimated: false };
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
  const row = agentDaily[day] || (agentDaily[day] = { modelCallCount: 0, userTurnCount: null });
  row.modelCallCount += modelCalls || 0;
  if (typeof userTurns === "number") row.userTurnCount = (row.userTurnCount || 0) + userTurns;
}

function materializeSession(s) {
  const totalTok = s.tokBreakdown.input + s.tokBreakdown.output + s.tokBreakdown.cacheWrite + s.tokBreakdown.cacheRead;
  const totalUsd = s.usdBreakdown.input + s.usdBreakdown.output + s.usdBreakdown.cacheWrite + s.usdBreakdown.cacheRead;
  return {
    id: s.id,
    tool: TOOL,
    projectId: s.project.id,
    projectName: s.project.name,
    startedAt: s.startedAt,
    endedAt: s.endedAt,
    modelCallCount: s.modelCallCount,
    userTurnCount: null,
    amplification: null,
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
  const seen = new Set();
  const agg = {}; // day -> project -> model -> {inp,out,cw1h,cw5m,cr,n}
  const models = new Set();
  const unpriced = new Set();
  const projects = {};
  const sessions = [];
  const agentDaily = {};

  function walk(dir) {
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.name.endsWith(".jsonl")) scanFile(p);
    }
  }

  function scanFile(file) {
    let text;
    try {
      text = fs.readFileSync(file, "utf8");
    } catch {
      return;
    }
    let session = null;
    function ensureSession(project, timestamp) {
      if (!session) {
        session = {
          id: safeSessionId(file),
          project,
          startedAt: null,
          endedAt: null,
          modelCallCount: 0,
          tokBreakdown: zeroBreakdown(),
          usdBreakdown: zeroBreakdown(),
          models: new Set(),
        };
      }
      if (session.project.id === "unknown" && project.id !== "unknown") session.project = project;
      noteTime(session, timestamp);
      return session;
    }

    for (const line of text.split("\n")) {
      if (!line.includes('"usage"')) continue;
      let o;
      try {
        o = JSON.parse(line);
      } catch {
        continue;
      }
      const u = o.message && o.message.usage;
      if (!u || !o.timestamp) continue;

      const model = o.message.model || "unknown";
      if (model === "<synthetic>") continue; // 过滤占位记录(token 全 0)

      const key = (o.requestId || "") + "|" + (o.message.id || ""); // 去重键
      if (key !== "|" && seen.has(key)) continue;
      seen.add(key);

      const day = dayKeyUTC8(o.timestamp);
      if (!day) continue;
      const project = projectOf(o.cwd);
      projects[project.id] = project;

      const inp = u.input_tokens || 0;
      const out = u.output_tokens || 0;
      const cr = u.cache_read_input_tokens || 0;
      let cw1h = 0;
      let cw5m = 0;
      if (u.cache_creation) {
        cw1h = u.cache_creation.ephemeral_1h_input_tokens || 0;
        cw5m = u.cache_creation.ephemeral_5m_input_tokens || 0;
      } else {
        cw5m = u.cache_creation_input_tokens || 0; // 无 breakdown 时退化
      }

      const mid = model.replace(/^claude-/, ""); // claude-opus-4-8 -> opus-4-8
      models.add(mid);
      if (!priceFor(mid)) unpriced.add(mid);

      const callUsage = { inp, out, cw1h, cw5m, cr };
      const callUsd = usdBreakdownOf(mid, callUsage);
      const curSession = ensureSession(project, o.timestamp);
      curSession.modelCallCount += 1;
      curSession.models.add(mid);
      addBreakdown(curSession.tokBreakdown, tokBreakdownOf(callUsage));
      addBreakdown(curSession.usdBreakdown, callUsd);
      noteAgentDay(agentDaily, day, 1, null);

      (agg[day] || (agg[day] = {}));
      (agg[day][project.id] || (agg[day][project.id] = {}));
      const slot = agg[day][project.id][mid] || (agg[day][project.id][mid] = { inp: 0, out: 0, cw1h: 0, cw5m: 0, cr: 0, n: 0 });
      slot.inp += inp;
      slot.out += out;
      slot.cw1h += cw1h;
      slot.cw5m += cw5m;
      slot.cr += cr;
      slot.n += 1;
    }
    if (session && session.modelCallCount > 0) sessions.push(materializeSession(session));
  }

  walk(LOG_ROOT);

  const entries = [];
  for (const date of Object.keys(agg)) {
    for (const [projectId, byModel] of Object.entries(agg[date])) {
      for (const [model, s] of Object.entries(byModel)) {
        const ub = usdBreakdownOf(model, s);
        entries.push({
          date,
          project: projects[projectId] || projectOf(null),
          model,
          tok: tokOf(s),
          usd: ub.input + ub.output + ub.cacheWrite + ub.cacheRead,
          tokBreakdown: tokBreakdownOf(s),
          usdBreakdown: {
            input: ub.input,
            output: ub.output,
            cacheWrite: ub.cacheWrite,
            cacheRead: ub.cacheRead,
          },
        });
      }
    }
  }

  const pricing = {};
  for (const m of models) pricing[m] = pricingOf(m);

  return {
    tool: TOOL,
    entries,
    models: [...models],
    unpriced: [...unpriced],
    pricing,
    limits: readClaudeMeterLimits(), // 没装 ClaudeMeter → null
    source: LOG_ROOT,
    sessions,
    agentDaily,
  };
}
