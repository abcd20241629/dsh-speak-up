// 骰子与时钟 —— 全是纯函数，不读磁盘、不碰网络、不花 token。
//
// 从 host.js 0.2.9 的纯函数段搬出来，加上 0.3.0 每卡调度要用的几件小工具：
//   · 安静时段（含起不含止、可跨零点）
//   · 峰谷分时（周一到周五 09:00–12:00 / 14:00–18:00 是峰时）
//   · 命中线 = 档位命中线 × 时机因子 + min(加成上限, 连没中 × 没中加成)
//   · 掷骰（Math.random() * 100 < 命中线）
//   · 下一次掷骰时刻（intervalMinutes + ±10% 抖动，别让所有卡同一秒掷）
//
// ⚠ 中文别名（判峰时 / 算基础命中线 / 算命中线 / 规整时区名 / 在安静时段）是给
//   tests/宿主半边.mjs 和 host.js 的旧导出兼容用的，别删。

/** IANA 时区名规整：只留长得像的；写错就当没填（留空 = 本机时区）。 */
export function normalizeTimezone(v) {
  const s = String(v == null ? '' : v).trim().slice(0, 64)
  if (!s) return ''
  if (!/^[A-Za-z][A-Za-z0-9_+-]*(\/[A-Za-z0-9_+-]+)*$/.test(s)) return ''
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: s })
    return s
  } catch (error) {
    return ''
  }
}

/** 这个时刻在指定时区是「周几 + 当天第几分钟」。时区空 / 写错 → 退回本机时区。 */
export function weekdayAndMinutes(at = new Date(), timezone = '') {
  const d = at instanceof Date ? at : new Date(at)
  const local = () => ({ weekday: d.getDay(), minutes: d.getHours() * 60 + d.getMinutes() })
  const tz = String(timezone || '').trim()
  if (!tz) return local()
  try {
    const fmt = new Intl.DateTimeFormat('en-US', {
      timeZone: tz,
      weekday: 'short',
      hour: '2-digit',
      minute: '2-digit',
      hour12: false,
    })
    const parts = fmt.formatToParts(d)
    const pick = (type) => {
      const x = parts.find((y) => y.type === type)
      return x ? x.value : ''
    }
    const names = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 }
    const weekday = names[pick('weekday')]
    const hour = Number(pick('hour')) % 24 // 个别环境半夜给 "24"
    const minutes = Number(pick('minute'))
    if (weekday === undefined || !Number.isFinite(hour) || !Number.isFinite(minutes)) return local()
    return { weekday, minutes: hour * 60 + minutes }
  } catch (error) {
    return local()
  }
}

/** 峰时的两段窗口（当天第几分钟，含起不含止）。 */
const PEAK_WINDOWS = [
  [9 * 60, 12 * 60],
  [14 * 60, 18 * 60],
]

/** 是不是峰时（贵）。周末全天谷时；边界 09:00 峰、12:00 谷、14:00 峰、18:00 谷。 */
export function isPeakTime(at = new Date(), timezone = '') {
  const { weekday, minutes } = weekdayAndMinutes(at, timezone)
  if (weekday === 0 || weekday === 6) return false
  return PEAK_WINDOWS.some(([start, end]) => minutes >= start && minutes < end)
}

/** 按时刻挑基础命中线，并给一句能直接写进日志的短称呼。 */
export function baseThreshold(policy, at = new Date()) {
  const tz = policy && (policy.timezone != null ? policy.timezone : policy.峰谷时区)
  const peak = isPeakTime(at, tz)
  const peakValue = Number(policy && (policy.peakThreshold != null ? policy.peakThreshold : policy.峰时命中线))
  const offValue = Number(policy && (policy.offThreshold != null ? policy.offThreshold : policy.谷时命中线))
  const base = peak
    ? (Number.isFinite(peakValue) ? peakValue : 20)
    : (Number.isFinite(offValue) ? offValue : 60)
  return {
    peak,
    base,
    phrase: peak ? `峰时命中线 ${base}%` : `谷时命中线 ${base}%`,
    峰: peak,
    基础命中线: base,
    短语: peak ? `峰时命中线 ${base}%` : `谷时命中线 ${base}%`,
  }
}

/**
 * 命 中 线 = 基础命中线 × 时机因子 + min(加成上限, 连没中 × 没中加成)，夹 0~100。
 * ⚠ 顺序：先乘因子、再加攒下来的加成。
 */
export function threshold(base, factor, misses, missBonus, bonusCap) {
  const b = Number(base)
  const f = Number.isFinite(Number(factor)) ? Number(factor) : 1
  const m = Math.max(0, Number(misses) || 0)
  const step = Math.max(0, Number(missBonus) || 0)
  const cap = Math.max(0, Number(bonusCap) || 0)
  const bonus = Math.min(cap, m * step)
  const line = Math.min(100, Math.max(0, (Number.isFinite(b) ? b : 0) * f + bonus))
  return { bonus, line, 加成: bonus, 线: line }
}

/**
 * 时机因子：距「上次有人说话」越近越不想插话，越远越想冒泡。
 * state.lastUserAt（人上次说话）优先；没有就看 state.lastSpokeAt（这张卡上次开口）。
 * 从没记录 → 1（不奖不罚）。
 */
export function timeFactor(state, policy, now = Date.now()) {
  const last = Number((state && (state.lastUserAt || state.lastSpokeAt)) || 0)
  if (!last || !Number.isFinite(last)) return 1
  const minutes = (Number(now) - last) / 60000
  if (!Number.isFinite(minutes) || minutes < 0) return 1
  const near = Number(policy && policy.nearMinutes)
  const far = Number(policy && policy.farMinutes)
  const nearFactor = Number(policy && policy.nearFactor)
  const farFactor = Number(policy && policy.farFactor)
  if (Number.isFinite(near) && minutes < near) return Number.isFinite(nearFactor) ? nearFactor : 0.15
  if (Number.isFinite(far) && minutes > far) return Number.isFinite(farFactor) ? farFactor : 1.5
  return 1
}

/** 安静时段：含起不含止；起 === 止 表示不启用；起 > 止 跨零点。 */
export function inQuietHours(hour, start, end) {
  const h = Number(hour)
  const a = Number(start)
  const b = Number(end)
  if (!Number.isFinite(h) || !Number.isFinite(a) || !Number.isFinite(b)) return false
  if (a === b) return false
  if (a < b) return h >= a && h < b
  return h >= a || h < b
}

/** 这次掷到的数（0~100）。 */
export function rollValue() {
  return Math.random() * 100
}

/** 掷一次：掷到命中线以下才算中。第二个参数只给日志复用同一个随机数。 */
export function roll(hitLine, value = rollValue()) {
  const line = Number(hitLine)
  if (!Number.isFinite(line) || line <= 0) return false
  if (line >= 100) return true
  return value < line
}

/** 下一次该掷的时刻：从 from 起 intervalMinutes 分钟，带 ±10% 抖动。 */
export function nextRollAt(policy, from = Date.now()) {
  const interval = Number(policy && policy.intervalMinutes)
  const minutes = Number.isFinite(interval) && interval > 0 ? Math.min(1440, Math.max(1, interval)) : 30
  const base = minutes * 60 * 1000
  const jitter = base * (Math.random() * 0.2 - 0.1)
  return Math.round(Number(from) + base + jitter)
}

/** 安静时段结束的时刻（ms）。不在安静时段就返回 now。 */
export function quietEndsAt(policy, now = Date.now()) {
  const start = Number(policy && policy.quietStart)
  const end = Number(policy && policy.quietEnd)
  const at = new Date(now)
  if (!Number.isFinite(start) || !Number.isFinite(end)) return Number(now)
  if (!inQuietHours(at.getHours(), start, end)) return Number(now)
  const candidate = new Date(at)
  candidate.setHours(end, 0, 0, 0)
  if (candidate.getTime() <= Number(now)) candidate.setDate(candidate.getDate() + 1)
  return candidate.getTime()
}

/** 明天 0 点（本机时区）。dailyCap 用完之后推到这儿。 */
export function startOfNextDay(now = Date.now()) {
  const d = new Date(now)
  d.setHours(24, 0, 0, 0)
  return d.getTime()
}

const pad2 = (n) => String(n).padStart(2, '0')

/** 日期键 YYYY-MM-DD（用于 rollsToday 跨天清零）；给时区就按那个时区。 */
export function dayKeyAt(now = Date.now(), timezone = '') {
  const d = now instanceof Date ? now : new Date(now)
  const tz = normalizeTimezone(timezone)
  if (!tz) return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`
  try {
    const parts = new Intl.DateTimeFormat('en-CA', {
      timeZone: tz,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    }).formatToParts(d)
    const pick = (type) => (parts.find((x) => x.type === type) || {}).value || ''
    const y = pick('year')
    const m = pick('month')
    const day = pick('day')
    if (y && m && day) return `${y}-${m}-${day}`
  } catch (error) {
    /* 时区写坏：退回本机 */
  }
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`
}

// ---------- 中文别名（0.2.9 兼容） ----------

export const 规整时区名 = normalizeTimezone
export const 取周几和分钟 = (at = new Date(), timezone = '') => {
  const { weekday, minutes } = weekdayAndMinutes(at, timezone)
  return { 周几: weekday, 分: minutes }
}
export const 判峰时 = isPeakTime
export const 算基础命中线 = baseThreshold
export const 算命中线 = threshold
export const 在安静时段 = inQuietHours
