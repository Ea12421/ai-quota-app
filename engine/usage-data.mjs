#!/usr/bin/env node
// Claude 用量看板 · 数据引擎(编排器)
// 跑各数据源适配器(Claude Code / Codex / 以后加的 CLI)→ 归一化合并 → 产统一 JSON。
// 数据与界面解耦:本文件只产 JSON;界面只消费 JSON,绝不碰原始日志。
//
// 加新数据源 = 在 engine/sources/ 加一个导出 { TOOL, collect() } 的模块,再加进下面 SOURCES。
//
// 用法:
//   node engine/usage-data.mjs            扫描一次,写 usage.json,并打印按工具/天/模型核对表
//   node engine/usage-data.mjs --serve    起本地服务(默认 :7799):/api/usage.json + 托管 web/,每 60s 重算
//   node engine/usage-data.mjs --serve 8080   指定端口
//
// 口径:美元是按官方 API 单价折算的「等价价值」,订阅制下并非真实账单。
// 隐私:各源只读记账字段,绝不读取/打印对话正文。

import fs from "node:fs";
import path from "node:path";
import http from "node:http";
import { fileURLToPath } from "node:url";
import { todayKeyUTC8, eachDay, round4 } from "./lib.mjs";
import * as claude from "./sources/claude.mjs";
import * as codex from "./sources/codex.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.join(__dirname, "..");
const WEB_DIR = path.join(PROJECT_ROOT, "web");
const OUT_FILE = path.join(PROJECT_ROOT, "usage.json");

const NOTICE = "美元为按 API 价折合的等价价值,非真实账单";

// 数据源注册表(顺序决定工具展示顺序)。加新 CLI 就在这里追加。
const SOURCES = [claude, codex];

const VELOCITY_BUCKET_MINUTES = 15;
const VELOCITY_BUCKET_MS = VELOCITY_BUCKET_MINUTES * 60 * 1000;
const VELOCITY_HISTORY_MS = 24 * 60 * 60 * 1000;
const LIMIT_SNAPSHOT_KEEP = 1000;

function toIso(value) {
  const time = Date.parse(value);
  return Number.isFinite(time) ? new Date(time).toISOString() : null;
}

function finiteNumber(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function addMetric(target, event) {
  target.tok += event.tok || 0;
  target.usd += event.usd || 0;
  target.modelCallCount += 1;
}

function materializeVelocityWindow(events, generatedAtMs, minutes) {
  const sinceMs = generatedAtMs - minutes * 60 * 1000;
  const byTool = {};
  const out = { tok: 0, usd: 0, modelCallCount: 0, byTool };
  for (const event of events) {
    if (event.timeMs < sinceMs || event.timeMs > generatedAtMs) continue;
    addMetric(out, event);
    const toolRow = byTool[event.tool] || (byTool[event.tool] = { tok: 0, usd: 0, modelCallCount: 0 });
    addMetric(toolRow, event);
  }
  const hours = minutes / 60;
  const finish = (row) => {
    row.tok = Math.round(row.tok);
    row.usd = round4(row.usd);
    row.tokPerHour = Math.round(row.tok / hours);
    row.usdPerHour = round4(row.usd / hours);
    return row;
  };
  for (const row of Object.values(byTool)) finish(row);
  return {
    minutes,
    since: new Date(sinceMs).toISOString(),
    until: new Date(generatedAtMs).toISOString(),
    ...finish(out),
  };
}

function buildUsageVelocity(events, generatedAtIso) {
  const generatedAtMs = Date.parse(generatedAtIso);
  const normalized = events
    .map((event) => {
      const timeMs = Date.parse(event.timestamp);
      return Number.isFinite(timeMs) ? { ...event, timeMs } : null;
    })
    .filter(Boolean)
    .filter((event) => event.timeMs <= generatedAtMs + 5 * 60 * 1000)
    .sort((a, b) => a.timeMs - b.timeMs);

  const bucketMap = new Map();
  const bucketSince = generatedAtMs - VELOCITY_HISTORY_MS;
  for (const event of normalized) {
    if (event.timeMs < bucketSince || event.timeMs > generatedAtMs) continue;
    const startMs = Math.floor(event.timeMs / VELOCITY_BUCKET_MS) * VELOCITY_BUCKET_MS;
    const key = String(startMs);
    const row = bucketMap.get(key) || { startMs, tok: 0, usd: 0, modelCallCount: 0, byTool: {} };
    addMetric(row, event);
    const toolRow = row.byTool[event.tool] || (row.byTool[event.tool] = { tok: 0, usd: 0, modelCallCount: 0 });
    addMetric(toolRow, event);
    bucketMap.set(key, row);
  }
  const buckets = [...bucketMap.values()]
    .sort((a, b) => a.startMs - b.startMs)
    .map((row) => {
      for (const toolRow of Object.values(row.byTool)) {
        toolRow.tok = Math.round(toolRow.tok);
        toolRow.usd = round4(toolRow.usd);
      }
      return {
        start: new Date(row.startMs).toISOString(),
        end: new Date(row.startMs + VELOCITY_BUCKET_MS).toISOString(),
        tok: Math.round(row.tok),
        usd: round4(row.usd),
        modelCallCount: row.modelCallCount,
        byTool: row.byTool,
      };
    });

  const latestEvent = normalized.length ? normalized[normalized.length - 1] : null;
  return {
    bucketMinutes: VELOCITY_BUCKET_MINUTES,
    generatedAt: generatedAtIso,
    latestEventAt: latestEvent ? new Date(latestEvent.timeMs).toISOString() : null,
    windows: {
      "15m": materializeVelocityWindow(normalized, generatedAtMs, 15),
      "60m": materializeVelocityWindow(normalized, generatedAtMs, 60),
    },
    buckets,
  };
}

function normalizeUsageEvent(tool, event) {
  if (!event || typeof event !== "object") return null;
  const timestamp = toIso(event.timestamp);
  if (!timestamp) return null;
  const tok = finiteNumber(event.tok);
  const usd = finiteNumber(event.usd);
  return {
    timestamp,
    tool,
    tok: tok === null ? 0 : tok,
    usd: usd === null ? 0 : usd,
  };
}

function normalizeLimitSnapshot(tool, snapshot) {
  if (!snapshot || typeof snapshot !== "object") return null;
  const timestamp = toIso(snapshot.timestamp);
  if (!timestamp) return null;
  const cleanEntry = (entry) => {
    if (!entry || typeof entry !== "object") return null;
    const pct = finiteNumber(entry.pct);
    const resetAt = toIso(entry.resetAt);
    if (pct === null && resetAt === null) return null;
    return { pct: pct === null ? null : Math.max(0, Math.min(100, Math.round(pct * 10) / 10)), resetAt };
  };
  return {
    tool,
    timestamp,
    fiveHour: cleanEntry(snapshot.fiveHour),
    sevenDay: cleanEntry(snapshot.sevenDay),
  };
}

// ---- 合并所有数据源,产出统一数据契约 ----
function compute() {
  const results = SOURCES.map((s) => ({ tool: s.TOOL, ...s.collect() }));

  // 每个工具一套限额(各源自带:Codex 从日志、Claude 从 ClaudeMeter)
  const limits = {};
  for (const r of results) limits[r.tool] = r.limits || null;

  const modelTool = {}; // model -> tool
  const pricing = {}; // model -> 单价表
  const agg = {}; // date -> model -> {tok, usd, tool, tokBreakdown, usdBreakdown}
  const projectAgg = {}; // date -> project -> model -> {tok, usd, tool, tokBreakdown, usdBreakdown}
  const projectInfo = {}; // projectId -> {id,name,path}
  const projectTotal = {}; // projectId -> {tok,usd,tools:Set}
  const projectLastActive = {}; // projectId -> YYYY-MM-DD
  const sessions = [];
  const agentDaily = {}; // date -> tool -> {modelCallCount,userTurnCount}
  const usageEvents = [];
  const limitSnapshots = [];
  let minDay = null;
  let maxDay = null;
  const today = todayKeyUTC8(); // 未来日期/时钟偏移的记录夹到今天:避免生成几百万空天(OOM)且区间锚定错乱
  const floor = new Date(Date.parse(today + "T00:00:00Z") - 1100 * 86400000).toISOString().slice(0, 10); // 远古坏时间戳夹到 ~3 年前,同样防 OOM

  const zeroBreak = () => ({ input: 0, output: 0, cacheWrite: 0, cacheRead: 0 });
  const unknownProject = { id: "unknown", name: "未知项目", path: null };
  function addUsage(cur, e, tool) {
    cur.tok += e.tok;
    cur.usd += e.usd;
    cur.tool = tool;
    for (const k of ["input", "output", "cacheWrite", "cacheRead"]) {
      cur.tokBreakdown[k] += (e.tokBreakdown && e.tokBreakdown[k]) || 0;
      cur.usdBreakdown[k] += (e.usdBreakdown && e.usdBreakdown[k]) || 0;
    }
  }
  function materialize(c) {
    return {
      tok: c.tok,
      usd: round4(c.usd),
      tool: c.tool,
      tokBreakdown: c.tokBreakdown,
      usdBreakdown: {
        input: round4(c.usdBreakdown.input),
        output: round4(c.usdBreakdown.output),
        cacheWrite: round4(c.usdBreakdown.cacheWrite),
        cacheRead: round4(c.usdBreakdown.cacheRead),
      },
    };
  }
  function addAgentStats(date, tool, stats) {
    if (!date || !tool || !stats) return;
    (agentDaily[date] || (agentDaily[date] = {}));
    const cur = agentDaily[date][tool] || (agentDaily[date][tool] = { modelCallCount: 0, userTurnCount: null });
    cur.modelCallCount += stats.modelCallCount || 0;
    if (typeof stats.userTurnCount === "number") cur.userTurnCount = (cur.userTurnCount || 0) + stats.userTurnCount;
  }
  function materializeAgentStats(rows) {
    const out = {};
    for (const [tool, s] of Object.entries(rows || {})) {
      const userTurnCount = s.userTurnCount && s.userTurnCount > 0 ? s.userTurnCount : null;
      out[tool] = {
        modelCallCount: s.modelCallCount || 0,
        userTurnCount,
        amplification: userTurnCount ? round4((s.modelCallCount || 0) / userTurnCount) : null,
      };
    }
    return out;
  }

  for (const r of results) {
    Object.assign(pricing, r.pricing || {});
    if (Array.isArray(r.sessions)) sessions.push(...r.sessions);
    if (Array.isArray(r.usageEvents)) {
      for (const event of r.usageEvents) {
        const normalized = normalizeUsageEvent(r.tool, event);
        if (normalized) usageEvents.push(normalized);
      }
    }
    if (Array.isArray(r.limitSnapshots)) {
      for (const snapshot of r.limitSnapshots) {
        const normalized = normalizeLimitSnapshot(r.tool, snapshot);
        if (normalized) limitSnapshots.push(normalized);
      }
    }
    for (const [date, stats] of Object.entries(r.agentDaily || {})) addAgentStats(date, r.tool, stats);
    for (const e of r.entries) {
      modelTool[e.model] = r.tool;
      const date = e.date > today ? today : e.date < floor ? floor : e.date; // 夹到 [floor, today],防未来/远古坏时间戳生成海量空天(OOM)
      if (minDay === null || date < minDay) minDay = date;
      if (maxDay === null || date > maxDay) maxDay = date;
      (agg[date] || (agg[date] = {}));
      const cur =
        agg[date][e.model] ||
        (agg[date][e.model] = { tok: 0, usd: 0, tool: r.tool, tokBreakdown: zeroBreak(), usdBreakdown: zeroBreak() });
      addUsage(cur, e, r.tool);

      const p = e.project && e.project.id ? e.project : unknownProject;
      projectInfo[p.id] = p;
      (projectAgg[date] || (projectAgg[date] = {}));
      (projectAgg[date][p.id] || (projectAgg[date][p.id] = {}));
      const pcur =
        projectAgg[date][p.id][e.model] ||
        (projectAgg[date][p.id][e.model] = { tok: 0, usd: 0, tool: r.tool, tokBreakdown: zeroBreak(), usdBreakdown: zeroBreak() });
      addUsage(pcur, e, r.tool);

      const pt = projectTotal[p.id] || (projectTotal[p.id] = { tok: 0, usd: 0, tools: new Set() });
      pt.tok += e.tok;
      pt.usd += e.usd;
      pt.tools.add(r.tool);
      if ((e.tok || 0) > 0 || (e.usd || 0) > 0) projectLastActive[p.id] = !projectLastActive[p.id] || date > projectLastActive[p.id] ? date : projectLastActive[p.id];
    }
  }

  // 模型按总量(tok)降序
  const modelTotal = {};
  for (const date of Object.keys(agg)) {
    for (const [m, c] of Object.entries(agg[date])) modelTotal[m] = (modelTotal[m] || 0) + c.tok;
  }
  const sortedModels = Object.keys(modelTotal).sort((a, b) => modelTotal[b] - modelTotal[a]);

  // 工具列表(按 SOURCES 顺序,只列有数据的)
  const present = new Set(Object.values(modelTool));
  const tools = SOURCES.map((s) => s.TOOL).filter((t) => present.has(t));
  const toolOrder = Object.fromEntries(SOURCES.map((s, i) => [s.TOOL, i]));
  const projects = Object.keys(projectTotal)
    .sort((a, b) => projectTotal[b].tok - projectTotal[a].tok)
    .map((id) => ({
      ...(projectInfo[id] || unknownProject),
      tok: projectTotal[id].tok,
      usd: round4(projectTotal[id].usd),
      tools: [...projectTotal[id].tools].sort((a, b) => (toolOrder[a] ?? 99) - (toolOrder[b] ?? 99)),
      lastActiveDate: projectLastActive[id] || null,
    }));

  // 连续补齐:最早有用量的天 → 今天(UTC+8),每天补齐所有模型键(零填),带 tool 标签
  const daily = [];
  if (minDay) {
    // 数据日期已夹到今天,连续补齐到今天即可(maxDay ≤ today)
    const lastDay = today;
    for (const date of eachDay(minDay, lastDay)) {
      const dayAgg = agg[date] || {};
      const dayProjectAgg = projectAgg[date] || {};
      const byModel = {};
      for (const m of sortedModels) {
        const c = dayAgg[m];
        byModel[m] = c ? materialize(c) : { tok: 0, usd: 0, tool: modelTool[m], tokBreakdown: zeroBreak(), usdBreakdown: zeroBreak() };
      }
      const byProject = {};
      for (const [projectId, modelMap] of Object.entries(dayProjectAgg)) {
        const pByModel = {};
        let pTok = 0;
        let pUsd = 0;
        for (const m of sortedModels) {
          const c = modelMap[m];
          if (!c) continue;
          pByModel[m] = materialize(c);
          pTok += c.tok;
          pUsd += c.usd;
        }
        byProject[projectId] = { tok: pTok, usd: round4(pUsd), byModel: pByModel };
      }
      daily.push({ date, byModel, byProject, agentStats: materializeAgentStats(agentDaily[date]) });
    }
  }

  const sortedSessions = sessions
    .filter((s) => s && s.id && s.tool)
    .sort((a, b) => Date.parse(b.endedAt || b.startedAt || 0) - Date.parse(a.endedAt || a.startedAt || 0));
  const updatedAt = new Date().toISOString();
  const sortedLimitSnapshots = limitSnapshots
    .filter((s) => s.fiveHour || s.sevenDay)
    .sort((a, b) => Date.parse(a.timestamp) - Date.parse(b.timestamp))
    .slice(-LIMIT_SNAPSHOT_KEEP);

  return {
    updatedAt,
    limits,
    daily,
    sessions: sortedSessions,
    usageVelocity: buildUsageVelocity(usageEvents, updatedAt),
    limitSnapshots: sortedLimitSnapshots,
    tools,
    models: sortedModels,
    projects,
    pricing,
    notice: NOTICE,
    _meta: {
      generatedBy: "engine/usage-data.mjs",
      sources: results.map((r) => ({
        tool: r.tool,
        // 把家目录绝对路径替成 ~,别在公开响应里泄露用户名/本机路径
        source: typeof r.source === "string" && process.env.HOME ? r.source.split(process.env.HOME).join("~") : r.source,
        models: r.models,
        unpriced: r.unpriced || [],
        ...(r.stats ? { stats: r.stats } : {}),
      })),
    },
  };
}

// ---- CLI 核对表(按工具分组)----
const fmtN = (n) => Math.round(n).toLocaleString("en-US");
const fmtM = (n) => (n / 1e6).toFixed(2) + "M";
function printCheck(data) {
  for (const tool of data.tools) {
    const byDay = {};
    const byModel = {};
    for (const d of data.daily) {
      for (const [m, v] of Object.entries(d.byModel)) {
        if (v.tool !== tool) continue;
        if (v.tok === 0 && v.usd === 0) continue;
        (byDay[d.date] || (byDay[d.date] = { tok: 0, usd: 0 }));
        byDay[d.date].tok += v.tok;
        byDay[d.date].usd += v.usd;
        (byModel[m] || (byModel[m] = { tok: 0, usd: 0 }));
        byModel[m].tok += v.tok;
        byModel[m].usd += v.usd;
      }
    }
    let tTok = 0;
    let tUsd = 0;
    for (const day of Object.keys(byDay)) {
      tTok += byDay[day].tok;
      tUsd += byDay[day].usd;
    }
    console.log(`\n===== ${tool} =====`);
    console.log("模型 | 总token | 等价USD");
    for (const m of data.models) {
      const s = byModel[m];
      if (!s) continue;
      console.log(`${m} | ${fmtM(s.tok)} | $${s.usd.toFixed(2)}`);
    }
    console.log(`合计 | ${fmtM(tTok)} (${fmtN(tTok)}) | $${tUsd.toFixed(2)}`);
  }
  // 未计价模型提示
  for (const s of data._meta.sources) {
    if (s.unpriced && s.unpriced.length) {
      console.log(`\n⚠️ [${s.tool}] 未计价模型(tok 照计、usd=0): ${s.unpriced.join(", ")}`);
    }
    if (s.stats) console.log(`[${s.tool}] 文件:有计数 ${s.stats.filesWithTok} / 跳过 ${s.stats.filesSkipped}`);
  }
  const limStr = Object.entries(data.limits || {}).map(([t, v]) => {
    if (!v) return `${t}:未接入`;
    const f = v.fiveHour ? v.fiveHour.pct + "%" : "—";
    const s = v.sevenDay ? v.sevenDay.pct + "%" : "—";
    return `${t}:5h ${f}/7d ${s}`;
  }).join(" · ");
  console.log(`\n口径:${NOTICE}。限额 → ${limStr}。`);
}

// ---- 静态文件托管(--serve)----
const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".woff2": "font/woff2",
  ".svg": "image/svg+xml",
};
function serveStatic(req, res) {
  let pathname;
  try {
    pathname = decodeURIComponent(req.url.split("?")[0]); // 畸形 % 编码会抛 URIError → 400,别崩服务
  } catch {
    res.writeHead(400);
    res.end("bad request");
    return;
  }
  if (pathname === "/") pathname = "/index.html";
  const safe = path.normalize(pathname).replace(/^(\.\.(\/|\\|$))+/, "");
  const filePath = path.join(WEB_DIR, safe);
  if (!filePath.startsWith(WEB_DIR)) {
    res.writeHead(403);
    res.end("forbidden");
    return;
  }
  fs.readFile(filePath, (err, buf) => {
    if (err) {
      res.writeHead(404);
      res.end("not found");
      return;
    }
    res.writeHead(200, { "content-type": MIME[path.extname(filePath)] || "application/octet-stream" });
    res.end(buf);
  });
}

function runServe(port) {
  let cache = compute();
  const refresh = () => {
    try {
      cache = compute();
    } catch (e) {
      console.error("[refresh error]", e && e.stack ? e.stack : e);
    }
  };
  setInterval(refresh, 60000);

  const server = http.createServer((req, res) => {
    if (req.url.split("?")[0] === "/api/usage.json") {
      res.writeHead(200, {
        "content-type": "application/json; charset=utf-8",
        "cache-control": "no-store",
      });
      res.end(JSON.stringify(cache));
      return;
    }
    serveStatic(req, res);
  });
  // 只绑回环地址:仅本机可访问,局域网其它设备读不到你的用量/限额
  server.listen(port, "127.0.0.1", () => {
    console.log(`用量看板已启动:http://localhost:${port}`);
    console.log(`API:http://localhost:${port}/api/usage.json  ·  每 60s 自动重算`);
    const lim = Object.entries(cache.limits || {}).map(([t, v]) => t + ":" + (v ? "已接入" : "未接入")).join(" ");
    console.log(`数据:${cache.daily.length} 天 · 工具 [${cache.tools.join(", ")}] · 模型 ${cache.models.length} 个 · 限额 ${lim}`);
  });
}

// ---- 入口 ----
const argv = process.argv.slice(2);
if (argv.includes("--serve")) {
  const i = argv.indexOf("--serve");
  const port = parseInt(argv[i + 1], 10) || 7799;
  runServe(port);
} else {
  const data = compute();
  fs.writeFileSync(OUT_FILE, JSON.stringify(data, null, 2));
  console.log(`已写入 ${OUT_FILE}（${data.daily.length} 天 · 工具 [${data.tools.join(", ")}]）`);
  printCheck(data);
}
