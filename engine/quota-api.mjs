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
  "5h": { sourceKey: "fiveHour", label: "5小时" },
  "7d": { sourceKey: "sevenDay", label: "7天" },
};

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

function evaluateToolWindow(tool, limitValue, windowKey) {
  const sourceKey = WINDOW_CONFIG[windowKey].sourceKey;
  const source = limitValue && typeof limitValue === "object" ? limitValue[sourceKey] : null;
  const used = source && typeof source === "object" ? clampPercent(source.pct) : null;
  const remaining = used === null ? null : Math.round((100 - used) * 10) / 10;
  const status = statusForRemaining(remaining);
  const resetAt = toIso(source && source.resetAt);

  return {
    tool,
    status,
    remaining,
    resetAt,
    resumeAfter: resetAt ? addMinutes(resetAt, 5) : null,
  };
}

function chooseWorstTool(rows) {
  return rows.reduce((best, row) => {
    if (!best) return row;
    const rankDelta = STATUS_RANK[row.status] - STATUS_RANK[best.status];
    if (rankDelta > 0) return row;
    if (rankDelta < 0) return best;
    if (row.remaining === null) return best;
    if (best.remaining === null) return row;
    return row.remaining < best.remaining ? row : best;
  }, null);
}

function evaluateWindow(limits, windowKey) {
  const entries = Object.entries(limits || {});
  const rows = entries.length
    ? entries.map(([tool, limitValue]) => evaluateToolWindow(tool, limitValue, windowKey))
    : [evaluateToolWindow("unknown", null, windowKey)];
  const worst = chooseWorstTool(rows) || evaluateToolWindow("unknown", null, windowKey);
  const status = worst.status;

  return {
    status,
    status_cn: STATUS_CN[status],
    remaining_percent: worst.remaining,
    remaining_text: windowText(windowKey, status, worst.remaining),
    reset_at: worst.resetAt,
    resume_after: worst.resumeAfter,
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
  const windows = {
    "5h": evaluateWindow({}, "5h"),
    "7d": evaluateWindow({}, "7d"),
  };
  const overallStatus = "unknown";
  return {
    overall_status: overallStatus,
    overall_status_cn: STATUS_CN[overallStatus],
    policy: policyForOverall(overallStatus, windows),
    windows,
    safe_to_start_agent: true,
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
    "5h": evaluateWindow(data.limits, "5h"),
    "7d": evaluateWindow(data.limits, "7d"),
  };
  const overallStatus = worseStatus(windows["5h"].status, windows["7d"].status);
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
