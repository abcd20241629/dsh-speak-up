// lib/alarms.js —— 每张卡自己的闹钟表（0.3.0 新增，A3）
//
// 设计口径（CONTRACT.md §2.3 / §3 lib/alarms.js、计划书 §7）：
//   · 闹钟存在该卡 state 的 `alarms` 数组里（card.<安全卡名>.state.json），
//     **只**通过 lib/config.js 的 loadCardState / saveCardState 读写 —— 本文件不碰路径、不碰 JSON 落盘；
//   · 一条闹钟：{ id, at, text, repeat, intervalMinutes, createdAt, card }
//     · at 一律是**本地时区的毫秒数**（Date.now() 同量纲），跨天/跨时区不手算字符串；
//     · repeat: 'none' | 'daily' | 'interval'（**和 config.js normalizeState 的白名单严格一致**）
//       - none     → 到点投递后**移除**
//       - daily    → 推到「明天同一时刻」（本地时间，用 Date.setDate 推，有夏令时的时区也不会错位）
//       - interval → 按 intervalMinutes 往后推，直到落到未来（停过机也不会一次补一串）
//     · ⚠ config.js 的 normalizeState 是**封闭白名单**：闹钟只有
//       id/at/text/repeat/intervalMinutes/createdAt/card 能落盘，state 顶层同理。
//       所以这里不存 failCount / lastFiredAt 之类字段（存了也会被 normalize 抹掉）；
//       投递失败就当场推进或删除，绝不留"每 60s 重试到天亮"的坑。weekly 同理不支持（会被降级成 none）。
//   · 本模块**不装 timer**：触发由 host.js 的 60s tick 调 fireDueAlarms()（或 scheduler 调）。
//
// 读坏文件/写盘失败：只记账不抛（CONTRACT §2 的既有习惯）。config.js 自己会兜底，
// 这里再兜一层，保证"闹钟坏了不影响掷骰子"。

import { readdirSync } from 'node:fs'
import { loadCardState, saveCardState, configDir } from './config.js'

/** 每卡同时存在的闹钟上限。计划书 §7.2 写的是 24；这里放宽到 100，防止 agent 自己写爆。 */
const 每卡上限 = 100

// ---------- 小工具 ----------

const 两位数 = (n) => String(n).padStart(2, '0')

/** 本地时间 → `MM-DD HH:mm`（只用来给人看/给模型看，不参与计算）。 */
export function formatAt(ms) {
  const d = new Date(Number(ms))
  if (!Number.isFinite(d.getTime())) return '??-?? ??:??'
  return `${两位数(d.getMonth() + 1)}-${两位数(d.getDate())} ${两位数(d.getHours())}:${两位数(d.getMinutes())}`
}

/** 到点投递给自己的那句话（计划书 §7.2 的固定格式）。 */
export function alarmText(alarm) {
  const 文案 = String((alarm && alarm.text) || '').trim()
  return `【你自己定的闹钟｜${formatAt(alarm && alarm.at)}】${文案}`
}

/** 读一张卡的 state（坏文件 → 空状态；真读取一律走 config.js）。 */
function 读状态(card) {
  try {
    const st = loadCardState(card)
    if (st && typeof st === 'object') return st
  } catch { /* config.js 读失败：当成空状态，后面的写盘会重建 */ }
  return { alarms: [] }
}

/**
 * 只写 `alarms` 这一个键。
 * ⚠ config.js 的 saveCardState 是**浅合并**（CONTRACT §3），所以不会碰别人的
 *   nextRollAt / misses / lastSpokeAt / rollsToday / dayKey / lastSessionId。
 * @returns {boolean} 是否写成功
 */
function 写闹钟(card, alarms) {
  try {
    saveCardState(card, { alarms })
    return true
  } catch {
    return false
  }
}

/** 随机 4 位 id 尾巴（base36，够用且不引入依赖）。 */
function 随机4位() {
  return Math.random().toString(36).slice(-4).padEnd(4, '0')
}

function 造id(now) {
  return `al-${now}-${随机4位()}`
}

// ---------- 时间解析 ----------

/**
 * 解析 `at`：
 *   · 数字 → 直接当毫秒（>0 才算）；
 *   · `HH:MM` / `HH:MM:SS` → **今天**这个点；已经过了就自动落到**明天**（找"最近的下一次"）；
 *   · ISO / `YYYY-MM-DD HH:mm` / 任何 Date 认得的字符串 → Date 解析（不带时区按本地时间）；
 *   · 其他 → 0（调用方当"没给"处理）。
 * @returns {number} 毫秒时间戳；解析不了返回 0
 */
export function parseAt(input, now = Date.now()) {
  if (typeof input === 'number') return Number.isFinite(input) && input > 0 ? input : 0
  const 原 = String(input == null ? '' : input).trim()
  if (!原) return 0

  const 时分 = 原.match(/^(\d{1,2}):(\d{2})(?::(\d{2}))?$/)
  if (时分) {
    const 时 = Number(时分[1])
    const 分 = Number(时分[2])
    const 秒 = Number(时分[3] || 0)
    if (时 > 23 || 分 > 59 || 秒 > 59) return 0
    const d = new Date(now)
    d.setHours(时, 分, 秒, 0)
    if (d.getTime() <= now) d.setDate(d.getDate() + 1) // 今天这个点已经过了 → 明天同一时刻
    return d.getTime()
  }

  const 数字 = Number(原)
  if (!/^\d{4}-/.test(原) && Number.isFinite(数字) && 数字 > 0) return 数字 // 毫秒字符串

  // 'YYYY-MM-DD HH:mm' 这种 Node 也认，但保险起见把空格换成 T（不带时区 = 本地时间）
  const 整理 = /^\d{4}-\d{2}-\d{2}\s+\d{2}:\d{2}/.test(原) ? 原.replace(/\s+/, 'T') : 原
  const t = new Date(整理).getTime()
  return Number.isFinite(t) && t > 0 ? t : 0
}

/**
 * 算这条闹钟的**下一次** at。
 * @returns {number} 0 = 不再复发（该删）
 */
function 下一次at(alarm, now) {
  const repeat = String((alarm && alarm.repeat) || 'none')
  const 当前 = Number(alarm && alarm.at) || 0
  if (!当前) return 0

  if (repeat === 'daily') {
    // 用本地 Date.setDate 推：这样保的是"墙上时间"而不是"86400000 毫秒后"。
    const d = new Date(当前)
    let 安全 = 0
    do {
      d.setDate(d.getDate() + 1)
      安全 += 1
    } while (d.getTime() <= now && 安全 < 4000) // 4000 次 = 10 多年，纯属防死循环
    return d.getTime()
  }

  if (repeat === 'interval') {
    const 步长 = Math.max(1, Math.floor(Number(alarm.intervalMinutes) || 0)) * 60000
    if (!步长) return 0
    let t = 当前 + 步长
    let 安全 = 0
    while (t <= now && 安全 < 100000) {
      t += 步长
      安全 += 1
    }
    return t
  }

  return 0 // 'none' 或未知值 → 一次性
}

// ---------- 对外 API（CONTRACT §3） ----------

/** 这张卡的所有闹钟（按 at 升序；返回副本，外面改了不影响盘上的）。 */
export function alarmsOf(card) {
  const st = 读状态(card)
  const 列表 = Array.isArray(st.alarms) ? st.alarms : []
  return 列表
    .filter((a) => a && typeof a === 'object')
    .map((a) => ({ ...a }))
    .sort((x, y) => (Number(x.at) || 0) - (Number(y.at) || 0))
}

/**
 * 新建一条闹钟。
 * @param {string} card 卡名（必填）
 * @param {{at?:string|number, inMinutes?:number, text:string, repeat?:string, intervalMinutes?:number}} opts
 * @param {number} [now] 测试用
 * @returns {object|null} 成功返回闹钟副本；参数不合法（没卡/没文案/没时间/超上限）返回 null
 */
export function createAlarm(card, opts = {}, now = Date.now()) {
  const 卡 = String(card || '').trim()
  if (!卡 || 卡 === 'none') return null

  const text = String(opts.text == null ? '' : opts.text).trim()
  if (!text) return null

  const 重复 = ['none', 'daily', 'interval'].includes(String(opts.repeat))
    ? String(opts.repeat)
    : 'none'
  const intervalMinutes = Math.max(0, Math.floor(Number(opts.intervalMinutes) || 0))
  if (重复 === 'interval' && intervalMinutes < 1) return null

  // 先看 at（ISO / HH:MM），没有再看到 inMinutes；两个都没给 = 不合法。
  let atMs = 0
  if (opts.at !== undefined && opts.at !== null && String(opts.at).trim() !== '') {
    atMs = parseAt(opts.at, now)
  }
  if (!atMs) {
    const 分钟 = Number(opts.inMinutes)
    if (Number.isFinite(分钟) && 分钟 > 0) atMs = now + Math.round(分钟 * 60000)
  }
  if (!atMs) return null

  const st = 读状态(卡)
  const 列表 = (Array.isArray(st.alarms) ? st.alarms : []).filter((a) => a && typeof a === 'object')
  if (列表.length >= 每卡上限) return null

  let id = 造id(now)
  let 防撞 = 0
  while (列表.some((a) => String(a.id) === id) && 防撞 < 50) {
    id = 造id(now)
    防撞 += 1
  }

  const alarm = { id, at: atMs, text, repeat: 重复, intervalMinutes, createdAt: now, card: 卡 }
  列表.push(alarm)
  if (!写闹钟(卡, 列表)) return null
  return { ...alarm }
}

/**
 * 取消一条闹钟。
 * @returns {boolean} 真的删掉了才 true（id 不存在/false/写盘失败都是 false）
 */
export function cancelAlarm(card, id) {
  const 目标 = String(id == null ? '' : id).trim()
  if (!目标) return false
  const st = 读状态(card)
  const 列表 = Array.isArray(st.alarms) ? st.alarms.filter((a) => a && typeof a === 'object') : []
  const 剩下 = 列表.filter((a) => String(a.id) !== 目标)
  if (剩下.length === 列表.length) return false
  return 写闹钟(card, 剩下)
}

/**
 * 找出 `at <= now` 的闹钟。
 *
 * 卡列表来源（顺序）：
 *   ① options.cards —— 宿主用 cards.listCards(ctx) 传进来最准；
 *   ② configDir() 目录里的 `card.<安全卡名>.state.json` 文件名反推（安全名对普通中文卡名是恒等映射）；
 *   ③ 都没有 → 空数组。
 * @param {number} [now]
 * @param {{cards?: string[]}} [options]
 * @returns {Array<{card: string, alarm: object}>} 按 at 升序
 */
export function dueAlarms(now = Date.now(), options = {}) {
  // 注意：`cards: []` 是「宿主明确说这批卡现在都不该响」（比如全在安静时段），
  // 必须尊重成空结果；只有**没传 cards** 时才退回扫目录。以前用 length 判断，
  // 结果安静时段过滤等于失效——半夜会响。
  const 指定 = options && Array.isArray(options.cards) ? options.cards.filter(Boolean) : null
  const 卡们 = 指定 !== null ? 指定 : 扫描有状态的卡()
  const 到点 = []
  for (const card of 卡们) {
    const st = 读状态(card)
    const 列表 = Array.isArray(st.alarms) ? st.alarms : []
    for (const alarm of 列表) {
      if (!alarm || typeof alarm !== 'object') continue
      const at = Number(alarm.at)
      if (!Number.isFinite(at) || at <= 0) continue
      if (at <= now) 到点.push({ card, alarm: { ...alarm } })
    }
  }
  到点.sort((x, y) => (Number(x.alarm.at) || 0) - (Number(y.alarm.at) || 0))
  return 到点
}

/**
 * 一条闹钟「响过了」之后推进它（复发）或删掉它（一次性）。
 * @returns {object|null} 复发 → 更新后的 alarm；一次性/找不到 → null
 */
export function fireAlarm(card, id, now = Date.now()) {
  const 目标 = String(id == null ? '' : id).trim()
  if (!目标) return null
  const st = 读状态(card)
  const 列表 = (Array.isArray(st.alarms) ? st.alarms : []).filter((a) => a && typeof a === 'object')
  const 位置 = 列表.findIndex((a) => String(a.id) === 目标)
  if (位置 < 0) return null

  const 当前 = 列表[位置]
  const 下一个 = 下一次at(当前, now)
  if (!下一个) {
    列表.splice(位置, 1)
    写闹钟(card, 列表)
    return null
  }

  const 更新 = { ...当前, at: 下一个 }
  列表[位置] = 更新
  if (!写闹钟(card, 列表)) return null
  return { ...更新 }
}

/**
 * 到点触发（给 host.js 的 60s tick / scheduler 调；**本模块不装 timer**）。
 *
 * 对每条到点的闹钟：`await deps.deliver(card, '自动', { text, alarm })`，
 * 成功 → fireAlarm() 推进/删除；
 * 失败 → **也推进/删除**（不进重试队列：config.js 的 state 白名单存不下重试计数，
 *        留着重试只会每 60s 打一次，把失败刷屏）。失败记在返回值里给宿主看。
 * 单条失败不影响别的条（Promise.allSettled）。
 *
 * @param {object} ctx 宿主 ctx（给 deps.cards 用；deps.deliver 由宿主闭包持有）
 * @param {{
 *   deliver?: (card: string, mode: string, extra?: object) => any,
 *   log?: (text: string, card?: string) => void,
 *   cards?: string[] | ((ctx: object) => string[] | Promise<string[]>),
 * }} deps
 * @param {number} [now]
 * @returns {Promise<{fired: object[], failed: object[], skipped: object[]}>}
 */
export async function fireDueAlarms(ctx, deps = {}, now = Date.now()) {
  const 结果 = { fired: [], failed: [], skipped: [] }

  let 卡们 = null
  try {
    if (Array.isArray(deps.cards)) 卡们 = deps.cards.filter(Boolean)
    else if (typeof deps.cards === 'function') 卡们 = (await deps.cards(ctx)) || []
  } catch { 卡们 = null }

  // 卡们 === null 表示「宿主没给名单」（读失败/没注入），才退回扫全部 state；
  // 空数组是明确结论：这一轮没有卡能响，什么都不做。
  const 到点 = 卡们 === null ? dueAlarms(now, {}) : dueAlarms(now, { cards: 卡们 })
  if (!到点.length) return 结果

  const deliver = typeof deps.deliver === 'function' ? deps.deliver : null
  const log = typeof deps.log === 'function' ? deps.log : () => {}
  if (!deliver) {
    结果.skipped.push({ reason: 'no-deliver', count: 到点.length })
    return 结果
  }

  const 投递们 = await Promise.allSettled(到点.map(({ card, alarm }) => (
    Promise.resolve(deliver(card, '自动', { text: alarmText(alarm), alarm }))
      .then(() => ({ card, alarm }))
  )))

  投递们.forEach((项, i) => {
    const { card, alarm } = 到点[i]
    if (项.status === 'fulfilled') {
      const 更新 = fireAlarm(card, alarm.id, now)
      结果.fired.push({ card, id: alarm.id, text: alarm.text, next: 更新 ? 更新.at : 0 })
      log(`闹钟触发（${card}）：${alarm.text}`, card)
      return
    }
    const 原因 = (项.reason && (项.reason.message || String(项.reason))) || 'unknown'
    // 失败也推进/删除：不留重试队列（理由见函数头注释）。
    const 更新 = fireAlarm(card, alarm.id, now)
    结果.failed.push({ card, id: alarm.id, text: alarm.text, error: 原因, next: 更新 ? 更新.at : 0 })
    log(`闹钟投递失败（${card}）：${原因} —— 这条${更新 ? '已推到下一次' : '已丢弃'}，不重试`, card)
  })

  return 结果
}

// ---------- 内部：从状态目录反推卡名 ----------

/**
 * 从 configDir() 里扫出「有 state 文件的卡」。
 * 只读文件名做枚举（不解析、不写），真正的读写仍全部走 config.js。
 * 安全卡名对普通卡名（中文/字母/数字）是恒等映射；如果卡名里带 `\ / : * ? " < > |`，
 * 反推会失真 —— 那种情况宿主应该用 deps.cards 显式传卡列表。
 */
function 扫描有状态的卡() {
  let 目录 = ''
  try { 目录 = configDir() } catch { return [] }
  if (!目录) return []
  let 文件们 = []
  try { 文件们 = readdirSync(目录) } catch { return [] }
  const 卡们 = []
  for (const 文件名 of 文件们) {
    const m = 文件名.match(/^card\.(.+)\.state\.json$/)
    if (!m) continue
    if (!卡们.includes(m[1])) 卡们.push(m[1])
  }
  return 卡们
}

/** 给 UI / host 自检用：当前状态目录（就是 config.js 的 configDir()，不存在也不保证创建）。 */
export function alarmDir() {
  try { return String(configDir() || '') } catch { return '' }
}
