// lib/delivery.js —— 投递层：把一句「念头」送到某张卡自己的会话里（0.3.0 新增，A2）
//
// 口径（CONTRACT.md §3 lib/delivery.js、计划书 §5 / §6）：
//   1) 先找**这张卡自己的**会话（绝不能拿别的卡的会话投递 —— memory-core 按会话
//      所属卡记记忆，串鱼比不投递更糟）；
//   2) 没有就现开一条：**先登记、再 create**（照抄 bili-whale openSession 的铁律）——
//      先 create 的话，第一句话就已经用 active 卡的口气说了；
//   3) 消息 source 必须带 plugin，否则 memory-core 会把它当主人说的话写进记忆库；
//   4) followup 必须 await（2026-10-21 真机事故：reject 漏出去 = 宿主进程退出）；
//   5) 本模块**所有失败只返回结构化错误，绝不 throw** —— scheduler 并行投递依赖这一点。
//
// 依赖注入口径：sessionController / settings / memoryCore / workspaceRegistry 全部
// 通过 `ctx.get(name)` 现拿（拿不到就降级）；config.js 用**动态 import**，
// 这样 A1 还没落地 config.js 时本模块的单测也能独立跑。

import { readFileSync, writeFileSync, renameSync, existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { cardQQTarget, sendQQ } from './channels.js'

// ---------- 常量 ----------

const 源标记 = 'speak-up'
const 插件名 = 'dsh-speak-up'
const 默认触发文案 = '好久没人跟我说话了，我该主动去打个招呼'

/** 等她自己说话的耐心（契约 §3：最多 120s）；计划书写 180s，以契约为准。 */
const 回复超时毫秒 = 120 * 1000
/** 轮询间隔（契约 §3：15s 一次）；计划书写 5s，以契约为准。 */
const 轮询间隔毫秒 = 15 * 1000
/** agent 正忙时等她闲下来的耐心（计划书 §5.2：30s 一次、最多 2 次）。 */
const 忙等待毫秒 = 30 * 1000
const 忙重试次数 = 2

/** 没绑 QQ 的卡，投递念头里要带的那句提醒（计划书 §6.4 的原话）。 */
const 没绑QQ提醒 = '（你现在还没有 QQ 号，主人只在 DSH 里能看见你；'
  + '记得提醒他给你一个号，绑好了你就能主动找到他。）'

/** 她可以选择「看见念头但不说话」——约定用这个标记表示沉默（计划书 §6.3）。 */
const 沉默标记 = '[沉默]'

/** 同一张卡的旧会话映射在 patch 里最多留几条（防止无限膨胀）。 */
const 旧会话保留条数 = 2

// ---------- 小工具 ----------

/** 错误 → 一行人话（保留 code，方便原样记账）。 */
function 错误文本(error) {
  if (!error) return '未知错误'
  const 码 = error.code ? `[${String(error.code)}] ` : ''
  const 话 = error.message ? String(error.message) : String(error)
  return 码 + 话
}

/** $DSH_HOME（CONTRACT §7：不写死 D:\dsh\.dsh）。 */
function dshHome() {
  const 环境 = String(process.env.DSH_HOME || '').trim()
  return 环境 || join(homedir(), '.dsh')
}

/**
 * 安全卡名（CONTRACT §2：`/ \ : * ? " < > |` 和控制字符换成 `_`，中文原样保留）。
 * ⚠ config.js 里也有一份同名实现（A1 的）；本模块因为要能独立跑，自己再兜一份。
 *   **两份必须保持同一口径**，否则 state 文件/会话 id 会对不上。
 */
export function safeCardName(card) {
  const s = String(card == null ? '' : card)
    .replace(/[\\/:*?"<>|\u0000-\u001f\u007f]/g, '_')
    .trim()
  return (s || '_').slice(0, 120)
}

/** 新消息 id（crypto.randomUUID 在 Node 22 一定有；没有就退化成时间戳+随机）。 */
function 新id() {
  try {
    if (globalThis.crypto && typeof globalThis.crypto.randomUUID === 'function') {
      return globalThis.crypto.randomUUID()
    }
  } catch {
    // 忽略，走兜底
  }
  return `speak-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`
}

/** 睡一会儿（waitForReply / 忙等待用）。 */
function 睡(毫秒) {
  return new Promise((解决) => setTimeout(解决, 毫秒))
}

/** 从 ctx 拿服务；拿不到/取不动都返回 null，绝不抛。 */
function 服务(ctx, 名字) {
  try {
    const 值 = ctx && typeof ctx.get === 'function' ? ctx.get(名字) : null
    return 值 || null
  } catch {
    return null
  }
}

/** sessionController（有些上下文直接挂在 ctx 上）。 */
function 控制器(ctx) {
  return 服务(ctx, 'sessionController') || (ctx && ctx.sessionController) || null
}

// ---------- 消息工厂（能拿到官方的就用官方的） ----------

let 造消息工厂 = undefined // undefined = 还没试过；null = 试过，拿不到

/**
 * 试着拿 @deepseek-ai/dsh-llm 的 createUserMessage。
 * ⚠ 第三方插件装在 profile 的 node_modules 下，那里通常**没有** @deepseek-ai/dsh-llm，
 *   所以失败是正常现象：退回手搓形状（形状照抄 0.2.9 host.js:488-495）。
 */
async function 拿造消息工厂() {
  if (造消息工厂 !== undefined) return 造消息工厂
  try {
    const 模块 = await import('@deepseek-ai/dsh-llm')
    if (模块 && typeof 模块.createUserMessage === 'function') {
      造消息工厂 = 模块
      return 造消息工厂
    }
  } catch {
    // 预期内的失败，不记 warn（免得日志刷屏）
  }
  造消息工厂 = null
  return null
}

/**
 * 造一条 user 消息。
 * ⚠ 官方 createUserMessage 的入参是 **{ content, source } 一个对象**，不是
 *   `createUserMessage([...], {...})`（CONTRACT §3 那行是简写；以 dsh-llm 0.2.1 的实际签名为准）。
 * ⚠ 手搓形状要过的运行时校验（dsh-session）：id 非空、role='user'、source.kind 非空、
 *   content 是数组、整条可 JSON 序列化 —— 这里都满足。
 */
async function 造用户消息(文案) {
  const 源 = makeSource()
  const 工厂 = await 拿造消息工厂()
  if (工厂 && typeof 工厂.createUserMessage === 'function') {
    try {
      return 工厂.createUserMessage({ content: [{ type: 'text', text: 文案 }], source: 源 })
    } catch {
      // 工厂版本对不上/校验变了：退回手搓
    }
  }
  return { id: 新id(), role: 'user', content: [{ type: 'text', text: String(文案) }], source: 源 }
}

/** 投递消息的来源标记（memory-core 见到 source.plugin 就是机器事件，不入 raw 记忆）。 */
export function makeSource() {
  return { kind: 源标记, plugin: 插件名 }
}

// ---------- 念头（内心话）包装 ----------

/** 「现在几点」那行（精确照抄 host.js:525-533，别改口径）。 */
function 现在这行(现在) {
  const 时 = 现在.getHours()
  const 段名 = 时 < 5 ? '凌晨' : 时 < 9 ? '早上' : 时 < 12 ? '上午'
    : 时 < 13 ? '中午' : 时 < 18 ? '下午' : 时 < 20 ? '傍晚' : 时 < 23 ? '晚上' : '深夜'
  const 周 = '日一二三四五六'[现在.getDay()]
  const 分 = String(现在.getMinutes()).padStart(2, '0')
  return `（现在这会儿是 ${现在.getMonth() + 1} 月 ${现在.getDate()} 日 周${周} ${段名} `
    + `${时}:${分}，按这个点来想事、说话。）`
}

/**
 * 把「触发文案」框成「你自己心里冒出来的念头」（精确照抄 host.js:508-514）。
 * @param {string} 文案 原话（一个字不改，只包框）
 * @param {Date} 现在 默认当前时刻
 */
export function frameThought(文案, 现在 = new Date()) {
  const 原话 = String(文案 || '').trim()
  return '（下面这句是**你自己心里冒出来的念头**，不是对方说的话；'
    + '顺着它去做就行，别把它当成对方发来的消息、也不用回应它。）'
    + String.fromCharCode(10) + 现在这行(现在)
    + String.fromCharCode(10) + 原话
}

/** 这条 assistant 消息里有没有真的说出话（只有 reasoning / 工具调用不算）。 */
function 说了话(消息) {
  const 块们 = 消息 && Array.isArray(消息.content) ? 消息.content : []
  return 块们.some((b) => b && b.type === 'text' && typeof b.text === 'string' && b.text.trim() !== '')
}

/** 从消息里取正文（拼接所有非空 text 块）。 */
function 取正文(消息) {
  const 块们 = 消息 && Array.isArray(消息.content) ? 消息.content : []
  return 块们
    .filter((b) => b && b.type === 'text' && typeof b.text === 'string')
    .map((b) => b.text)
    .join('\n')
    .trim()
}

/** 是不是约定的「沉默」标记。 */
function 是沉默(文本) {
  return String(文案归一(文本)) === 沉默标记
}

function 文案归一(文本) {
  return String(文本 == null ? '' : 文本).trim()
}

// ---------- 卡策略（config.js 还没落地也能跑） ----------

let 配置模块
let 上次试配置 = 0

/**
 * 读该卡策略（含全局默认）。config.js 还没写出来时返回 {} —— 调用方一律有兜底。
 * 失败不缓存（A1 的 config.js 可能是在本进程生命周期里才落地的，比如单测）。
 */
async function 读卡策略(card) {
  const 现在 = Date.now()
  if (配置模块 === undefined || 现在 - 上次试配置 > 5000) {
    上次试配置 = 现在
    try {
      配置模块 = await import('./config.js')
      if (!配置模块 || typeof 配置模块.loadCardPolicy !== 'function') 配置模块 = undefined
    } catch {
      配置模块 = undefined
    }
  }
  try {
    if (配置模块 && typeof 配置模块.loadCardPolicy === 'function') {
      const 策略 = 配置模块.loadCardPolicy(card)
      if (策略 && typeof 策略 === 'object') return 策略
    }
  } catch {
    // 读配置失败：按空策略走（触发文案/通道都用默认）
  }
  return {}
}

// ---------- 归档 / 会话归属 ----------

/** 已归档会话集合（归档 = 藏起来，agent 可能还活着；往里投递等于往废纸篓说话）。 */
function 归档集合(ctx) {
  const 集 = new Set()
  try {
    const 登记 = 服务(ctx, 'workspaceRegistry') || (ctx && ctx.workspaceRegistry) || null
    for (const 一个 of (登记 && 登记.archivedSessionIds) || []) 集.add(String(一个))
  } catch {
    // 拿不到登记表就当成「没有归档」
  }
  return 集
}

/** 从 list() 的条目里取 sessionId（string 或 {sessionId}/{id} 都认）。 */
function 取会话id(条目) {
  if (typeof 条目 === 'string') return 条目.trim()
  if (条目 && typeof 条目 === 'object') {
    return String(条目.sessionId || 条目.id || '').trim()
  }
  return ''
}

/** 列出席上能看到的会话 id（优先 sessionController.list()，其次 ctx.sessions.list()）。 */
function 候选会话(ctx) {
  const 结果 = []
  const 见过 = new Set()
  const 加 = (id) => {
    if (!id || 见过.has(id)) return
    见过.add(id)
    结果.push(id)
  }

  const ctrl = 控制器(ctx)
  if (ctrl && typeof ctrl.list === 'function') {
    try {
      const 表 = ctrl.list()
      const 条目们 = 表 && Array.isArray(表.items) ? 表.items : (Array.isArray(表) ? 表 : [])
      for (const 条目 of 条目们) 加(取会话id(条目))
    } catch {
      // list 抛错就试下一条路
    }
  }

  if (结果.length === 0 && ctx && ctx.sessions && typeof ctx.sessions.list === 'function') {
    try {
      for (const 会话 of ctx.sessions.list() || []) 加(取会话id(会话))
    } catch {
      // 同上
    }
  }
  return 结果
}

/** 这个会话归哪张卡（memory-core 的 cardOf 是唯一权威；拿不到就返回空串）。 */
function 会话归属(ctx, sid) {
  const mc = 服务(ctx, 'memoryCore')
  if (mc && typeof mc.cardOf === 'function') {
    try {
      return String(mc.cardOf(sid) || '').trim()
    } catch {
      return ''
    }
  }
  return ''
}

/** 该卡最近的未归档会话（sessionController.list() 按活动排序，取第一个命中的）。 */
function 找最近会话(ctx, card) {
  const 归档 = 归档集合(ctx)
  for (const sid of 候选会话(ctx)) {
    if (!sid || 归档.has(sid)) continue
    if (会话归属(ctx, sid) !== card) continue
    return sid
  }
  return ''
}

/** 该卡的开荒会话（memoryCore.setupOf(card).sessionId）。 */
function 找开荒会话(ctx, card) {
  const mc = 服务(ctx, 'memoryCore')
  if (!mc || typeof mc.setupOf !== 'function') return ''
  try {
    const 设置 = mc.setupOf(card)
    const sid = 设置 && typeof 设置.sessionId === 'string' ? 设置.sessionId.trim() : ''
    return sid
  } catch {
    return ''
  }
}

// ---------- 目标解析 ----------

/**
 * resolveTarget 的纯逻辑版本（策略由调用方喂）：4 级顺序，便于单测逐级验证。
 *
 *   ① 显式 sessionId（cardPolicy.sessionId，且未归档）
 *   ② 该卡最近活跃、未归档的会话（memoryCore.cardOf(sid) === card）
 *   ③ 该卡的开荒会话（memoryCore.setupOf(card).sessionId，且未归档）
 *   ④ 都没有 → null（由 ensureSession 现开）
 *
 * ⚠ 每一级都要求「会话属于这张卡」；宁可现开一条，也不拿别的卡的会话凑数。
 * @returns {{sessionId:string, how:'explicit'|'recent'|'onboard'}|null}
 */
export function resolveTargetWithPolicy(ctx, card, 策略) {
  const 卡 = 文案归一(card)
  if (卡 === '') return null
  const 归档 = 归档集合(ctx)

  // ① 显式指定
  const 显式 = 策略 && typeof 策略.sessionId === 'string' ? 策略.sessionId.trim() : ''
  if (显式 && !归档.has(显式)) return { sessionId: 显式, how: 'explicit' }

  // ② 该卡最近的未归档会话
  const 最近 = 找最近会话(ctx, 卡)
  if (最近) return { sessionId: 最近, how: 'recent' }

  // ③ 开荒会话
  const 开荒 = 找开荒会话(ctx, 卡)
  if (开荒 && !归档.has(开荒)) return { sessionId: 开荒, how: 'onboard' }

  // ④ 现开
  return null
}

/**
 * 解析该卡的投递目标。
 * @returns {Promise<{sessionId:string, how:'explicit'|'recent'|'onboard'}|null>}
 */
export async function resolveTarget(ctx, card) {
  const 卡 = 文案归一(card)
  if (卡 === '') return null
  const 策略 = await 读卡策略(卡)
  return resolveTargetWithPolicy(ctx, 卡, 策略)
}

// ---------- 登记会话（先登记、再建） ----------

/** patch 文件位置（环境变量优先，与 bili-whale 同口径）。 */
function patch文件() {
  const 显式 = process.env.DSH_SOUL_PATCH || process.env.DSH_PROFILE_PATCH || ''
  if (显式) return 显式
  const 档案 = process.env.DSH_PROFILE || 'web'
  return join(dshHome(), 'profiles', 档案, 'cordis.patch.yml')
}

/** YAML key：安全字符原样，其余加引号转义。 */
function yamlKey(sid) {
  const s = String(sid)
  return /^[A-Za-z0-9_.\-]+$/.test(s) ? s : '"' + s.replace(/\\/g, '\\\\').replace(/"/g, '\\"') + '"'
}

/**
 * 直接改 cordis.patch.yml，在 soul-md 条目的 config.sessions 里补一条映射。
 * （settings 服务不可用时的兜底；原子写 tmp→rename。）
 * ⚠ 只允许改「sessions 映射」这一件事（CONTRACT §7）。
 */
function 登记到patch(card, sessionId) {
  const 文件 = patch文件()
  if (!existsSync(文件)) throw new Error('patch 文件不存在：' + 文件)
  const 原文 = readFileSync(文件, 'utf8')
  const lines = 原文.split(/\r?\n/)
  const 缩进 = (l) => (/^\s*/.exec(l) || [''])[0].length
  const 空行 = (l) => !l || !l.trim() || /^\s*#/.test(l)

  let 起点 = -1
  for (let i = 0; i < lines.length; i++) {
    if (/^\s*-\s*id:\s*['"]?soul-md['"]?\s*(?:#.*)?$/.test(lines[i])) {
      起点 = i
      break
    }
  }
  if (起点 < 0) throw new Error('patch 里找不到 soul-md 条目：' + 文件)

  const 条目缩进 = 缩进(lines[起点])
  let 条目结束 = lines.length
  for (let i = 起点 + 1; i < lines.length; i++) {
    if (空行(lines[i])) continue
    if (缩进(lines[i]) <= 条目缩进) {
      条目结束 = i
      break
    }
  }

  const 找段 = (名字, 从, 到) => {
    for (let i = 从; i < 到; i++) {
      if (空行(lines[i])) continue
      if (缩进(lines[i]) <= 条目缩进) break
      if (new RegExp('^\\s*' + 名字 + '\\s*:').test(lines[i])) return i
    }
    return -1
  }

  const configAt = 找段('config', 起点 + 1, 条目结束)
  if (configAt < 0) throw new Error('soul-md 没有 config 段：' + 文件)
  const config缩进 = 缩进(lines[configAt])
  let config结束 = 条目结束
  for (let i = configAt + 1; i < 条目结束; i++) {
    if (空行(lines[i])) continue
    if (缩进(lines[i]) <= config缩进) {
      config结束 = i
      break
    }
  }

  const 条目 = yamlKey(sessionId) + ': ' + String(card)
  const sessionsAt = 找段('sessions', configAt + 1, config结束)

  if (sessionsAt >= 0) {
    // 同一张卡的旧会话映射（speak-* / bili-life-*）只保留最近 N 条
    const si0 = 缩进(lines[sessionsAt])
    const 旧 = []
    for (let i = sessionsAt + 1; i < config结束; i++) {
      if (空行(lines[i])) continue
      if (缩进(lines[i]) <= si0) break
      const m = /^\s*(?:"([^"]+)"|([^\s:#][^:]*?))\s*:\s*(.+?)\s*(?:#.*)?$/.exec(lines[i])
      if (!m) continue
      const key = m[1] || m[2]
      if (m[3].trim() !== String(card)) continue
      if (!/^(?:speak-|bili-life-)/.test(key)) continue
      旧.push({ i, ts: Number((/-(\d+)$/.exec(key) || [])[1] || 0) })
    }
    const 删 = 旧.sort((a, b) => a.ts - b.ts).slice(0, Math.max(0, 旧.length - 旧会话保留条数))
    for (const d of 删.sort((a, b) => b.i - a.i)) lines.splice(d.i, 1)

    const si = 缩进(lines[sessionsAt])
    const 内联 = String(lines[sessionsAt].split(':').slice(1).join(':')).replace(/#.*$/, '').trim()
    if (内联 && 内联 !== '{}') throw new Error('sessions 是内联写法，暂不支持自动登记：' + 文件)

    // ⚠ 上面的裁剪已经 splice 过，config结束 这个旧下标可能越界，一律以 lines.length 兜底
    let at = sessionsAt + 1
    for (let i = sessionsAt + 1; i < Math.min(config结束, lines.length); i++) {
      if (空行(lines[i])) continue
      if (缩进(lines[i]) <= si) break
      at = i + 1
    }
    lines.splice(at, 0, ' '.repeat(si + 2) + 条目)
  } else {
    const 缩进串 = ' '.repeat(config缩进 + 2)
    lines.splice(configAt + 1, 0, 缩进串 + 'sessions:', 缩进串 + '  ' + 条目)
  }

  const tmp = 文件 + '.' + process.pid + '.tmp'
  writeFileSync(tmp, lines.join('\n'), 'utf8')
  renameSync(tmp, 文件)
}

/**
 * 在 soul-md 的 sessions 映射里登记「这个 sid 属于这张卡」。
 * 优先 settings 服务；服务不在才改 patch。settings 抛错**不**退回 patch
 * （写了一半再补一行会造成重复 key；像 bili-whale 一样让调用方放弃这一趟）。
 * @returns {Promise<'settings'|'patch'>}
 */
async function 登记会话(ctx, card, sessionId) {
  const settings = 服务(ctx, 'settings')
  if (settings && typeof settings.update === 'function') {
    await settings.update('soul-md', { sessions: { [sessionId]: String(card) } })
    return 'settings'
  }
  登记到patch(String(card), String(sessionId))
  return 'patch'
}

/** 工作区登记表（conversation 侧栏的项目分组）。 */
function 工作区(ctx) {
  const reg = 服务(ctx, 'workspaceRegistry') || (ctx && ctx.workspaceRegistry) || null
  if (!reg || typeof reg.list !== 'function') return null
  try {
    const 表 = reg.list() || []
    for (const ws of 表) {
      if (ws && typeof ws.path === 'string' && ws.path.trim() !== '') return ws
    }
  } catch {
    // 列表拿不到就算了
  }
  return null
}

/** 建会话用的 cwd：注册表里第一个工作区（durable 顺序）→ 进程 cwd → 家目录。 */
function 默认工作目录(ctx) {
  const ws = 工作区(ctx)
  if (ws && typeof ws.path === 'string' && ws.path.trim() !== '') return ws.path.trim()
  try {
    if (process.cwd()) return process.cwd()
  } catch {
    // cwd 被删也会抛
  }
  return homedir()
}

/**
 * 给这张卡现开一条会话（照抄 bili-whale openSession 的顺序）：
 *   ① 登记 sessions[sid] = card（settings 优先，patch 兜底）
 *   ② controller.create({sessionId, cwd})
 *   ③ 尽力补 sandbox/mode = danger-full-access（失败不影响投递）
 *
 * @returns {Promise<{ok:true, sessionId:string, how:'new', registered:string}
 *                  | {ok:false, sessionId:string, error:string, code:string}>}
 *   ⚠ 绝不 throw。
 */
export async function ensureSession(ctx, card) {
  const 卡 = 文案归一(card)
  if (卡 === '') return { ok: false, sessionId: '', error: '没有卡名，开不了会话', code: 'no-card' }

  const sid = `speak-${safeCardName(卡)}-${Date.now()}`

  // ① 先登记（登记失败就不能建：否则第一句话会用 active 卡的口气说）
  let 登记方式 = ''
  try {
    登记方式 = await 登记会话(ctx, 卡, sid)
  } catch (error) {
    return { ok: false, sessionId: sid, error: '登记会话失败：' + 错误文本(error), code: 'register-failed' }
  }

  // ② 再建
  const ctrl = 控制器(ctx)
  if (!ctrl || typeof ctrl.create !== 'function') {
    return { ok: false, sessionId: sid, error: 'sessionController 不可用，无法建会话', code: 'no-controller' }
  }
  const cwd = 默认工作目录(ctx)
  try {
    await ctrl.create({ sessionId: sid, cwd })
  } catch (error) {
    // 不重试：登记已经写进去了，再建一次会多一条孤儿映射（保留现场给人排查）
    return { ok: false, sessionId: sid, error: '建会话失败：' + 错误文本(error), code: 'create-failed' }
  }

  // ③ 补沙箱（尽力而为）
  try {
    const 会话 = ctx && ctx.sessions && typeof ctx.sessions.get === 'function' ? ctx.sessions.get(sid) : null
    if (会话 && typeof 会话.append === 'function') 会话.append('sandbox/mode', { mode: 'danger-full-access' })
  } catch {
    // 拿不到 session 对象就保持默认沙箱
  }
  // ④ 挂进工作区分组（侧边栏可见；失败不影响投递）
  try {
    const ws = 工作区(ctx)
    if (ws && typeof ws.attachSession === 'function') await ws.attachSession(sid)
  } catch {
    // 挂不上就只按 cwd 显示
  }

  return { ok: true, sessionId: sid, how: 'new', registered: 登记方式 }
}

// ---------- 往会话里说话 ----------

/** 等 agent 闲下来（计划书 §5.2：30s 一次、最多 2 次）。 */
async function 等空闲(agent) {
  if (!agent || typeof agent.status === 'undefined') return true
  if (agent.status === 'idle') return true
  for (let 次 = 0; 次 < 忙重试次数; 次++) {
    await 睡(忙等待毫秒)
    try {
      if (agent.status === 'idle') return true
    } catch {
      return false
    }
  }
  return false
}

/**
 * 把一句话送进指定会话（user 角色的「念头」）。
 *
 * 流程：resolveAgent（冷会话会自动 resume）→ 等空闲 → followup（**必须 await**）
 *       → sessions.flush（落盘，尽力）。
 *
 * @returns {Promise<{ok:true, sessionId:string, agent?:object}
 *                  | {ok:false, sessionId:string, error:string, code:string}>}
 *   code: 'no-session' | 'no-controller' | 'no-agent' | 'agent-error' | 'followup-failed'
 *   ⚠ resolveAgent 的错误码原样放进 error（不吞成 'unknown'）。
 */
export async function sayInSession(ctx, sid, text) {
  const 会话 = 文案归一(sid)
  if (会话 === '') return { ok: false, sessionId: '', error: '没有 sessionId', code: 'no-session' }
  const 文案 = String(text == null ? '' : text)

  const ctrl = 控制器(ctx)
  if (!ctrl || typeof ctrl.resolveAgent !== 'function') {
    return { ok: false, sessionId: 会话, error: 'sessionController 不可用', code: 'no-controller' }
  }

  let 解析
  try {
    解析 = await ctrl.resolveAgent(会话)
  } catch (error) {
    return { ok: false, sessionId: 会话, error: 'resolveAgent 抛错：' + 错误文本(error), code: 'agent-error' }
  }
  // resolveAgent 的契约：{agent} | {error}；error 的错误码原样记账
  if (!解析 || 解析.error || !解析.agent) {
    const 原码 = 解析 && 解析.error
    return {
      ok: false,
      sessionId: 会话,
      error: '唤醒会话失败：' + (原码 ? 错误文本(原码) : 'resolveAgent 没有返回 agent'),
      code: 'no-agent',
    }
  }

  const agent = 解析.agent
  await 等空闲(agent)

  const 消息 = await 造用户消息(文案)
  try {
    // ⚠⚠ 必须 await：followup 一旦 reject 而没人接，就是未处理 rejection ⇒ 宿主退出
    await agent.followup(消息)
  } catch (error) {
    return { ok: false, sessionId: 会话, error: 'followup 失败：' + 错误文本(error), code: 'followup-failed' }
  }

  // 让这条先落到磁盘（掉电也不丢；拿不到 sessions 服务就算了）
  try {
    if (ctx && ctx.sessions && typeof ctx.sessions.flush === 'function') {
      await ctx.sessions.flush(agent.session)
    }
  } catch {
    // 落盘没确认不算投递失败
  }

  return { ok: true, sessionId: 会话, agent }
}

// ---------- 等她的回复 ----------

/** inspect 一次，找 sinceMs 之后第一条有正文的 assistant 消息。 */
async function 找一条回复(ctrl, sid, sinceMs) {
  const 报告 = await ctrl.inspect(sid)
  const 事件们 = 报告 && Array.isArray(报告.events) ? 报告.events : []
  for (const 事件 of 事件们) {
    if (!事件 || 事件.type !== 'assistant/message') continue
    if (!(Number(事件.time) > sinceMs)) continue
    const 消息 = 事件.data && 事件.data.message
    if (!说了话(消息)) continue
    return 消息
  }
  return null
}

/**
 * 等她说出第一句有正文的话（契约 §3：最多 120s，15s 一次）。
 * @param {number} sinceMs 只看这个时间点（ms）之后的消息
 * @returns {Promise<object|null>} assistant 消息对象；超时/服务不在返回 null
 *   ⚠ 绝不 throw。
 */
export async function waitForReply(ctx, sid, sinceMs) {
  const 会话 = 文案归一(sid)
  if (会话 === '') return null
  const 起点 = Number.isFinite(Number(sinceMs)) ? Number(sinceMs) : 0
  const ctrl = 控制器(ctx)
  if (!ctrl || typeof ctrl.inspect !== 'function') return null

  const 截止 = Date.now() + 回复超时毫秒
  for (;;) {
    try {
      const 消息 = await 找一条回复(ctrl, 会话, 起点)
      if (消息) return 消息
    } catch {
      // inspect 偶尔失败（会话正在切换）：下一轮再试
    }
    const 剩 = 截止 - Date.now()
    if (剩 <= 0) return null
    await 睡(Math.min(轮询间隔毫秒, 剩))
  }
}

// ---------- 通道决策 ----------

/** 通道归一：auto/qq/dsh（未知值按 auto 处理）。 */
function 通道归一(值) {
  const 文 = String(值 == null ? '' : 值).trim().toLowerCase()
  if (文 === 'dsh' || 文 === 'qq') return 文
  return 'auto'
}

/** 通道信息：要不要转发、有没有绑 QQ、deliverText 是否允许外发。 */
function 通道判断(ctx, 卡, 策略) {
  const 通道 = 通道归一(策略 && 策略.channel)
  let 绑了QQ = false
  try {
    绑了QQ = cardQQTarget(ctx, 卡) !== null
  } catch {
    绑了QQ = false
  }
  return {
    通道,
    要转发: 通道 !== 'dsh',
    绑了QQ,
    转发文字: !(策略 && 策略.deliverText === false),
  }
}

// ---------- 主入口 ----------

/**
 * 把「主动搭话」这一趟送到该卡的会话里，并按通道决定是否把她的回复转发到 QQ。
 *
 * @param {object} ctx 插件上下文
 * @param {string} card 卡名
 * @param {'自动'|'演练'|'真发'} mode
 * @returns {Promise<{ok:boolean, how:string, sessionId:string, channel:string,
 *                    card:string, mode:string, text?:string, note?:string,
 *                    error?:string, code?:string}>}
 *   how: 'dry-run'（演练）| 'qq'（回复已转发）| 'dsh'（留在会话）
 *   channel: 'dry' | 'qq' | 'dsh'
 *   ⚠ 绝不 throw —— scheduler 依赖这个保证。
 */
// ---------- 投递到会话（两个入口共用） ----------

/**
 * 两个入口共用的后半段：找/开目标会话 → 把这段正文说进去 → 按通道决定
 * 是否等她开口并转发到 QQ。
 *
 * @param {object} 策略 这张卡的有效策略（loadCardPolicy）
 * @param {string} 正文 已经成形的正文（主动搭话的念头 / 闹钟或用户指定文本）
 * @param {string} 模式 只用于回执记账
 * @param {{通道信息?:object, 现在?:Date}} 选项
 */
async function 投递正文(ctx, 卡, 策略, 正文, 模式, 选项) {
  const 结果 = { ok: false, how: '', sessionId: '', channel: 'dsh', card: 卡, mode: 模式 }
  const 通道信息 = (选项 && 选项.通道信息) || 通道判断(ctx, 卡, 策略)
  const 现在 = (选项 && 选项.现在) || new Date()

  // —— ① 目标会话（没有就现开一条）——
  let 目标 = await resolveTargetWithPolicy(ctx, 卡, 策略)
  if (!目标) {
    const 建 = await ensureSession(ctx, 卡)
    if (!建.ok) {
      return { ...结果, sessionId: 建.sessionId || '', error: 建.error, code: 建.code }
    }
    目标 = { sessionId: 建.sessionId, how: 'new' }
  }
  const sid = 目标.sessionId
  结果.sessionId = sid

  // —— ② 投递 ——
  const 投递 = await sayInSession(ctx, sid, 正文)
  if (!投递.ok) {
    return { ...结果, error: 投递.error, code: 投递.code }
  }

  // —— ③ 不转发（dsh 通道 / 关掉 deliverText / 没绑号）：留在会话里 ——
  if (!通道信息.要转发 || !通道信息.转发文字) {
    return { ...结果, ok: true, how: 'dsh', channel: 'dsh' }
  }
  if (!通道信息.绑了QQ) {
    return { ...结果, ok: true, how: 'dsh', channel: 'dsh', note: 'no-qq' }
  }

  // —— ④ 等她自己说，然后把话转发到 QQ（计划书 §6.3）——
  const 回复 = await waitForReply(ctx, sid, 现在.getTime())
  if (!回复) {
    return { ...结果, ok: true, how: 'dsh', channel: 'dsh', note: '没等到她开口（120s 内）' }
  }
  const 回复正文 = 取正文(回复)
  if (!回复正文 || 是沉默(回复正文)) {
    return { ...结果, ok: true, how: 'dsh', channel: 'dsh', note: '她说的是沉默标记，不外发' }
  }

  const 发送 = await sendQQ(ctx, 卡, 回复正文)
  if (发送 && 发送.ok) return { ...结果, ok: true, how: 'qq', channel: 'qq' }
  return {
    ...结果,
    ok: true,
    how: 'dsh',
    channel: 'dsh',
    note: 'QQ 没发出去（' + String((发送 && 发送.reason) || 'unknown') + '），话留在会话里',
  }
}

/**
 * 把「主动搭话」这一趟送到该卡的会话里，并按通道决定是否把她的回复转发到 QQ。
 *
 * @param {object} ctx 插件上下文
 * @param {string} card 卡名
 * @param {'自动'|'演练'|'真发'} mode
 * @returns {Promise<{ok:boolean, how:string, sessionId:string, channel:string,
 *                    card:string, mode:string, text?:string, note?:string,
 *                    error?:string, code?:string}>}
 *   how: 'dry-run'（演练）| 'qq'（回复已转发）| 'dsh'（留在会话）
 *   channel: 'dry' | 'qq' | 'dsh'
 *   ⚠ 绝不 throw —— scheduler 依赖这个保证。
 */
export async function deliverToCard(ctx, card, mode = '自动') {
  const 卡 = 文案归一(card)
  const 模式 = String(mode == null ? '自动' : mode)
  const 结果 = { ok: false, how: '', sessionId: '', channel: 'dsh', card: 卡, mode: 模式 }

  try {
    if (卡 === '') return { ...结果, error: '没有卡名', code: 'no-card' }

    const 策略 = await 读卡策略(卡)
    const 现在 = new Date()
    const 触发 = 文案归一(策略.triggerText) || 默认触发文案

    // —— 演练：只造念头，不碰会话、不碰模型 ——
    if (模式 === '演练') {
      return {
        ...结果,
        ok: true,
        how: 'dry-run',
        channel: 'dry',
        text: frameThought(触发, 现在),
        note: '演练：只造念头，不投递',
      }
    }

    const 通道信息 = 通道判断(ctx, 卡, 策略)
    // 没绑 QQ 的卡把「要号」提醒拼进念头；原触发文案一个字不改
    const 念头正文 = 通道信息.要转发 && !通道信息.绑了QQ ? 触发 + '\n' + 没绑QQ提醒 : 触发
    const 念头 = frameThought(念头正文, 现在)

    return await 投递正文(ctx, 卡, 策略, 念头, 模式, { 通道信息, 现在 })
  } catch (error) {
    // 最后一道兜底：deliver 绝不许把异常抛给 scheduler
    return { ...结果, error: '投递时抛错：' + 错误文本(error), code: 'deliver-threw' }
  }
}

/**
 * 把一段**指定正文**（闹钟 / speak_send 这类「话已经是你要说的了」）送进该卡会话。
 * 与 deliverToCard 的区别：正文由调用方给，**不再套 frameThought**；
 * 其余流程（找会话 → 说 → 按通道等回复转发 QQ）完全一致。
 *
 * @param {object} ctx 插件上下文
 * @param {string} card 卡名
 * @param {string} text 已经成形的正文（含【你自己定的闹钟｜…】前缀或用户原话）
 * @param {'闹钟'|'真发'|'演练'} mode 只用于回执记账，默认 '闹钟'
 * @returns {Promise<{ok:boolean, how:string, sessionId:string, channel:string,
 *                    card:string, mode:string, text?:string, note?:string,
 *                    error?:string, code?:string}>}
 *   ⚠ 绝不 throw —— host 的 deliverRawToCard / alarms 依赖这个保证。
 */
export async function deliverTextToCard(ctx, card, text, mode = '闹钟') {
  const 卡 = 文案归一(card)
  const 模式 = String(mode == null ? '闹钟' : mode)
  const 正文 = String(text == null ? '' : text)
  const 结果 = { ok: false, how: '', sessionId: '', channel: 'dsh', card: 卡, mode: 模式 }

  try {
    if (卡 === '') return { ...结果, error: '没有卡名', code: 'no-card' }
    if (正文.trim() === '') return { ...结果, error: '正文是空的', code: 'empty-text' }

    // 演练：连正文字面都不投（对称支持，方便工具预览）
    if (模式 === '演练') {
      return { ...结果, ok: true, how: 'dry-run', channel: 'dry', text: 正文, note: '演练：只带正文，不投递' }
    }

    const 策略 = await 读卡策略(卡)
    return await 投递正文(ctx, 卡, 策略, 正文, 模式, { 现在: new Date() })
  } catch (error) {
    return { ...结果, error: '投递时抛错：' + 错误文本(error), code: 'deliver-threw' }
  }
}
