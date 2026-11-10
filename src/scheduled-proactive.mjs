// 定点主动（scheduledProactive）的纯函数部分：配置归一化 + 「今天这一条该不该发」的判定。
//
// 为什么要单独成文件：bridge.js 已经一万七千多行，调度判定这类纯逻辑写在里面既没法单测、
// 也没法在不启动进程的情况下复现边界（比如「停机两小时后开机，还该不该补发」）。
// 这里只放不依赖 fs / 网络 / 全局状态的函数，bridge.js 负责日志、状态落盘和真正的投递。

const TIME_RE = /^(\d{1,2}):(\d{2})$/;
const KEY_RE = /^(group|private):\d+$/;
const DEFAULT_GRACE_MS = 30 * 60 * 1000;
const MAX_TEXT_CHARS = 400;

/**
 * 'HH:MM' 是否是可执行的本地时刻。
 * 只测正则不够：`25:00` 也能过 `^\d{1,2}:\d{2}$`，但 setHours(25) 会滚到第二天，
 * 结果变成一个谁也没预期的时刻——所以范围必须单独校验。
 */
export function isValidTime(time) {
  const m = TIME_RE.exec(String(time ?? ''));
  if (!m) return false;
  const hour = Number(m[1]);
  const minute = Number(m[2]);
  return hour <= 23 && minute <= 59;
}

/**
 * 把配置里的 scheduledProactive 块归一化成可执行条目。
 * 无效条目（时间格式错、没有合法 keys）直接丢弃——宁可这条不生效，也不要凌晨瞎发。
 */
export function normalizeScheduledItems(block) {
  if (!block || block.enabled === false) return [];
  const items = Array.isArray(block.items) ? block.items : [];
  const out = [];
  for (let index = 0; index < items.length; index++) {
    const it = items[index];
    if (!it || it.enabled === false) continue;
    const time = String(it.time ?? '').trim();
    if (!isValidTime(time)) continue;
    const keys = (Array.isArray(it.keys) ? it.keys : [])
      .map((k) => String(k).trim())
      .filter((k) => KEY_RE.test(k));
    if (!keys.length) continue;
    out.push({
      id: String(it.id ?? `item-${index + 1}`),
      time,
      keys,
      text: String(it.text ?? '').slice(0, MAX_TEXT_CHARS),
      graceMs: Math.max(0, Number(it.graceMs ?? DEFAULT_GRACE_MS) || 0),
    });
  }
  return out;
}

/** 本地日期键（YYYY-MM-DD），用于「同一个 item 每天只投一次」。 */
export function scheduledDayKey(now) {
  const d = new Date(now);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

/**
 * 今天这一条的状态：
 *   null                     还没到点
 *   { state: 'due' }         到点了，且在 graceMs 补发窗口内 —— 该发
 *   { state: 'missed' }      过了补发窗口（停机太久）—— 今天作废，但要留日志，不能静默
 */
export function scheduledDueState(item, now) {
  if (!isValidTime(item?.time)) return null;
  const m = TIME_RE.exec(String(item.time));
  const hour = Number(m[1]);
  const minute = Number(m[2]);
  const target = new Date(now);
  target.setHours(hour, minute, 0, 0);
  const delta = now - target.getTime();
  if (delta < 0) return null;
  const graceMs = Math.max(0, Number(item?.graceMs ?? DEFAULT_GRACE_MS) || 0);
  if (delta > graceMs) return { state: 'missed', target, delta };
  return { state: 'due', target, delta };
}
