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

// ---- 合并所有数据源,产出统一数据契约 ----
function compute() {
  const results = SOURCES.map((s) => ({ tool: s.TOOL, ...s.collect() }));

  // 每个工具一套限额(各源自带:Codex 从日志、Claude 从 ClaudeMeter)
  const limits = {};
  for (const r of results) limits[r.tool] = r.limits || null;

  const modelTool = {}; // model -> tool
  const pricing = {}; // model -> 单价表
  const agg = {}; // date -> model -> {tok, usd, tool, tokBreakdown, usdBreakdown}
  let minDay = null;

  const zeroBreak = () => ({ input: 0, output: 0, cacheWrite: 0, cacheRead: 0 });

  for (const r of results) {
    Object.assign(pricing, r.pricing || {});
    for (const e of r.entries) {
      modelTool[e.model] = r.tool;
      if (minDay === null || e.date < minDay) minDay = e.date;
      (agg[e.date] || (agg[e.date] = {}));
      const cur =
        agg[e.date][e.model] ||
        (agg[e.date][e.model] = { tok: 0, usd: 0, tool: r.tool, tokBreakdown: zeroBreak(), usdBreakdown: zeroBreak() });
      cur.tok += e.tok;
      cur.usd += e.usd;
      for (const k of ["input", "output", "cacheWrite", "cacheRead"]) {
        cur.tokBreakdown[k] += (e.tokBreakdown && e.tokBreakdown[k]) || 0;
        cur.usdBreakdown[k] += (e.usdBreakdown && e.usdBreakdown[k]) || 0;
      }
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

  // 连续补齐:最早有用量的天 → 今天(UTC+8),每天补齐所有模型键(零填),带 tool 标签
  const daily = [];
  if (minDay) {
    const today = todayKeyUTC8();
    const lastDay = minDay > today ? minDay : today;
    for (const date of eachDay(minDay, lastDay)) {
      const dayAgg = agg[date] || {};
      const byModel = {};
      for (const m of sortedModels) {
        const c = dayAgg[m];
        byModel[m] = c
          ? {
              tok: c.tok,
              usd: round4(c.usd),
              tool: modelTool[m],
              tokBreakdown: c.tokBreakdown,
              usdBreakdown: {
                input: round4(c.usdBreakdown.input),
                output: round4(c.usdBreakdown.output),
                cacheWrite: round4(c.usdBreakdown.cacheWrite),
                cacheRead: round4(c.usdBreakdown.cacheRead),
              },
            }
          : { tok: 0, usd: 0, tool: modelTool[m], tokBreakdown: zeroBreak(), usdBreakdown: zeroBreak() };
      }
      daily.push({ date, byModel });
    }
  }

  return {
    updatedAt: new Date().toISOString(),
    limits,
    daily,
    tools,
    models: sortedModels,
    pricing,
    notice: NOTICE,
    _meta: {
      generatedBy: "engine/usage-data.mjs",
      sources: results.map((r) => ({
        tool: r.tool,
        source: r.source,
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
  let pathname = decodeURIComponent(req.url.split("?")[0]);
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
        "access-control-allow-origin": "*",
      });
      res.end(JSON.stringify(cache));
      return;
    }
    serveStatic(req, res);
  });
  server.listen(port, () => {
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
