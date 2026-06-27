#!/usr/bin/env node
import http from "node:http";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HOST = "127.0.0.1";
const DEFAULT_PORT = 8765;
const RESUME_DELAY_MS = 5 * 60 * 1000;

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_USAGE_PATH = path.resolve(__dirname, "..", "usage.json");

const STATUS_CN = {
  normal: "正常",
  tight: "紧张",
  danger: "危险",
  exhausted: "耗尽",
  unknown: "未知",
};

const STATUS_RANK = {
  normal: 0,
  unknown: 1,
  tight: 2,
  danger: 3,
  exhausted: 4,
};

const WINDOW_CONFIG = {
  "5h": { sourceKey: "fiveHour", label: "5小时", hours: 5, staleMs: 15 * 60 * 1000 },
  "7d": { sourceKey: "sevenDay", label: "7天", hours: 168, staleMs: 6 * 60 * 60 * 1000 },
};

const SNAPSHOT_HORIZONS = [
  { key: "15m", label: "最近15分钟", minutes: 15 },
  { key: "60m", label: "最近60分钟", minutes: 60 },
];

function parseArgs(argv) {
  const args = {
    port: DEFAULT_PORT,
    usagePath: DEFAULT_USAGE_PATH,
    mockPath: null,
  };

  for (let i = 2; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--port") {
      args.port = Number(argv[++i]);
    } else if (arg === "--usage") {
      args.usagePath = path.resolve(argv[++i]);
    } else if (arg === "--mock") {
      args.mockPath = path.resolve(argv[++i]);
    } else if (/^\d+$/.test(arg)) {
      args.port = Number(arg);
    }
  }

  if (!Number.isInteger(args.port) || args.port < 1 || args.port > 65535) {
    throw new Error("invalid port");
  }
  return args;
}

function isoNow() {
  return new Date().toISOString();
}

function toIso(value) {
  if (!value) return null;
  const time = Date.parse(value);
  return Number.isFinite(time) ? new Date(time).toISOString() : null;
}

function addMinutes(isoValue, minutes) {
  const time = Date.parse(isoValue);
  return Number.isFinite(time) ? new Date(time + minutes * 60 * 1000).toISOString() : null;
}

function clampPercent(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return null;
  return Math.max(0, Math.min(100, n));
}

function statusForRemaining(remaining) {
  if (remaining === null) return "unknown";
  if (remaining <= 5) return "exhausted";
  if (remaining <= 15) return "danger";
  if (remaining <= 30) return "tight";
  return "normal";
}

function worseStatus(a, b) {
  return STATUS_RANK[b] > STATUS_RANK[a] ? b : a;
}

function worseStatusFromList(values) {
  return values.reduce((worst, value) => worseStatus(worst, value), "normal");
}

function safeToStartAgent(windowKey, status) {
  if (status === "danger" || status === "exhausted") return false;
  if (windowKey === "7d" && status === "tight") return false;
  return true;
}

function safeToStartHeavyTask(status) {
  return status === "normal";
}

function shouldPauseWindow(windowKey, status) {
  if (status === "exhausted") return true;
  return windowKey === "5h" && status === "danger";
}

function windowText(windowKey, status, remaining) {
  const label = WINDOW_CONFIG[windowKey].label;
  if (status === "unknown" || remaining === null) return `${label}额度状态未知`;
  return `${label}额度剩余约 ${remaining}%`;
}

function freshnessFor(asOf, windowKey) {
  const asOfMs = Date.parse(asOf);
  if (!Number.isFinite(asOfMs)) return "unknown";
  const ageMs = Date.now() - asOfMs;
  if (ageMs < -5 * 60 * 1000) return "unknown";
  return ageMs > WINDOW_CONFIG[windowKey].staleMs ? "stale" : "fresh";
}

function sameReset(a, b) {
  if (!a || !b) return true;
  const ta = Date.parse(a);
  const tb = Date.parse(b);
  if (!Number.isFinite(ta) || !Number.isFinite(tb)) return true;
  return Math.abs(ta - tb) <= 60 * 1000;
}

function pctRateFromSnapshots(data, tool, windowKey, resetAt, asOfMs, horizon) {
  const sourceKey = WINDOW_CONFIG[windowKey].sourceKey;
  const sinceMs = asOfMs - horizon.minutes * 60 * 1000;
  const rows = (data?.limitSnapshots || [])
    .filter((snapshot) => snapshot && snapshot.tool === tool)
    .map((snapshot) => {
      const ts = Date.parse(snapshot.timestamp);
      const entry = snapshot[sourceKey];
      const pct = entry ? clampPercent(entry.pct) : null;
      if (!Number.isFinite(ts) || pct === null || !sameReset(entry && entry.resetAt, resetAt)) return null;
      return { ts, pct };
    })
    .filter(Boolean)
    .filter((row) => row.ts >= sinceMs && row.ts <= asOfMs)
    .sort((a, b) => a.ts - b.ts);

  if (rows.length < 2) return null;
  const first = rows[0];
  const last = rows[rows.length - 1];
  const elapsedHours = (last.ts - first.ts) / (60 * 60 * 1000);
  if (elapsedHours < 0.02) return null;
  const deltaPct = last.pct - first.pct;
  if (deltaPct < 0) return null;
  return {
    basis: horizon.key,
    basis_cn: horizon.label,
    pct_per_hour: Math.round((deltaPct / elapsedHours) * 100) / 100,
    samples: rows.length,
  };
}

function windowAverageRate(used, resetAt, asOfMs, windowKey) {
  const resetMs = Date.parse(resetAt);
  if (!Number.isFinite(resetMs)) return null;
  const windowStart = resetMs - WINDOW_CONFIG[windowKey].hours * 60 * 60 * 1000;
  const elapsedHours = Math.max(0.05, Math.min(WINDOW_CONFIG[windowKey].hours, (asOfMs - windowStart) / (60 * 60 * 1000)));
  if (!Number.isFinite(elapsedHours) || elapsedHours <= 0) return null;
  return {
    basis: "window_avg",
    basis_cn: "窗口平均",
    pct_per_hour: Math.round((used / elapsedHours) * 100) / 100,
    samples: null,
  };
}

function tokenVelocity(data, tool) {
  const windows = data?.usageVelocity?.windows || {};
  const read = (key) => {
    const row = windows[key]?.byTool?.[tool];
    if (!row) return { tok_per_hour: 0, usd_per_hour: 0, model_call_count: 0 };
    return {
      tok_per_hour: Math.round(row.tokPerHour || 0),
      usd_per_hour: Math.round((row.usdPerHour || 0) * 10000) / 10000,
      model_call_count: row.modelCallCount || 0,
    };
  };
  return {
    "15m": read("15m"),
    "60m": read("60m"),
  };
}

function forecastFor(data, tool, windowKey, used, remaining, resetAt, asOf) {
  const asOfMs = Date.parse(asOf);
  const resetMs = Date.parse(resetAt);
  if (!Number.isFinite(asOfMs) || !Number.isFinite(resetMs) || resetMs <= Date.now()) {
    return {
      basis: "insufficient",
      basis_cn: "数据不足",
      pct_per_hour: null,
      eta_minutes: null,
      eta_text: "限额数据不足",
      will_exhaust_before_reset: false,
      basis_options: [],
      risk_reason: "缺少可用 reset 或快照时间",
    };
  }

  const options = SNAPSHOT_HORIZONS
    .map((horizon) => pctRateFromSnapshots(data, tool, windowKey, resetAt, asOfMs, horizon))
    .filter(Boolean);
  const avg = windowAverageRate(used, resetAt, asOfMs, windowKey);
  if (avg) options.push(avg);
  const chosen = options.reduce((best, option) => {
    if (!best) return option;
    return option.pct_per_hour > best.pct_per_hour ? option : best;
  }, null);

  if (!chosen || !chosen.pct_per_hour || chosen.pct_per_hour <= 0) {
    return {
      basis: chosen ? chosen.basis : "insufficient",
      basis_cn: chosen ? chosen.basis_cn : "数据不足",
      pct_per_hour: chosen ? chosen.pct_per_hour : null,
      eta_minutes: null,
      eta_text: "当前速度不足以预测耗尽",
      will_exhaust_before_reset: false,
      basis_options: options,
      risk_reason: "最近速度接近 0 或样本不足",
    };
  }

  const etaHours = remaining / chosen.pct_per_hour;
  const etaMinutes = Math.round(etaHours * 60);
  const willExhaust = Date.now() + etaHours * 60 * 60 * 1000 < resetMs;
  return {
    basis: chosen.basis,
    basis_cn: chosen.basis_cn,
    pct_per_hour: chosen.pct_per_hour,
    eta_minutes: etaMinutes,
    eta_text: willExhaust ? `约 ${etaMinutes} 分钟后耗尽` : "预计 reset 先发生",
    will_exhaust_before_reset: willExhaust,
    basis_options: options,
    risk_reason: willExhaust ? `${chosen.basis_cn}速度显示会早于 reset 耗尽` : "按当前速度预计 reset 先发生",
  };
}

function statusWithForecast(baseStatus, windowKey, forecast, freshness) {
  let status = baseStatus;
  if (freshness === "stale" && status === "normal") status = "tight";
  if (forecast && forecast.will_exhaust_before_reset) {
    const eta = forecast.eta_minutes;
    if (windowKey === "5h" && eta !== null && eta <= 60) status = worseStatus(status, "danger");
    else if (windowKey === "7d" && eta !== null && eta <= 24 * 60) status = worseStatus(status, "danger");
    else status = worseStatus(status, "tight");
  }
  return status;
}

function evaluateToolWindow(data, tool, limitValue, windowKey) {
  const sourceKey = WINDOW_CONFIG[windowKey].sourceKey;
  const source = limitValue && typeof limitValue === "object" ? limitValue[sourceKey] : null;
  const used = source && typeof source === "object" ? clampPercent(source.pct) : null;
  const remaining = used === null ? null : Math.round((100 - used) * 10) / 10;
  const resetAt = toIso(source && source.resetAt);
  const asOf = toIso(limitValue && limitValue.asOf) || toIso(data && data.updatedAt);
  const freshness = freshnessFor(asOf, windowKey);
  const forecast = used === null || remaining === null || !resetAt
    ? forecastFor(null, tool, windowKey, 0, 0, null, asOf)
    : forecastFor(data, tool, windowKey, used, remaining, resetAt, asOf);
  const status = statusWithForecast(statusForRemaining(remaining), windowKey, forecast, freshness);

  return {
    tool,
    status,
    used,
    remaining,
    resetAt,
    resumeAfter: resetAt ? addMinutes(resetAt, 5) : null,
    asOf,
    freshness,
    forecast,
    tokenVelocity: tokenVelocity(data, tool),
  };
}

function chooseWorstTool(rows) {
  return rows.reduce((best, row) => {
    if (!best) return row;
    const rankDelta = STATUS_RANK[row.status] - STATUS_RANK[best.status];
    if (rankDelta > 0) return row;
    if (rankDelta < 0) return best;
    if (row.forecast?.will_exhaust_before_reset && best.forecast?.will_exhaust_before_reset) {
      const rowEta = row.forecast.eta_minutes ?? Number.POSITIVE_INFINITY;
      const bestEta = best.forecast.eta_minutes ?? Number.POSITIVE_INFINITY;
      return rowEta < bestEta ? row : best;
    }
    if (row.forecast?.will_exhaust_before_reset !== best.forecast?.will_exhaust_before_reset) {
      return row.forecast?.will_exhaust_before_reset ? row : best;
    }
    if (row.remaining === null) return best;
    if (best.remaining === null) return row;
    return row.remaining < best.remaining ? row : best;
  }, null);
}

function evaluateWindow(data, windowKey) {
  const limits = data?.limits || {};
  const entries = Object.entries(limits || {});
  const rows = entries.length
    ? entries.map(([tool, limitValue]) => evaluateToolWindow(data, tool, limitValue, windowKey))
    : [evaluateToolWindow(data, "unknown", null, windowKey)];
  const worst = chooseWorstTool(rows) || evaluateToolWindow(data, "unknown", null, windowKey);
  const status = worst.status;

  return {
    status,
    status_cn: STATUS_CN[status],
    tool: worst.tool,
    used_percent: worst.used,
    remaining_percent: worst.remaining,
    remaining_text: windowText(windowKey, status, worst.remaining),
    reset_at: worst.resetAt,
    resume_after: worst.resumeAfter,
    as_of: worst.asOf,
    data_freshness: worst.freshness,
    forecast: worst.forecast,
    token_velocity: worst.tokenVelocity,
    safe_to_start_agent: safeToStartAgent(windowKey, status),
    safe_to_start_heavy_task: safeToStartHeavyTask(status),
    should_pause_running_agents: shouldPauseWindow(windowKey, status),
  };
}

function policyForOverall(status, windows) {
  if (windows["5h"].status === "exhausted" || windows["7d"].status === "exhausted") return "全部等额度";
  if (windows["5h"].status === "danger" || windows["7d"].status === "danger") return "只允许checkpoint";
  if (windows["5h"].status === "tight" || windows["7d"].status === "tight") return "只允许P0/P1";
  if (status === "unknown") return "只允许P0/P1";
  return "正常运行";
}

function messageFor(status, windows) {
  if (status === "exhausted") return "额度接近耗尽，全部等待额度恢复，只允许 checkpoint 和 handoff";
  if (windows["5h"].forecast?.will_exhaust_before_reset) return "5小时额度按当前速度会早于 reset 耗尽，暂停新任务，只允许 checkpoint 和 handoff";
  if (windows["7d"].forecast?.will_exhaust_before_reset) return "7天额度按当前速度会早于 reset 耗尽，停止新并发和大任务";
  if (windows["5h"].status === "danger") return "5小时额度危险，暂停新任务，只允许 checkpoint 和 handoff";
  if (windows["7d"].status === "danger") return "7天额度危险，停止新并发和大任务，只允许 checkpoint";
  if (windows["7d"].status === "tight") return "7天额度偏紧，不启动新并发 Agent，减少低优先级任务";
  if (windows["5h"].status === "tight") return "5小时额度偏紧，只允许 P0/P1，避免重验证和大范围读取";
  if (status === "unknown") return "额度状态未知，保守处理，不启动高消耗任务";
  return "额度充足，可以正常运行";
}

function minFutureIso(values, fallbackMs) {
  const now = Date.now();
  const future = values
    .map((value) => Date.parse(value))
    .filter((value) => Number.isFinite(value))
    .map((value) => Math.max(value, now + 60 * 1000));
  if (!future.length) return new Date(now + fallbackMs).toISOString();
  return new Date(Math.min(...future)).toISOString();
}

function nextCheckAt(status, windows) {
  if (status === "danger" || status === "exhausted") {
    const beforeReset = Object.values(windows)
      .map((windowValue) => windowValue.reset_at)
      .filter(Boolean)
      .map((resetAt) => new Date(Date.parse(resetAt) - RESUME_DELAY_MS).toISOString());
    return minFutureIso(beforeReset, 5 * 60 * 1000);
  }
  if (status === "tight" || status === "unknown") return new Date(Date.now() + 5 * 60 * 1000).toISOString();
  return new Date(Date.now() + 30 * 60 * 1000).toISOString();
}

function shouldResumePausedAgents(windows) {
  if (windows["5h"].status !== "normal" || windows["7d"].status !== "normal") return false;
  const resumeTimes = Object.values(windows)
    .map((windowValue) => Date.parse(windowValue.resume_after))
    .filter((time) => Number.isFinite(time));
  return resumeTimes.every((time) => Date.now() >= time);
}

function unknownQuota(updatedAt = isoNow()) {
  const data = { updatedAt, limits: {}, limitSnapshots: [], usageVelocity: null };
  const windows = {
    "5h": evaluateWindow(data, "5h"),
    "7d": evaluateWindow(data, "7d"),
  };
  const overallStatus = "unknown";
  return {
    overall_status: overallStatus,
    overall_status_cn: STATUS_CN[overallStatus],
    policy: policyForOverall(overallStatus, windows),
    windows,
    safe_to_start_agent: false,
    safe_to_start_heavy_task: false,
    should_pause_running_agents: false,
    should_resume_paused_agents: false,
    next_check_at: nextCheckAt(overallStatus, windows),
    message: messageFor(overallStatus, windows),
    updated_at: updatedAt,
    source: "quota-app",
  };
}

function quotaFromUsage(data) {
  const updatedAt = typeof data?.updatedAt === "string" ? data.updatedAt : isoNow();
  if (!data || typeof data !== "object" || !data.limits || typeof data.limits !== "object") {
    return unknownQuota(updatedAt);
  }

  const windows = {
    "5h": evaluateWindow(data, "5h"),
    "7d": evaluateWindow(data, "7d"),
  };
  const overallStatus = worseStatusFromList([windows["5h"].status, windows["7d"].status]);
  const shouldPause = windows["5h"].should_pause_running_agents
    || windows["7d"].status === "exhausted"
    || windows["5h"].status === "exhausted";

  return {
    overall_status: overallStatus,
    overall_status_cn: STATUS_CN[overallStatus],
    policy: policyForOverall(overallStatus, windows),
    windows,
    safe_to_start_agent: windows["5h"].safe_to_start_agent && windows["7d"].safe_to_start_agent,
    safe_to_start_heavy_task: windows["5h"].safe_to_start_heavy_task && windows["7d"].safe_to_start_heavy_task,
    should_pause_running_agents: shouldPause,
    should_resume_paused_agents: shouldResumePausedAgents(windows),
    next_check_at: nextCheckAt(overallStatus, windows),
    message: messageFor(overallStatus, windows),
    updated_at: updatedAt,
    source: "quota-app",
  };
}

async function readUsageData(options) {
  const filePath = options.mockPath || options.usagePath;
  try {
    const raw = await fs.readFile(filePath, "utf8");
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

function sendJson(res, statusCode, body) {
  res.writeHead(statusCode, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
  });
  res.end(`${JSON.stringify(body, null, 2)}\n`);
}

function createServer(options) {
  return http.createServer(async (req, res) => {
    const url = new URL(req.url || "/", `http://${HOST}:${options.port}`);

    if (req.method !== "GET") {
      sendJson(res, 405, { ok: false, error: "method_not_allowed", source: "quota-app" });
      return;
    }

    if (url.pathname === "/health") {
      sendJson(res, 200, { ok: true, service: "quota-app", updated_at: isoNow() });
      return;
    }

    if (url.pathname === "/quota") {
      const usageData = await readUsageData(options);
      sendJson(res, 200, usageData ? quotaFromUsage(usageData) : unknownQuota());
      return;
    }

    sendJson(res, 404, { ok: false, error: "not_found", source: "quota-app" });
  });
}

function main() {
  let options;
  try {
    options = parseArgs(process.argv);
  } catch (error) {
    console.error(`quota-api: ${error.message}`);
    process.exit(1);
  }

  const server = createServer(options);
  server.on("error", (error) => {
    console.error(`quota-api: ${error.code || error.message}`);
    process.exit(1);
  });
  server.listen(options.port, HOST, () => {
    const dataSource = options.mockPath ? `mock ${options.mockPath}` : options.usagePath;
    console.log(`quota-api listening on http://${HOST}:${options.port} (${dataSource})`);
  });
}

main();
