// DSH「主动搭话」· 宿主半边（0.3.0 多卡版）
//
// 0.2.9 是「一份配置 / 一个定时器 / 一粒骰子」，所有会话共用一张表。
// 0.3.0 改成「每张人格卡各自策略、各自骰子、各自闹钟」：
//
//   每 60 秒 → 看每张卡的 nextRollAt
//     ├─ 没到点 / 关着 / 安静时段 / 冷却中 / 今天掷够了 → 跳过（各卡互不影响）
//     └─ 到点 → 单独掷这张卡的骰子
//          ├─ 没中 → misses++，nextRollAt = now + interval（±10% 抖动）
//          └─ 中了 → delivery.deliverToCard(ctx, card, '自动')
//                    → 按这张卡的会话投递（会话不在就现开）
//
// 投递与工具模块（delivery.js / tools.js / alarms.js）由 A2/A3 并行写，这里一律
// **动态 import + try/catch 兜底**：文件还没落地时宿主照样能起、能过测试、能挂路由。
//
// 旧的纯函数（判峰时 / 算基础命中线 / 算命中线 / 规整时区名 / 在安静时段）
// 仍然从本模块 re-export，tests/宿主半边.mjs 可以照旧 import。

import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createSelfUpdate } from './selfupdate.mjs'

import {
  configDir,
  loadGlobal,
  saveGlobal,
  loadCardPolicy,
  saveCardPolicy,
  loadCardState,
  saveCardState,
  migrateLegacy,
} from './config.js'
import { listCards, cardOf } from './cards.js'
import {
  baseThreshold,
  threshold,
  timeFactor,
  rollValue,
  roll,
  inQuietHours,
} from './dice.js'
import { createScheduler } from './scheduler.js'

// 0.2.9 的纯函数导出，保持兼容（tests / 老调用方）
export {
  规整时区名,
  取周几和分钟,
  判峰时,
  算基础命中线,
  算命中线,
  在安静时段,
} from './dice.js'

/** 插件的对外名字（也是路由前缀、日志前缀、source.kind）。 */
export const name = 'speak-up'

/**
 * 需要宿主提供的服务。
 * ⚠ 'tools' 是为了注册 speak_alarm / speak_send（A3 的 tools.js）；
 *   'settings' 是为了读 soul-md 的卡名（cards.js 第二级回退）。
 */
export const inject = [
  'agents',
  'sessions',
  'sessionTitle',
  'webServer',
  'timer',
  'workspaceRegistry',
  'tools',
]

const ROUTE_PREFIX = '/dsh-speak-up'
const 源标记 = 'speak-up'
const 日志上限 = 60

/** 版本号从 package.json 读，不写死。 */
const 版本 = (() => {
  try {
    const p = JSON.parse(readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', 'package.json'), 'utf8'))
    return String(p.version || '?')
  } catch (error) {
    return '?'
  }
})()

function msgOf(error) {
  return String((error && error.message) || error)
}

function 现在显示() {
  const d = new Date()
  const 补 = (n) => String(n).padStart(2, '0')
  return `${补(d.getMonth() + 1)}-${补(d.getDate())} ${补(d.getHours())}:${补(d.getMinutes())}:${补(d.getSeconds())}`
}

/** 一条消息里有没有真正的正文（只想了 / 只调工具不算开口）。 */
function hasText(message) {
  const content = message && Array.isArray(message.content) ? message.content : []
  return content.some((b) => b && b.type === 'text' && typeof b.text === 'string' && b.text.trim() !== '')
}

// ---------- 日志（内存最近 60 条，按卡带 card 字段） ----------

function createLog(ctx) {
  const items = []
  function push(text, card = '') {
    const item = { t: 现在显示(), text: String(text), card: String(card || '') }
    items.push(item)
    if (items.length > 日志上限) items.shift()
    try {
      ctx.logger.info(`speak-up${item.card ? `[${item.card}]` : ''}: ${item.text}`)
    } catch (error) {
      /* logger 不在也不影响主流程 */
    }
    return item
  }
  return { items, push }
}

// ---------- A2 投递模块（动态 import 兜底） ----------

/**
 * 把一段**指定正文**送进这张卡的会话（闹钟用；delivery.deliverToCard 只发触发文案）。
 * 失败必须 throw —— alarms.fireDueAlarms 靠 allSettled 区分成功/失败。
 */
async function deliverRawToCard(ctx, log, card, text) {
  let mod = null
  try {
    mod = await import('./delivery.js')
  } catch (error) {
    log.push('模块缺失（delivery.js）：这句送不出去', card)
    throw new Error('模块缺失（delivery.js）')
  }
  try {
    // A2 的 deliverTextToCard：正文原样投（不套念头框），随后按这张卡的通道决定
    // 要不要等她回一句、把回复转发到 QQ。注意它**不 throw**，这里自己判 ok。
    if (typeof mod.deliverTextToCard === 'function') {
      // 试运行期间闹钟/指定正文也只记账（和骰子自动命中同一口径）。
      let 模式 = '闹钟'
      try {
        if (loadGlobal().dryRun) 模式 = '演练'
      } catch {
        /* 读不到配置就照常投 */
      }
      const r = await mod.deliverTextToCard(ctx, card, text, 模式)
      if (!r || !r.ok) throw new Error((r && r.error) || 'deliverTextToCard 失败')
      if (r.sessionId) saveCardState(card, { lastSessionId: r.sessionId })
      return { ok: true, sessionId: r.sessionId, how: r.how, channel: r.channel, note: r.note }
    }
    // 旧兜底：只有 sayInSession 时至少把话送进会话（不外发 QQ）
    let target = null
    if (typeof mod.resolveTarget === 'function') target = await mod.resolveTarget(ctx, card)
    let sid = target && target.sessionId ? String(target.sessionId) : ''
    if (!sid) {
      if (typeof mod.ensureSession !== 'function') throw new Error('delivery.js 缺 ensureSession')
      const built = await mod.ensureSession(ctx, card)
      if (!built || !built.ok || !built.sessionId) throw new Error((built && built.error) || '开不了会话')
      sid = String(built.sessionId)
    }
    if (typeof mod.sayInSession !== 'function') throw new Error('delivery.js 缺 sayInSession')
    const r = await mod.sayInSession(ctx, sid, text)
    if (!r || !r.ok) throw new Error((r && r.error) || 'sayInSession 失败')
    saveCardState(card, { lastSessionId: sid })
    return { ok: true, sessionId: sid }
  } catch (error) {
    log.push(`这句话送不进会话：${msgOf(error)}`, card)
    throw error
  }
}

async function deliverToCardSafe(ctx, log, card, mode) {
  let mod = null
  try {
    mod = await import('./delivery.js')
  } catch (error) {
    log.push('模块缺失（delivery.js）：投递这一步这版还没装配上', card)
    return { ok: false, error: '模块缺失（delivery.js）' }
  }
  if (!mod || typeof mod.deliverToCard !== 'function') {
    log.push('模块缺失（delivery.js 没有导出 deliverToCard）', card)
    return { ok: false, error: '模块缺失（delivery.js）' }
  }
  try {
    const result = await mod.deliverToCard(ctx, card, mode)
    return { ok: true, result }
  } catch (error) {
    log.push(`投递失败：${msgOf(error)}`, card)
    return { ok: false, error: msgOf(error) }
  }
}

// ---------- A3 工具模块（动态 import 兜底） ----------

async function installToolsSafe(ctx, log, deliver) {
  let mod = null
  try {
    mod = await import('./tools.js')
  } catch (error) {
    log.push('模块缺失（tools.js）：speak_alarm / speak_send 这版不可用')
    return false
  }
  if (!mod || typeof mod.installTools !== 'function') {
    log.push('模块缺失（tools.js 没有导出 installTools）')
    return false
  }
  try {
    await mod.installTools(ctx, { deliver, log: (text, card) => log.push(text, card) })
    log.push('已注册 speak_alarm / speak_send 工具')
    return true
  } catch (error) {
    log.push(`工具装配失败：${msgOf(error)}`)
    return false
  }
}

// ---------- apply ----------

export function apply(ctx) {
  // 设置页「检查更新」：查这个插件自己的仓库（沿用 0.2.9）
  createSelfUpdate({
    packageRoot: join(dirname(fileURLToPath(import.meta.url)), '..'),
    diag: (m) => {
      try {
        ctx.logger.info('speak-up 查更新: ' + m)
      } catch (error) {
        /* logger 不在就算了 */
      }
    },
  }).register(ctx, ROUTE_PREFIX)

  const log = createLog(ctx)

  // ① 迁移旧配置（幂等）
  let migration = { migrated: false, cards: [] }
  try {
    migration = migrateLegacy(ctx)
  } catch (error) {
    log.push(`旧配置迁移失败（不影响启动）：${msgOf(error)}`)
  }
  if (migration.migrated) {
    log.push(
      `已从 0.2.9 的旧配置迁到 ${configDir()}（归到卡：${migration.cards.length ? migration.cards.join('、') : '无（旧目标会话认不出卡）'}）`,
    )
  }

  // ② 投递函数（scheduler 和 tools 共用同一份）
  //    extra.text 有值 = 闹钟那种「指定正文」；否则走正常的「按卡投递触发文案」。
  const deliver = (card, mode, extra) => {
    if (extra && typeof extra.text === 'string' && extra.text.trim()) {
      return deliverRawToCard(ctx, log, card, extra.text)
    }
    // 试运行：骰子自动命中时只造念头、不真发（手动「真发」按钮不受影响）。
    // 这里必须兜住，否则 dryRun 只是设置页上一个好看的开关。
    let 实际模式 = mode
    try {
      if (mode === '自动' && loadGlobal().dryRun) 实际模式 = '演练'
    } catch {
      /* 配置读不出来就按原模式走 */
    }
    return deliverToCardSafe(ctx, log, card, 实际模式)
  }

  // 闹钟这一轮能响的卡：总开关关着、或者正处在安静时段里的卡先不响。
  // 安静时段判断沿用这张卡自己的 quietStart/quietEnd（本地墙钟，跨零点也认）。
  const 闹钟能响的卡 = () => {
    const 现在 = new Date()
    const 小时 = 现在.getHours()
    return listCards(ctx).filter((card) => {
      try {
        const p = loadCardPolicy(card)
        if (!p || p.enabled === false) return false
        return !inQuietHours(小时, Number(p.quietStart), Number(p.quietEnd))
      } catch (error) {
        return true
      }
    })
  }

  // ③ 调度器
  const scheduler = createScheduler(ctx, {
    deliver: async (card, mode) => {
      const r = await deliver(card, mode)
      if (!r.ok) throw new Error(r.error || '投递失败')
      return r.result
    },
    log: (text, card) => log.push(text, card),
    cards: () => listCards(ctx),
    policy: (card) => loadCardPolicy(card),
    state: (card) => loadCardState(card),
    saveState: (card, patch) => saveCardState(card, patch),
    // 每轮掷完顺手看看有没有闹钟到点（A3 的 alarms.js；文件缺失就静默跳过）
    // 安静时段内到点的闹钟这一轮先不响：她定闹钟是为了提醒主人做事，不是半夜叫人起床。
    // 下一轮（安静结束后的第一跳）再触发。
    afterTick: async () => {
      let mod = null
      try {
        mod = await import('./alarms.js')
      } catch (error) {
        return
      }
      if (!mod || typeof mod.fireDueAlarms !== 'function') return
      await mod.fireDueAlarms(ctx, {
        deliver,
        log: (text, card) => log.push(text, card),
        cards: () => 闹钟能响的卡(),
      })
    },
  })

  ctx.effect(() => {
    scheduler.start()
    return () => scheduler.stop()
  }, 'speak-up: 每 60 秒看一次各卡的表')

  // ④ 工具（A3 的文件还没落地时只记一行「模块缺失」）
  void installToolsSafe(ctx, log, deliver)

  // ---------- 路由辅助 ----------

  const readBody = async (req) => {
    let body = ''
    try {
      for await (const chunk of req) body += chunk
    } catch (error) {
      return {}
    }
    try {
      const v = JSON.parse(body || '{}')
      return v && typeof v === 'object' && !Array.isArray(v) ? v : {}
    } catch (error) {
      return {}
    }
  }

  const queryOf = (req) => {
    try {
      return new URL(String(req && req.url ? req.url : '/'), 'http://localhost').searchParams
    } catch (error) {
      return new URLSearchParams()
    }
  }

  const send = (res, obj) => {
    if (!res || res.writableEnded) return
    try {
      res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
      res.end(JSON.stringify(obj))
    } catch (error) {
      /* 连接已经断了 */
    }
  }

  /**
   * 注册一条 exact 路由。所有 handler 的异常都在这里兜住：
   * 页面永远拿到 {ok:false,error}，不会看到 500 / 挂起的请求。
   */
  const route = (path, handler) => {
    const off = ctx.webServer.register({
      kind: 'exact',
      path,
      handler: async (req, res) => {
        try {
          const out = await handler(req, res)
          if (out !== undefined) send(res, out)
        } catch (error) {
          send(res, { ok: false, error: msgOf(error) })
        }
      },
    })
    // 热装配时 fiber 可能被换掉；返回的 disposer 交给调用方保管，
    // 这里不再包 ctx.effect（实测包了之后热注入环境下路由不生效）。
    return typeof off === 'function' ? off : undefined
  }

  const alarmView = (a) => ({ id: a.id, at: a.at, text: a.text, repeat: a.repeat })

  // ---------- 路由 ----------

  // 每张卡的现状（设置页首屏）
  route(`${ROUTE_PREFIX}/cards`, async () => {
    const cards = listCards(ctx).map((card) => {
      const p = loadCardPolicy(card)
      const s = loadCardState(card)
      return {
        card,
        enabled: p.enabled,
        channel: p.channel,
        sessionId: p.sessionId || '',
        nextRollAt: s.nextRollAt,
        lastSpokeAt: s.lastSpokeAt,
        rollsToday: s.rollsToday,
        misses: s.misses,
        alarms: s.alarms.map(alarmView),
      }
    })
    return { ok: true, cards }
  })

  // 全局 / 单卡设置：GET 读，POST 合并保存（同一路径，按 method 分派）
  route(`${ROUTE_PREFIX}/config`, async (req) => {
    if (req.method === 'POST') {
      const body = await readBody(req)
      const patch = body.patch && typeof body.patch === 'object' ? body.patch : body
      const card = String(body.card || '').trim()
      if (card) {
        const policy = saveCardPolicy(card, patch)
        log.push(`「${card}」的设置已保存`, card)
        return { ok: true, global: loadGlobal(), card, policy }
      }
      const global = saveGlobal(patch)
      log.push('全局默认设置已保存')
      return { ok: true, global }
    }
    const card = String(queryOf(req).get('card') || '').trim()
    const global = loadGlobal()
    if (!card) return { ok: true, global }
    return { ok: true, global, card, policy: loadCardPolicy(card) }
  })

  // 日志（?card= 过滤；不带 card 就是全部）
  route(`${ROUTE_PREFIX}/log`, async (req) => {
    const q = queryOf(req)
    const card = String(q.get('card') || '').trim()
    const limit = Math.min(200, Math.max(1, Math.round(Number(q.get('limit')) || 日志上限)))
    const items = log.items.filter((x) => !card || x.card === card).slice(-limit)
    return { ok: true, items }
  })

  // 手动掷一次：演练 / 真发（只动这一张卡；不改 misses / rollsToday / nextRollAt）
  route(`${ROUTE_PREFIX}/roll`, async (req) => {
    const body = await readBody(req)
    const card = String(body.card || '').trim() || listCards(ctx)[0] || ''
    if (!card) return { ok: false, error: '还没有任何人格卡，没法演练' }
    const mode = body.mode === '真发' ? '真发' : '演练'
    const p = loadCardPolicy(card)
    const s = loadCardState(card)
    const now = Date.now()
    const base = baseThreshold(p, new Date(now))
    const factor = timeFactor(s, p, now)
    const { line } = threshold(base.base, factor, s.misses, p.missBonus, p.bonusCap)
    const value = rollValue()
    const hit = roll(line, value)
    let detail =
      `【${mode}】${hit ? '掷中 ✓' : '没掷中 ✗'} 掷出 ${value.toFixed(1)}（命中线 ${line.toFixed(1)}）` +
      `｜${base.phrase} × 时机因子 ${factor}`
    if (hit && mode === '真发') {
      const r = await deliver(card, '真发')
      if (r.ok) {
        const sid = r.result && r.result.sessionId ? String(r.result.sessionId) : ''
        saveCardState(card, { lastSpokeAt: now, ...(sid ? { lastSessionId: sid } : {}) })
        detail += `｜已按「${card}」的会话投递`
      } else {
        detail += `｜投递失败：${r.error}`
      }
    } else if (hit) {
      detail += '｜演练：真的掷中了，但没有投递'
    } else {
      detail += '｜演练：没掷中'
    }
    log.push(detail, card)
    return { ok: true, hit, line, value, card, detail }
  })

  // 闹钟：GET 列表（?card= 过滤；不带 card 就全卡），POST 新建 / 取消
  route(`${ROUTE_PREFIX}/alarms`, async (req) => {
    if (req.method === 'POST') {
      const body = await readBody(req)
      const action = body.action === 'create' ? 'create' : body.action === 'cancel' ? 'cancel' : ''
      if (!action) return { ok: false, error: 'action 只能是 create / cancel' }
      const card = String(body.card || '').trim() || listCards(ctx)[0] || ''
      if (!card) return { ok: false, error: '没有指定卡片，也没有任何人格卡' }

      let mod = null
      try {
        mod = await import('./alarms.js')
      } catch (error) {
        return { ok: false, error: '模块缺失（alarms.js），闹钟还没装配上' }
      }

      if (action === 'create') {
        if (typeof mod.createAlarm !== 'function') return { ok: false, error: '模块缺失（alarms.js createAlarm）' }
        // B 的界面只发 inMinutes；工具可能发 at（ISO 或毫秒）——两个都传
        const alarm = await mod.createAlarm(card, {
          at: body.at,
          inMinutes: body.inMinutes,
          text: body.text,
          repeat: body.repeat,
          intervalMinutes: body.intervalMinutes,
        })
        if (!alarm) return { ok: false, error: '闹钟没建成：at / inMinutes 至少要有一个合法的，text 不能为空' }
        log.push(`给「${card}」设了一个闹钟：${String(body.text || '').slice(0, 40)}`, card)
        return { ok: true, card, alarm, items: loadCardState(card).alarms.map(alarmView) }
      }

      if (typeof mod.cancelAlarm !== 'function') return { ok: false, error: '模块缺失（alarms.js cancelAlarm）' }
      const cancelled = await mod.cancelAlarm(card, String(body.id || ''))
      log.push(`取消了「${card}」的一个闹钟：${String(body.id || '')}`, card)
      return { ok: true, card, cancelled: Boolean(cancelled), items: loadCardState(card).alarms.map(alarmView) }
    }

    const card = String(queryOf(req).get('card') || '').trim()
    if (card) return { ok: true, card, items: loadCardState(card).alarms.map(alarmView) }
    const items = []
    for (const c of listCards(ctx)) {
      for (const a of loadCardState(c).alarms) items.push({ card: c, ...alarmView(a) })
    }
    return { ok: true, items }
  })

  // 一眼看状态
  route(`${ROUTE_PREFIX}/status`, async () => {
    const st = scheduler.status()
    return { ok: true, version: 版本, timer: Boolean(st.timer), cards: listCards(ctx) }
  })

  // 手动再跑一次迁移（幂等；设置页 / 诊断用）
  route(`${ROUTE_PREFIX}/migrate`, async () => {
    const r = migrateLegacy(ctx)
    if (r.migrated) log.push(`又迁了一次旧配置（归卡：${r.cards.join('、') || '无'}）`)
    return { ok: true, migrated: Boolean(r.migrated), cards: r.cards }
  })

  // ---------- 会话事件：记每张卡上次「人说话 / 卡开口」 ----------

  ctx.effect(() => {
    if (typeof ctx.on !== 'function') return
    const off = ctx.on('session/event', (session, event) => {
      try {
        if (!event || !session) return
        const sid = String(session.id || session.sessionId || '')
        if (!sid) return
        const card = cardOf(ctx, sid)
        if (!card) return
        const time = Number(event.time) || Date.now()
        if (event.type === 'user/message') {
          const source = event.data && event.data.source
          if (source && source.kind === 源标记) return
          saveCardState(card, { lastUserAt: time, lastSessionId: sid })
          return
        }
        if (event.type === 'assistant/message' && hasText(event.data && event.data.message)) {
          saveCardState(card, { lastSpokeAt: time, lastSessionId: sid })
        }
      } catch (error) {
        /* 记时间失败不影响会话 */
      }
    })
    return () => {
      try {
        if (typeof off === 'function') off()
      } catch (error) {
        /* ignore */
      }
    }
  }, 'speak-up: 记下每张卡上次说话的时间')

  // 某张卡的会话这一轮炸了，至少在日志里留一句
  ctx.effect(() => {
    if (typeof ctx.on !== 'function') return
    const off = ctx.on('agent/error', ({ agent, error } = {}) => {
      try {
        const sid = String((agent && (agent.id || (agent.session && agent.session.id))) || '')
        const card = sid ? cardOf(ctx, sid) : ''
        if (!card) return
        log.push(`这张卡的会话这一轮报错了：${msgOf(error)}`, card)
      } catch (e2) {
        /* ignore */
      }
    })
    return () => {
      try {
        if (typeof off === 'function') off()
      } catch (error) {
        /* ignore */
      }
    }
  }, 'speak-up: 卡会话报错留痕')

  try {
    const cards = listCards(ctx)
    ctx.logger.info(
      `speak-up: v${版本} 已加载，配置目录 ${configDir()}，卡 ${cards.length} 张${cards.length ? `（${cards.join('、')}）` : ''}`,
    )
  } catch (error) {
    /* logger 不在就算了 */
  }
}
