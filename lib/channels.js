// lib/channels.js —— 通道层：她的话怎么送到主人手里（0.3.0 新增，A2）
//
// 口径（CONTRACT.md §3 lib/channels.js、计划书 §6）：
//   · **会话**是她在哪儿说话，**通道**是她说的话怎么到你手里；
//     所以这个模块只负责「发」，不负责「找会话」。
//   · 默认通道是 QQ（aurabot 跨插件服务）；aurabot 不在 / 没绑号 / 离线 →
//     返回结构化失败，由 delivery.js 决定「留在 DSH 会话里」。
//   · ⚠ 一支铁律：**绝不 throw**。scheduler 是 fire-and-forget 地并行投递，
//     这里漏一个 rejection 出去，轻则那一轮没记账，重则 unhandled rejection
//     把整个 DSH 宿主带走（2026-10-21 真机事故的同一类坑）。
//
// 号从哪儿来（14 号计划 §4.5 的口径：一个号一条鱼）：
//   auraybot 的 accounts[] 里 `card === 卡名` 的那一条 → 该卡绑定的号。
//   ⚠ aurabot 服务（bridge.js: `ctx.provide('aurabot', {...ops})`）**没有** expose accounts，
//     所以服务上没有时回退读它的配置文件（$DSH_HOME/plugins-data/aurabot/config.json，
//     可被 env AURABOT_DATA_DIR 覆盖）。只读，不写。

import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

/** QQ 单条消息的安全上限（计划书 §6.2 要求裁剪；留足余量给换行/表情）。 */
const 单条上限 = 1500

// ---------- 小工具 ----------

/** $DSH_HOME（CONTRACT §7：不写死 D:\dsh\.dsh）。 */
function dshHome() {
  const 环境 = String(process.env.DSH_HOME || '').trim()
  return 环境 || join(homedir(), '.dsh')
}

/** aurabot 的数据目录（它自己认 AURABOT_DATA_DIR）。 */
function aurabot数据目录() {
  const 覆盖 = String(process.env.AURABOT_DATA_DIR || '').trim()
  if (覆盖) return 覆盖
  return join(dshHome(), 'plugins-data', 'aurabot')
}

/** 读 aurabot 的 config.json；读不到/坏掉返回 null（**不抛**）。 */
function 读aurabot配置() {
  try {
    const 文件 = join(aurabot数据目录(), 'config.json')
    const 原文 = readFileSync(文件, 'utf8')
    const 配置 = JSON.parse(原文)
    return 配置 && typeof 配置 === 'object' ? 配置 : null
  } catch {
    return null
  }
}

/** 拿 aurabot 服务；服务不在/取不动都返回 null。 */
function 拿aurabot(ctx) {
  try {
    const au = ctx && typeof ctx.get === 'function' ? ctx.get('aurabot') : null
    return au || null
  } catch {
    return null
  }
}

/** 从一条账号记录里取号（qq / chatId / target 都认）。 */
function 取号(账号) {
  if (!账号 || typeof 账号 !== 'object') return ''
  for (const 键 of ['qq', 'chatId', 'target', 'uin']) {
    const 值 = 账号[键]
    if (typeof 值 === 'string' && 值.trim() !== '') return 值.trim()
    if (typeof 值 === 'number' && Number.isFinite(值)) return String(值)
  }
  return ''
}

/** 卡名归一（只去空白；大小写/全半角不猜，卡名是主键）。 */
function 卡名归一(card) {
  return String(card == null ? '' : card).trim()
}

/** 从若干候选里挑出「card === 卡名」且启用的那条账号。 */
function 挑账号(账号表, card) {
  if (!Array.isArray(账号表)) return null
  for (const 账号 of 账号表) {
    if (!账号 || typeof 账号 !== 'object') continue
    if (卡名归一(账号.card || 账号.name) !== card) continue
    if (账号.enabled === false || 账号.disabled === true) continue
    if (取号(账号) === '') continue
    return 账号
  }
  return null
}

/**
 * 该卡绑定的 QQ 号 / chatId；没绑返回 null。
 *
 * 解析顺序（从「服务当场给的」到「落盘配置」）：
 *   ① auraybot 服务对象上直接挂的 accounts（当前 bridge 没有，但以后可能加）
 *   ② auraybot.ops.accounts
 *   ③ auraybot.info() 同步返回的 accounts（若是 Promise 就跳过，不能在同步函数里等）
 *   ④ $DSH_HOME/plugins-data/aurabot/config.json 的 accounts[]
 *
 * 匹配口径：accounts[i].card === 卡名（14 号计划口径），`enabled === false` 的跳过。
 *
 * @returns {string|null} 号（字符串）或 null
 */
export function cardQQTarget(ctx, card) {
  const 卡 = 卡名归一(card)
  if (卡 === '') return null

  const au = 拿aurabot(ctx)
  if (au) {
    // ①②：服务上/ops 上直接有账号表
    for (const 源 of [au, au.ops]) {
      try {
        const 账号 = 挑账号(源 && 源.accounts, 卡)
        if (账号) return 取号(账号)
      } catch {
        // 服务实现怪：继续试下一条路
      }
    }
    // ③：info() —— 只接纳同步结果（cardQQTarget 按契约是同步函数）
    try {
      if (typeof au.info === 'function') {
        const 信息 = au.info()
        if (信息 && typeof 信息 === 'object' && typeof 信息.then !== 'function') {
          const 账号 = 挑账号(信息.accounts, 卡)
          if (账号) return 取号(账号)
        }
      }
    } catch {
      // info 抛错：当成没有账号信息
    }
  }

  // ④：配置文件兜底
  try {
    const 配置 = 读aurabot配置()
    const 账号 = 挑账号(配置 && 配置.accounts, 卡)
    if (账号) return 取号(账号)
  } catch {
    // 读配置失败：就是没绑
  }
  return null
}

/** 主人 QQ（aurabot 的 ownerQQ；配置里没有就返回空串）。 */
function 主人QQ(ctx) {
  const au = 拿aurabot(ctx)
  if (au) {
    for (const 源 of [au, au.ops, au.config]) {
      const 值 = 源 && (源.ownerQQ || 源.owner)
      if (typeof 值 === 'string' && 值.trim() !== '') return 值.trim()
      if (typeof 值 === 'number' && Number.isFinite(值)) return String(值)
    }
  }
  try {
    const 配置 = 读aurabot配置()
    const 值 = 配置 && 配置.ownerQQ
    if (typeof 值 === 'string' && 值.trim() !== '') return 值.trim()
    if (typeof 值 === 'number' && Number.isFinite(值)) return String(值)
  } catch {
    // 没配置就是没有
  }
  return ''
}

/** 找 send 方法（当前服务是 {...ops}，所以 au.send 与 au.ops.send 都认）。 */
function 找send(au) {
  for (const 源 of [au.ops, au]) {
    if (源 && typeof 源.send === 'function') return { 源, send: 源.send }
  }
  return null
}

/** 把长文裁到 QQ 单条上限以内（尽量在句末/换行处断）。 */
function 裁剪(text) {
  const 原 = String(text == null ? '' : text)
  if (原.length <= 单条上限) return 原
  const 前段 = 原.slice(0, 单条上限)
  const 断点 = Math.max(
    前段.lastIndexOf('\n'),
    前段.lastIndexOf('。'),
    前段.lastIndexOf('！'),
    前段.lastIndexOf('？'),
    前段.lastIndexOf('. '),
  )
  return 断点 > 单条上限 * 0.6 ? 前段.slice(0, 断点 + 1) : 前段
}

/**
 * 经 QQ 把一句话发给主人。
 *
 * @returns {Promise<{ok:true, via:'qq'} | {ok:false, reason:string, message?:string}>}
 *   reason: 'no-aurabot'（服务不在/调用抛错）| 'no-qq'（这张卡没绑号）|
 *           'offline'（aurabot 不在线/未启用）| 'send-failed'（aurabot 明确回失败）|
 *           'empty-text'
 *   ⚠ 绝不 throw。
 */
export async function sendQQ(ctx, card, text) {
  const 文案 = 裁剪(text)
  if (String(文案).trim() === '') return { ok: false, reason: 'empty-text' }

  const au = 拿aurabot(ctx)
  if (!au) return { ok: false, reason: 'no-aurabot' }

  // 这张卡有没有绑号 —— 没绑就不发（计划书 §6.4：留在 DSH 会话里提醒主人给号）
  const 绑定号 = cardQQTarget(ctx, card)
  if (!绑定号) return { ok: false, reason: 'no-qq' }

  // 在线/启用检查（计划书 §6.2：offline → 退回 dsh；dryRun 交给 aurabot 自己记）
  try {
    if (typeof au.info === 'function') {
      const 信息 = au.info()
      if (信息 && typeof 信息 === 'object' && typeof 信息.then !== 'function') {
        if (信息.enabled === false) return { ok: false, reason: 'offline', message: 'aurabot 已停用' }
        if (信息.online === false) return { ok: false, reason: 'offline', message: 'aurabot 不在线' }
      }
    }
  } catch {
    // info 抛错不拦发送：真正能不能发交给 send 的返回
  }

  const 发 = 找send(au)
  if (!发) return { ok: false, reason: 'no-aurabot', message: 'aurabot 服务上没有 send' }

  // 收件人 = **主人**（ownerQQ），不是这张卡的绑定号：
  // 绑定号是这张卡发消息用的身份（发到那儿等于发给她自己，主人收不到）；
  // 绑定号在这里只反向确认「她有没有 QQ 通道」。ownerQQ 拿不到才退回绑定号，并在 message 里注明。
  const 主人 = 主人QQ(ctx)
  const 收件人 = 主人 || 绑定号
  const 兜底备注 = 主人 ? '' : '没拿到 ownerQQ，退回绑定号（可能发给鱼自己）'
  if (!收件人) return { ok: false, reason: 'no-qq' }

  try {
    const 结果 = await 发.send.call(发.源, { target: 'private:' + 收件人, text: 文案 })
    if (结果 && typeof 结果 === 'object' && 结果.ok === false) {
      return { ok: false, reason: 'send-failed', message: String(结果.message || 结果.error || 'aurabot 回了失败') }
    }
    if (结果 === false) return { ok: false, reason: 'send-failed', message: 'aurabot 回了 false' }
    return 兜底备注 ? { ok: true, via: 'qq', message: 兜底备注 } : { ok: true, via: 'qq' }
  } catch (error) {
    // 服务半路没了 / 抛错 —— 按契约折成 no-aurabot，附上原文方便记账
    return { ok: false, reason: 'no-aurabot', message: 错误文本(error) }
  }
}

/** 错误 → 一行人话（不吃掉 code）。 */
function 错误文本(error) {
  if (!error) return '未知错误'
  const 码 = error.code ? `[${String(error.code)}] ` : ''
  const 话 = error.message ? String(error.message) : String(error)
  return 码 + 话
}
