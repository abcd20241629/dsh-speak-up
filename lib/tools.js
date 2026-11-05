// lib/tools.js —— 给 agent 用的两个工具（0.3.0 新增，A3）
//
//   speak_alarm  create / list / cancel —— 自己给自己定闹钟
//   speak_send   { text, card? }        —— 绕过骰子，立刻真发一句
//
// 设计口径（CONTRACT.md §3 lib/tools.js、计划书 §7）：
//   · 两个工具的 description 都要把「这是你自己给自己定的闹钟；到点宿主会重新叫醒你，
//     你可以决定要不要开口、说什么」写清楚 —— 这句话是 agent 会不会用对的关键；
//   · `card` 缺省 = 当前会话绑的卡，三级回退：
//       ① ctx 服务 memoryCore.cardOf(sid)（memory-core 已经提供，最准）
//       ② 动态 import('./cards.js').cardOf(ctx, sid)（A1 的产物；动态 import 是为了不制造硬依赖）
//       ③ 自己解析 $DSH_HOME/profiles/*/cordis.patch.yml 的 soul-md 块（抄 memory-core 的只读逻辑）
//   · ctx 上没有 tools 服务时：**记账后跳过**，绝不 crash（老宿主/裁剪宿主也能加载本插件）。
//
// 不新增 npm 依赖：defineTool 用 memory-core 同款垫片（把 parameters 规格折成 JSON Schema），
// 因为本插件没有 @deepseek-ai/dsh-tools 这个依赖。

import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { alarmsOf, createAlarm, cancelAlarm, formatAt, alarmText } from './alarms.js'

// ---------- 依赖垫片 ----------

/** 把 `{k: {type, description, required, enum, items}}` 折成 dsh-tools 要的 JSON Schema。 */
function defineTool(def) {
  const properties = {}
  const required = []
  for (const [k, v] of Object.entries(def.parameters || {})) {
    const p = { type: v.type, description: v.description }
    if (v.enum) p.enum = v.enum
    if (v.items) p.items = v.items
    properties[k] = p
    if (v.required) required.push(k)
  }
  return {
    name: def.name,
    description: def.description,
    parameters: { type: 'object', properties, required, additionalProperties: false },
    output: {
      schema: def.output && def.output.schema ? def.output.schema : { type: 'object' },
      render: def.output && def.output.render
        ? def.output.render
        : (_a, v) => [{ type: 'text', text: JSON.stringify(v) }],
    },
    execute: def.execute,
  }
}

const 报错文本 = (err) => (err && (err.message || String(err))) || 'unknown'

/** 从 exec 上取会话 id（不同版本的 ToolExecution 长得不一样，多试几个位置）。 */
function sidOf(exec) {
  try {
    const agent = exec && (exec.agent || exec.caller)
    const s = agent && agent.session
    if (s) {
      const id = s.id || s.sessionId || s.key
      if (typeof id === 'string' && id) return id
    }
  } catch { /* ignore */ }
  try {
    const id = exec && (exec.sessionId || (exec.session && exec.session.id))
    if (typeof id === 'string' && id) return id
  } catch { /* ignore */ }
  return ''
}

function dshHome() {
  const 环境 = String(process.env.DSH_HOME || '').trim()
  return 环境 || join(homedir(), '.dsh')
}

// ---------- 当前会话 → 卡 ----------

/** 只读解析 cordis.patch.yml 里 `- id: soul-md` 那个块（和 memory-core/store.js 的口径一致）。 */
function parseSoulBlock(text) {
  const lines = String(text || '').split(/\r?\n/)
  let start = -1
  for (let i = 0; i < lines.length; i++) {
    if (/^- id:\s*soul-md\s*$/.test(lines[i])) { start = i; break }
  }
  if (start < 0) return null
  const active = []
  const sessions = {}
  let mode = ''
  for (let i = start + 1; i < lines.length; i++) {
    const line = lines[i]
    if (/^- id:/.test(line)) break
    if (/^\s{2,}active:\s*(.+)$/.test(line)) {
      const m = line.match(/^\s{2,}active:\s*(.+)$/)
      active.push(m[1].trim().replace(/^["']|["']$/g, ''))
      continue
    }
    if (/^\s{2,}sessions:\s*$/.test(line)) { mode = 'sessions'; continue }
    if (/^\s{2,}cards:\s*$/.test(line)) { mode = ''; continue }
    if (/^\s{2,}[A-Za-z]/.test(line) && !/^\s{4,}/.test(line)) { mode = ''; continue }
    if (mode === 'sessions') {
      const m = line.match(/^\s{6}([^:]+):\s*(.*)$/)
      if (m) {
        const key = m[1].trim()
        if (/^session-[A-Za-z0-9_-]+$/.test(key)) {
          sessions[key] = m[2].trim().replace(/^["']|["']$/g, '')
        }
      }
    }
  }
  return { active: active[0] || '', sessions }
}

/**
 * 第三级兜底：自己扫 profiles 认卡。
 * @returns {{found: boolean, card: string}} found=false 时 card 是该 profile 的 active（未知会话的兜底）
 */
function 从补丁认卡(sid) {
  const key = String(sid || '').replace(/^session-/, '')
  if (!key) return { found: false, card: '' }
  const 目录 = join(dshHome(), 'profiles')
  let 活跃 = ''
  try {
    for (const p of readdirSync(目录)) {
      const 文件 = join(目录, p, 'cordis.patch.yml')
      if (!existsSync(文件)) continue
      const 块 = parseSoulBlock(readFileSync(文件, 'utf8'))
      if (!块) continue
      if (!活跃 && 块.active) 活跃 = 块.active
      for (const [k, v] of Object.entries(块.sessions)) {
        if (String(k).replace(/^session-/, '') !== key) continue
        const 值 = String(v || '').trim()
        if (!值 || 值 === 'none' || 值 === 'null') return { found: true, card: '' } // 显式 none：不要回退到 active
        return { found: true, card: 值 }
      }
    }
  } catch { /* 没有 profiles 目录就算了 */ }
  return { found: false, card: 活跃 }
}

/**
 * 取当前会话的卡。
 * @returns {Promise<{card: string, from: string}>} card='' 表示这个会话没卡
 */
async function 当前卡(ctx, exec) {
  const sid = sidOf(exec)

  // ① memory-core 服务
  try {
    const 服务 = typeof ctx.get === 'function' ? ctx.get('memoryCore') : null
    if (服务 && typeof 服务.cardOf === 'function') {
      const 卡 = await 服务.cardOf(sid)
      if (卡 && String(卡).trim() && String(卡).trim() !== 'none') {
        return { card: String(卡).trim(), from: 'memoryCore' }
      }
    }
  } catch { /* 服务没装/没准备好：继续下一级 */ }

  // ② A1 的 lib/cards.js（动态 import：模块不存在也不会炸掉本文件）
  try {
    const mod = await import('./cards.js')
    if (mod && typeof mod.cardOf === 'function') {
      const 卡 = await mod.cardOf(ctx, sid)
      if (卡 && String(卡).trim() && String(卡).trim() !== 'none') {
        return { card: String(卡).trim(), from: 'cards' }
      }
    }
  } catch { /* 还没落地：继续下一级 */ }

  // ③ 自己解析 patch
  const 结果 = 从补丁认卡(sid)
  if (结果.card) return { card: 结果.card, from: 'patch' }
  return { card: '', from: 结果.found ? 'patch-none' : 'none' }
}

// ---------- 工具实现 ----------

const 闹钟说明 = [
  '这是你自己给自己定的闹钟：到点宿主会重新叫醒你（不需要你在这里等）。',
  '醒来时你会收到一段「【你自己定的闹钟｜MM-DD HH:mm】<你当初写的话>」，',
  '你可以自己决定要不要开口、说什么——不想说话就什么都不用说，不算失约。',
  '闹钟不消耗骰子，也不改变「主动搭话」的节奏；它只是一次提醒。',
].join('')

/**
 * 装工具。
 * @param {object} ctx 宿主 ctx
 * @param {{deliver?: (card: string, mode: string, extra?: object) => any, log?: (text: string) => void}} deps
 * @returns {boolean} 真装上了（至少一个）才 true
 */
export function installTools(ctx, deps = {}) {
  const 记账 = typeof deps.log === 'function' ? deps.log : () => {}
  const 服务 = ctx && ctx.tools
  if (!服务 || typeof 服务.register !== 'function') {
    // 老宿主/裁剪宿主：没有工具服务。记一笔，但**绝不 throw** —— 别让闹钟层把整个插件带崩。
    记账('speak-up: ctx.tools 不可用，跳过 speak_alarm / speak_send 注册')
    return false
  }

  const 装过的记号 = Symbol.for('dsh.speak-up.tools')
  if (ctx[装过的记号]) {
    记账('speak-up: 本 ctx 已装过 speak_alarm / speak_send，跳过重复注册')
    return true
  }

  const 工具们 = [
    {
      name: 'speak_alarm',
      description:
        '给自己定一个闹钟（也用来查看/取消）。action=create 时给 at（"HH:MM" 表示最近的那个点，' +
        '过了就落到明天；也可以给 ISO 时间）或 inMinutes（几分钟后）；text 必填，写到点时你想看到的提醒。' +
        'repeat：none 只响一次 / daily 每天同一时刻 / interval 每 intervalMinutes 分钟。' +
        闹钟说明,
      parameters: {
        action: {
          type: 'string',
          description: 'create（默认）/ list / cancel',
          enum: ['create', 'list', 'cancel'],
          required: true,
        },
        at: { type: 'string', description: 'create 用：ISO 时间，或 "HH:MM"（今天；已过就明天）' },
        inMinutes: { type: 'number', description: 'create 用：多少分钟后响（和 at 二选一）' },
        text: { type: 'string', description: 'create 用：到点时给未来那个自己看的一句话（必填）' },
        repeat: {
          type: 'string',
          description: '重复方式，缺省 none',
          enum: ['none', 'daily', 'interval'],
        },
        intervalMinutes: { type: 'number', description: 'repeat=interval 时的间隔分钟数' },
        id: { type: 'string', description: 'cancel 用：要取消的闹钟 id' },
        card: { type: 'string', description: '可选：给哪张卡定，缺省 = 当前会话绑的卡' },
      },
      async execute(args = {}, exec) {
        const action = String(args.action || 'create').toLowerCase()
        const 卡结果 = String(args.card || '').trim()
          ? { card: String(args.card).trim(), from: 'args' }
          : await 当前卡(ctx, exec)
        const card = 卡结果.card

        if (!card) {
          return {
            ok: false,
            action,
            error: '这个会话现在没绑卡（soul-md 里是 none，或者读不到配置），定不了闹钟。' +
              '可以在参数里显式给 card，或者等主人把会话绑到一张卡上。',
          }
        }

        if (action === 'list') {
          const 列表 = alarmsOf(card).map((a) => ({
            id: a.id,
            at: a.at,
            atText: formatAt(a.at),
            text: a.text,
            repeat: a.repeat || 'none',
            intervalMinutes: Number(a.intervalMinutes) || 0,
            preview: alarmText(a),
          }))
          return { ok: true, action, card, count: 列表.length, alarms: 列表 }
        }

        if (action === 'cancel') {
          const 目标 = String(args.id || '').trim()
          if (!目标) return { ok: false, action, card, error: 'cancel 需要 id（先用 action=list 看 id）' }
          const 删掉 = cancelAlarm(card, 目标)
          return 删掉
            ? { ok: true, action, card, id: 目标, cancelled: true }
            : { ok: false, action, card, id: 目标, error: '没有这条闹钟（可能已经响过了，或者 id 不对）' }
        }

        if (action !== 'create') {
          return { ok: false, action, card, error: `不认识的 action：${action}（只能 create / list / cancel）` }
        }

        if (!String(args.text || '').trim()) {
          return { ok: false, action, card, error: 'create 需要 text：到点时你想看到的那句话不能是空的' }
        }

        const 闹钟 = createAlarm(card, {
          at: args.at,
          inMinutes: args.inMinutes,
          text: args.text,
          repeat: args.repeat,
          intervalMinutes: args.intervalMinutes,
        })
        if (!闹钟) {
          return {
            ok: false, action, card,
            error: '没定成：at / inMinutes 至少要有一个合法的（HH:MM 或 ISO，或正数分钟）；' +
              'repeat=interval 还要给 intervalMinutes；单卡闹钟也有上限。',
          }
        }
        return {
          ok: true,
          action: 'create',
          card,
          alarm: {
            id: 闹钟.id,
            at: 闹钟.at,
            atText: formatAt(闹钟.at),
            text: 闹钟.text,
            repeat: 闹钟.repeat,
            intervalMinutes: 闹钟.intervalMinutes,
          },
          note: '定好了。到点宿主会重新叫醒你，你再决定要不要开口。',
        }
      },
    },
    {
      name: 'speak_send',
      description:
        '立刻用这张卡的身份真发一句话（不等骰子、不等到点）。只在真的想现在说、' +
        '或者闹钟醒来后决定要开口时用；平时想说话就等骰子。text 必填，card 缺省 = 当前会话绑的卡。',
      parameters: {
        text: { type: 'string', description: '要真发出去的那句话（必填）', required: true },
        card: { type: 'string', description: '可选：用哪张卡的身份发，缺省 = 当前会话绑的卡' },
      },
      async execute(args = {}, exec) {
        const text = String(args.text || '').trim()
        const 卡结果 = String(args.card || '').trim()
          ? { card: String(args.card).trim(), from: 'args' }
          : await 当前卡(ctx, exec)
        const card = 卡结果.card
        if (!card) {
          return { ok: false, error: '这个会话现在没绑卡，发不出去（可以在参数里显式给 card）。' }
        }
        if (!text) return { ok: false, card, error: 'text 不能是空的' }
        if (typeof deps.deliver !== 'function') {
          return { ok: false, card, error: '宿主还没把投递通道接进来（deps.deliver 缺失），这句没发出去。' }
        }
        try {
          await deps.deliver(card, '真发', { text })
          return { ok: true, card, sent: true, text, note: '真发出去了。' }
        } catch (err) {
          const 原因 = 报错文本(err)
          记账(`speak-up: speak_send 投递失败（${card}）：${原因}`)
          return { ok: false, card, sent: false, error: 原因 }
        }
      },
    },
  ]

  let 装了几条 = 0
  for (const 定义 of 工具们) {
    try {
      服务.register(defineTool(定义))
      装了几条 += 1
      记账(`speak-up: 已注册工具 ${定义.name}`)
    } catch (err) {
      // 重复注册 / 宿主拒绝：记账就好，别让工具层把插件带崩
      记账(`speak-up: 注册 ${定义.name} 失败：${报错文本(err)}`)
    }
  }
  if (装了几条 > 0) ctx[装过的记号] = true
  return 装了几条 > 0
}

/** 给测试用（也方便宿主自检）：不注册，直接看能不能认出会话的卡。 */
export async function resolveCardForTest(ctx, exec) {
  return 当前卡(ctx, exec)
}
