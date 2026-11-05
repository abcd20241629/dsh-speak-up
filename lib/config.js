// 配置与状态 —— 0.3.0 的「一卡一份」落盘层。
//
// 目录：$DSH_HOME/speak-up/
//   · config.json               全局默认（所有卡共用）
//   · card.<安全卡名>.json       这张卡的覆盖项（只有它跟全局不一样的部分）
//   · card.<安全卡名>.state.json 这张卡的骰子状态（nextRollAt / misses / alarms…）
//
// 所有写盘都是 tmp → rename 原子替换；写失败只记账（lastConfigError），不抛。
// 读坏文件一律回默认值，不 crash —— 设置页要能打开才有救。
//
// 迁移：0.2.9 的 $DSH_HOME/speak-up-config.json（中文键，一份管所有会话）在第一次
// 启动时搬过来，旧文件改名 .migrated，幂等。

import {
  readFileSync, writeFileSync, mkdirSync, existsSync, unlinkSync, renameSync, readdirSync,
} from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { normalizeTimezone, dayKeyAt } from './dice.js'

// ---------- 路径 ----------

function dshHome() {
  return process.env.DSH_HOME || join(homedir(), '.dsh')
}

/** 0.3.0 的数据目录。每次调用都重新算，测试里改 DSH_HOME 能立刻生效。 */
export function configDir() {
  return join(dshHome(), 'speak-up')
}

function globalFile() {
  return join(configDir(), 'config.json')
}

/** 0.2.9 的旧全局配置（迁移来源）。 */
export function legacyConfigFile() {
  return join(dshHome(), 'speak-up-config.json')
}

/** 卡名 → 文件名里能用的安全名。中文原样保留，只换掉路径/控制字符。 */
export function safeCardName(card) {
  const s = String(card == null ? '' : card)
    .replace(/[\\/:*?"<>|\u0000-\u001f\u007f]/g, '_')
    .trim()
  return (s || '_').slice(0, 120)
}

function policyFile(card) {
  return join(configDir(), `card.${safeCardName(card)}.json`)
}

function stateFile(card) {
  return join(configDir(), `card.${safeCardName(card)}.state.json`)
}

// ---------- 默认值 ----------

export const GLOBAL_DEFAULTS = {
  enabled: true,
  dryRun: true,
  intervalMinutes: 30,
  peakThreshold: 20,
  offThreshold: 60,
  timezone: '',
  missBonus: 10,
  bonusCap: 40,
  quietStart: 1,
  quietEnd: 8,
  nearMinutes: 20,
  nearFactor: 0.15,
  farMinutes: 360,
  farFactor: 1.5,
  cooldownMinutes: 20,
  triggerText: '好久没人跟我说话了，我该主动去打个招呼',
  role: 'user',
  dailyCap: 0,
  channel: 'auto', // auto / qq / dsh
  deliverText: true,
}

const GLOBAL_KEYS = Object.keys(GLOBAL_DEFAULTS)

/** 每卡可以覆盖的 17 个键（B 的网页半边按这个数）。 */
export const CARD_KEYS = [
  'enabled',
  'intervalMinutes',
  'peakThreshold',
  'offThreshold',
  'missBonus',
  'bonusCap',
  'quietStart',
  'quietEnd',
  'nearMinutes',
  'nearFactor',
  'farMinutes',
  'farFactor',
  'cooldownMinutes',
  'dailyCap',
  'channel',
  'sessionId',
  'triggerText',
]

export const STATE_DEFAULTS = {
  nextRollAt: 0,
  misses: 0,
  lastSpokeAt: 0,
  lastUserAt: 0, // 0.2.9 的「距上次说话」语义；比 state 契约多一个字段，缺省 0
  rollsToday: 0,
  dayKey: '',
  lastSessionId: '',
  alarms: [],
}

// ---------- 小工具 ----------

let lastError = ''

/** 最近一次读写失败的原因（空串 = 没出错）。只给诊断看，不参与逻辑。 */
export function lastConfigError() {
  return lastError
}

function note(msg) {
  lastError = String(msg || '')
}

function bool(v, def) {
  if (v === true || v === 'true' || v === 1 || v === '1') return true
  if (v === false || v === 'false' || v === 0 || v === '0') return false
  return def
}

function num(v, def, min, max) {
  const n = Number(v)
  if (!Number.isFinite(n)) return def
  return Math.min(max, Math.max(min, n))
}

function int(v, def, min, max) {
  return Math.round(num(v, def, min, max))
}

function text(v, def) {
  return typeof v === 'string' && v.trim() !== '' ? v : def
}

function oneOf(v, def, allowed) {
  const s = String(v == null ? '' : v).trim().toLowerCase()
  return allowed.includes(s) ? s : def
}

/** 读一个 JSON 文件；坏文件 / 不存在都回 null，绝不抛。 */
function readJson(file) {
  try {
    const raw = readFileSync(file, 'utf8').replace(/^\uFEFF/, '')
    const v = JSON.parse(raw)
    return v && typeof v === 'object' && !Array.isArray(v) ? v : null
  } catch (error) {
    if (existsSync(file)) note(`读不动 ${file}：${String((error && error.message) || error)}`)
    return null
  }
}

/** 原子写 JSON。成功 true；失败只记 lastError。 */
function writeJson(file, value) {
  const tmp = `${file}.tmp-${process.pid}-${Math.random().toString(36).slice(2)}`
  try {
    mkdirSync(configDir(), { recursive: true })
    writeFileSync(tmp, JSON.stringify(value, null, 2), 'utf8')
    renameSync(tmp, file)
    return true
  } catch (error) {
    note(`写不进 ${file}：${String((error && error.message) || error)}`)
    try {
      if (existsSync(tmp)) unlinkSync(tmp)
    } catch (e2) {
      /* 清临时文件失败就算了 */
    }
    return false
  }
}

// ---------- 全局 ----------

function normalizeGlobal(raw) {
  const o = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {}
  return {
    enabled: bool(o.enabled, GLOBAL_DEFAULTS.enabled),
    dryRun: bool(o.dryRun, GLOBAL_DEFAULTS.dryRun),
    intervalMinutes: int(o.intervalMinutes, GLOBAL_DEFAULTS.intervalMinutes, 1, 1440),
    peakThreshold: num(o.peakThreshold, GLOBAL_DEFAULTS.peakThreshold, 0, 100),
    offThreshold: num(o.offThreshold, GLOBAL_DEFAULTS.offThreshold, 0, 100),
    timezone: normalizeTimezone(o.timezone),
    missBonus: num(o.missBonus, GLOBAL_DEFAULTS.missBonus, 0, 100),
    bonusCap: num(o.bonusCap, GLOBAL_DEFAULTS.bonusCap, 0, 100),
    quietStart: int(o.quietStart, GLOBAL_DEFAULTS.quietStart, 0, 23),
    quietEnd: int(o.quietEnd, GLOBAL_DEFAULTS.quietEnd, 0, 23),
    nearMinutes: num(o.nearMinutes, GLOBAL_DEFAULTS.nearMinutes, 0, 100000),
    nearFactor: num(o.nearFactor, GLOBAL_DEFAULTS.nearFactor, 0, 100),
    farMinutes: num(o.farMinutes, GLOBAL_DEFAULTS.farMinutes, 0, 100000),
    farFactor: num(o.farFactor, GLOBAL_DEFAULTS.farFactor, 0, 100),
    cooldownMinutes: int(o.cooldownMinutes, GLOBAL_DEFAULTS.cooldownMinutes, 0, 1440),
    triggerText: text(o.triggerText, GLOBAL_DEFAULTS.triggerText),
    role: oneOf(o.role, GLOBAL_DEFAULTS.role, ['user', 'developer']),
    dailyCap: int(o.dailyCap, GLOBAL_DEFAULTS.dailyCap, 0, 10000),
    channel: oneOf(o.channel, GLOBAL_DEFAULTS.channel, ['auto', 'qq', 'dsh']),
    deliverText: bool(o.deliverText, GLOBAL_DEFAULTS.deliverText),
  }
}

export function loadGlobal() {
  const raw = readJson(globalFile())
  return normalizeGlobal(raw)
}

/**
 * 合并式保存全局设置。只认 GLOBAL_KEYS；legacySessionIds 单独保留（迁移用）。
 * @returns 归一化后的全局设置
 */
export function saveGlobal(patch = {}) {
  const cur = readJson(globalFile()) || {}
  const merged = { ...cur, ...(patch && typeof patch === 'object' ? patch : {}) }
  const next = normalizeGlobal(merged)
  const out = { ...next }
  const legacy = Array.isArray(patch && patch.legacySessionIds)
    ? patch.legacySessionIds.filter((x) => typeof x === 'string' && x.trim())
    : Array.isArray(cur.legacySessionIds)
      ? cur.legacySessionIds
      : []
  if (legacy.length) out.legacySessionIds = legacy
  writeJson(globalFile(), out)
  return next
}

// ---------- 每卡覆盖项 ----------

/** 读这张卡的覆盖项（只含它确实改过的键）。 */
export function loadCardOverrides(card) {
  return normalizeOverrides(readJson(policyFile(card)) || {})
}

/** 合并式保存这张卡的覆盖项。值为 null / undefined / '' 表示「删掉这条、回到全局」。 */
export function saveCardPolicy(card, patch = {}) {
  const cur = loadCardOverrides(card)
  const allowed = new Set(CARD_KEYS)
  for (const [k, v] of Object.entries(patch && typeof patch === 'object' ? patch : {})) {
    if (!allowed.has(k)) continue
    if (v === null || v === undefined || v === '') delete cur[k]
    else cur[k] = v
  }
  // 过一遍归一化，顺手把 'false' / '60' 这类字符串洗成真值；非法的键会被丢掉
  const clean = normalizeOverrides(cur)
  writeJson(policyFile(card), clean)
  return loadCardPolicy(card)
}

/** 归一化覆盖对象（不读盘），和 loadCardOverrides 用同一套规则。 */
function normalizeOverrides(o) {
  const out = {}
  const src = o && typeof o === 'object' ? o : {}
  const d = GLOBAL_DEFAULTS
  if (src.enabled !== undefined) out.enabled = bool(src.enabled, d.enabled)
  if (src.intervalMinutes !== undefined) out.intervalMinutes = int(src.intervalMinutes, d.intervalMinutes, 1, 1440)
  if (src.peakThreshold !== undefined) out.peakThreshold = num(src.peakThreshold, d.peakThreshold, 0, 100)
  if (src.offThreshold !== undefined) out.offThreshold = num(src.offThreshold, d.offThreshold, 0, 100)
  if (src.missBonus !== undefined) out.missBonus = num(src.missBonus, d.missBonus, 0, 100)
  if (src.bonusCap !== undefined) out.bonusCap = num(src.bonusCap, d.bonusCap, 0, 100)
  if (src.quietStart !== undefined) out.quietStart = int(src.quietStart, d.quietStart, 0, 23)
  if (src.quietEnd !== undefined) out.quietEnd = int(src.quietEnd, d.quietEnd, 0, 23)
  if (src.nearMinutes !== undefined) out.nearMinutes = num(src.nearMinutes, d.nearMinutes, 0, 100000)
  if (src.nearFactor !== undefined) out.nearFactor = num(src.nearFactor, d.nearFactor, 0, 100)
  if (src.farMinutes !== undefined) out.farMinutes = num(src.farMinutes, d.farMinutes, 0, 100000)
  if (src.farFactor !== undefined) out.farFactor = num(src.farFactor, d.farFactor, 0, 100)
  if (src.cooldownMinutes !== undefined) out.cooldownMinutes = int(src.cooldownMinutes, d.cooldownMinutes, 0, 1440)
  if (src.dailyCap !== undefined) out.dailyCap = int(src.dailyCap, d.dailyCap, 0, 10000)
  if (src.channel !== undefined) out.channel = oneOf(src.channel, d.channel, ['auto', 'qq', 'dsh'])
  if (typeof src.sessionId === 'string' && src.sessionId.trim()) out.sessionId = src.sessionId.trim()
  if (typeof src.triggerText === 'string' && src.triggerText.trim()) out.triggerText = src.triggerText
  return out
}

/** 这张卡的**有效策略**：全局默认 + 全局值 + 这张卡的覆盖。 */
export function loadCardPolicy(card) {
  const global = loadGlobal()
  const over = loadCardOverrides(card)
  return { ...global, ...over, card: String(card) }
}

// ---------- 每卡状态 ----------

function normalizeState(raw) {
  const o = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {}
  const alarms = Array.isArray(o.alarms)
    ? o.alarms
      .filter((a) => a && typeof a === 'object' && typeof a.id === 'string')
      .map((a) => ({
        id: a.id,
        at: Number(a.at) || 0,
        text: String(a.text == null ? '' : a.text),
        repeat: a.repeat === 'daily' || a.repeat === 'interval' ? a.repeat : 'none',
        intervalMinutes: Math.max(0, Number(a.intervalMinutes) || 0),
        createdAt: Number(a.createdAt) || 0,
        card: String(a.card == null ? '' : a.card),
      }))
    : []
  return {
    nextRollAt: Math.max(0, Number(o.nextRollAt) || 0),
    misses: Math.max(0, Math.round(Number(o.misses) || 0)),
    lastSpokeAt: Math.max(0, Number(o.lastSpokeAt) || 0),
    lastUserAt: Math.max(0, Number(o.lastUserAt) || 0),
    rollsToday: Math.max(0, Math.round(Number(o.rollsToday) || 0)),
    dayKey: typeof o.dayKey === 'string' ? o.dayKey : '',
    lastSessionId: typeof o.lastSessionId === 'string' ? o.lastSessionId : '',
    alarms,
  }
}

export function loadCardState(card) {
  const raw = readJson(stateFile(card))
  const state = normalizeState(raw)
  if (!state.dayKey) state.dayKey = dayKeyAt(Date.now())
  return state
}

export function saveCardState(card, patch = {}) {
  const cur = loadCardState(card)
  const next = normalizeState({ ...cur, ...(patch && typeof patch === 'object' ? patch : {}) })
  if (!next.dayKey) next.dayKey = dayKeyAt(Date.now())
  writeJson(stateFile(card), next)
  return next
}

/** 列出磁盘上已经有策略文件的卡名（给诊断用；主流程仍走 cards.js）。 */
export function knownCardNames() {
  try {
    return readdirSync(configDir())
      .filter((f) => /^card\..+\.json$/.test(f) && !f.endsWith('.state.json'))
      .map((f) => f.slice('card.'.length, -'.json'.length))
  } catch (error) {
    return []
  }
}

// ---------- 旧配置迁移 ----------

/** 0.2.9 中文键 → 0.3.0 键。值是函数：取原始值。 */
const LEGACY_MAP = [
  ['总开关', 'enabled'],
  ['试运行', 'dryRun'],
  ['间隔分钟', 'intervalMinutes'],
  ['峰时命中线', 'peakThreshold'],
  ['峰时概率', 'peakThreshold'],
  ['谷时命中线', 'offThreshold'],
  ['谷时概率', 'offThreshold'],
  ['峰谷时区', 'timezone'],
  ['没中加成', 'missBonus'],
  ['加成上限', 'bonusCap'],
  ['安静起', 'quietStart'],
  ['安静止', 'quietEnd'],
  ['近阈值分钟', 'nearMinutes'],
  ['近因子', 'nearFactor'],
  ['远阈值分钟', 'farMinutes'],
  ['远因子', 'farFactor'],
  ['搭话冷却分钟', 'cooldownMinutes'],
  ['自己开口冷却分钟', 'cooldownMinutes'],
  ['触发文案', 'triggerText'],
  ['角色', 'role'],
]

function legacySessionIds(raw) {
  const v = raw && (raw['目标会话'] !== undefined ? raw['目标会话'] : raw.sessionIds)
  const list = Array.isArray(v) ? v : typeof v === 'string' ? v.split(/[\s,;，、]+/) : []
  const out = []
  const seen = new Set()
  for (const x of list) {
    const s = String(x == null ? '' : x).trim()
    if (!s) continue
    const key = s.startsWith('session-') ? s.slice('session-'.length) : s
    if (seen.has(key)) continue
    seen.add(key)
    out.push(s)
  }
  return out
}

/**
 * 幂等迁移：旧文件在、新 config.json 不在 → 搬。
 * @returns {{migrated:boolean, cards:string[]}}
 */
export function migrateLegacy(ctx) {
  const legacy = legacyConfigFile()
  const target = globalFile()
  if (!existsSync(legacy)) return { migrated: false, cards: [] }
  if (existsSync(target)) return { migrated: false, cards: [] }

  let raw = null
  try {
    raw = JSON.parse(readFileSync(legacy, 'utf8').replace(/^\uFEFF/, ''))
  } catch (error) {
    note(`旧配置读不动（${legacy}）：${String((error && error.message) || error)}`)
    return { migrated: false, cards: [] }
  }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { migrated: false, cards: [] }

  const patch = {}
  for (const [oldKey, newKey] of LEGACY_MAP) {
    if (raw[oldKey] !== undefined) patch[newKey] = raw[oldKey]
    else if (raw[newKey] !== undefined && patch[newKey] === undefined) patch[newKey] = raw[newKey]
  }
  const sids = legacySessionIds(raw)
  patch.legacySessionIds = sids

  mkdirSync(configDir(), { recursive: true })
  saveGlobal(patch)
  if (!existsSync(target)) {
    // 写盘失败：旧文件原地不动，下次再试
    return { migrated: false, cards: [] }
  }

  // 旧「目标会话」按记忆库的卡名归属，写进各卡策略。
  const cards = []
  const memoryCore = safeService(ctx, 'memoryCore')
  for (const sid of sids) {
    let card = ''
    try {
      if (memoryCore && typeof memoryCore.cardOf === 'function') card = String(memoryCore.cardOf(sid) || '')
    } catch (error) {
      card = ''
    }
    if (!card || card === 'none') continue
    const cur = loadCardPolicy(card)
    if (!cur.sessionId) saveCardPolicy(card, { sessionId: sid })
    if (!cards.includes(card)) cards.push(card)
  }

  // 旧文件改名 .migrated：先复制再删（rename 在目标已存在时会失败）
  const moved = `${legacy}.migrated`
  try {
    if (!existsSync(moved)) writeFileSync(moved, readFileSync(legacy, 'utf8'), 'utf8')
    unlinkSync(legacy)
  } catch (error) {
    note(`旧配置改名失败：${String((error && error.message) || error)}`)
    try {
      renameSync(legacy, moved)
    } catch (e2) {
      /* 留在原地，下次启动再试 */
    }
  }
  return { migrated: true, cards }
}

function safeService(ctx, name) {
  try {
    return typeof ctx?.get === 'function' ? ctx.get(name) : null
  } catch (error) {
    return null
  }
}

// 让工具能一眼看到有哪些键（诊断/测试用）
export function globalKeys() {
  return [...GLOBAL_KEYS]
}
