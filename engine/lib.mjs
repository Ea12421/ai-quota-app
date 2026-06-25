// 共享小工具:UTC+8 切天、连续日期、取整。供编排器与各数据源复用。
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
