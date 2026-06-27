// 共享小工具:UTC+8 切天、连续日期、取整。供编排器与各数据源复用。
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

const MS_DAY = 86400000;
const TZ_OFFSET_MS = 8 * 3600 * 1000; // UTC+8

// UTC ISO8601 时间戳 → 显式 +8h 后取 UTC 年月日,保证全程 UTC+8,不依赖运行机时区
export function dayKeyUTC8(iso) {
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return null;
  return new Date(t + TZ_OFFSET_MS).toISOString().slice(0, 10); // "YYYY-MM-DD"
}

export function todayKeyUTC8() {
  return new Date(Date.now() + TZ_OFFSET_MS).toISOString().slice(0, 10);
}

// 含首尾的连续日期序列 ["YYYY-MM-DD", ...]
export function eachDay(fromKey, toKey) {
  const out = [];
  let cur = Date.parse(fromKey + "T00:00:00Z");
  const end = Date.parse(toKey + "T00:00:00Z");
  for (; cur <= end; cur += MS_DAY) out.push(new Date(cur).toISOString().slice(0, 10));
  return out;
}

export const round4 = (n) => Math.round(n * 1e4) / 1e4;

const PROJECT_CACHE = new Map();
const EXPECTED_FS_CODES = new Set(["ENOENT", "ENOTDIR", "EACCES", "EPERM"]);

function isExpectedFsError(err) {
  return err && EXPECTED_FS_CODES.has(err.code);
}

function statOrNull(target) {
  try {
    return fs.statSync(target);
  } catch (err) {
    if (!isExpectedFsError(err)) throw err;
    return null;
  }
}

function realpathOrResolve(target) {
  const resolved = path.resolve(target);
  try {
    return fs.realpathSync.native(resolved);
  } catch (err) {
    if (!isExpectedFsError(err)) throw err;
    return resolved;
  }
}

function nearestProjectRoot(full) {
  const seen = [];
  let dir = full;
  const st = statOrNull(dir);
  if (st && !st.isDirectory()) dir = path.dirname(dir);

  while (dir && dir !== path.dirname(dir)) {
    seen.push(dir);
    if (fs.existsSync(path.join(dir, ".git"))) return dir;
    dir = path.dirname(dir);
  }
  for (const candidate of seen) {
    if (
      fs.existsSync(path.join(candidate, "pnpm-workspace.yaml")) ||
      fs.existsSync(path.join(candidate, "package.json")) ||
      fs.existsSync(path.join(candidate, "pyproject.toml")) ||
      fs.existsSync(path.join(candidate, "Cargo.toml"))
    ) {
      return candidate;
    }
  }
  return full;
}

function displayPathOf(full) {
  const home = process.env.HOME || "";
  if (home && (full === home || full.startsWith(home + path.sep))) return "~" + full.slice(home.length);
  const hash = crypto.createHash("sha1").update(full).digest("hex").slice(0, 8);
  return { id: "external:" + hash, name: "外部项目 " + hash, path: "外部位置/" + hash };
}

export function projectOf(cwd) {
  if (!cwd || typeof cwd !== "string") return { id: "unknown", name: "未知项目", path: null };
  if (PROJECT_CACHE.has(cwd)) return PROJECT_CACHE.get(cwd);
  const full = realpathOrResolve(cwd);
  const root = nearestProjectRoot(full);
  const display = displayPathOf(root);
  const id = typeof display === "string" ? display : display.id;
  const displayPath = typeof display === "string" ? display : display.path;
  const name = typeof display === "string" ? (displayPath === "~" ? "Home" : path.basename(root) || displayPath) : display.name;
  const project = { id, name, path: displayPath };
  PROJECT_CACHE.set(cwd, project);
  return project;
}
