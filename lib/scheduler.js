// 调度器 —— 每 60 秒看一次「哪张卡到点了」，到点的卡各掷各的骰子，互不排队。
//
// 设计口径（CONTRACT.md §3）：
//   · 只有 policy.enabled 的卡才掷；nextRollAt 没到就跳过（每卡自己的表）
//   · 安静时段：不掷，把 nextRollAt 推到安静结束（不是每秒都来记一笔）
//   · 冷却：距这张卡上次真开口不足 cooldownMinutes → 不掷，等下一轮
//   · dailyCap > 0 且今天掷够了 → 推到明天 0 点（rollsToday 跨天清零）
//   · 掷之前先把 nextRollAt / rollsToday 写盘（重启不会立刻再掷）
//   · 多卡同时到点用 Promise.allSettled 并行走；单卡 deliver 抛错只记账
//
// deps 由 host.js 注入；测试也可以直接喂假 deps（含可选 deps.now 控制时间）。

import {
  baseThreshold,
  threshold,
  timeFactor,
  inQuietHours,
  roll as rollDice,
  rollValue,
  nextRollAt as nextRollAtFor,
  quietEndsAt,
  startOfNextDay,
  dayKeyAt,
} from './dice.js'

function msgOf(error) {
  return String((error && error.message) || error)
}

function pad2(n) {
  return String(n).padStart(2, '0')
}

function clockOf(ms) {
  const d = new Date(ms)
  return `${pad2(d.getHours())}:${pad2(d.getMinutes())}`
}

function asNum(v, def) {
  const n = Number(v)
  return Number.isFinite(n) ? n : def
}

export function createScheduler(ctx, deps = {}) {
  const log = typeof deps.log === 'function'
    ? deps.log
    : (text, card) => {
      try {
        ctx.logger.info(`speak-up${card ? `[${card}]` : ''}: ${text}`)
      } catch (error) {
        /* logger 不在就算了 */
      }
    }
  const now = typeof deps.now === 'function' ? deps.now : () => Date.now()
  const policyOf = (card) => (typeof deps.policy === 'function' ? deps.policy(card) || {} : {})
  const stateOf = (card) => (typeof deps.state === 'function' ? deps.state(card) || {} : {})
  const saveState = (card, patch) => {
    if (typeof deps.saveState === 'function') {
      try {
        deps.saveState(card, patch)
      } catch (error) {
        log(`状态写不进去（${msgOf(error)}），这轮照跑`, card)
      }
    }
  }
  const cardList = () => {
    if (typeof deps.cards !== 'function') return []
    try {
      const list = deps.cards()
      return Array.isArray(list) ? list.map((x) => String(x)).filter(Boolean) : []
    } catch (error) {
      log(`列卡失败：${msgOf(error)}`)
      return []
    }
  }

  let timer = null
  let ticking = false
  let startedAt = 0
  let lastTickAt = 0

  function start() {
    if (timer !== null) return true
    if (typeof ctx?.interval !== 'function') {
      log('拿不到 timer 服务（ctx.interval 不在），定时掷骰不会跑 —— 手动入口 / 工具还能用')
      return false
    }
    startedAt = now()
    timer = ctx.interval(() => {
      void tick().catch((error) => log(`这一轮调度出错：${msgOf(error)}`))
    }, 60 * 1000)
    return true
  }

  function stop() {
    if (timer === null) return
    try {
      if (typeof timer === 'function') timer()
      else if (timer && typeof timer.dispose === 'function') timer.dispose()
    } catch (error) {
      /* 停表失败：Cordis 卸载时也会收走 */
    }
    timer = null
  }

  function status() {
    return {
      timer: timer !== null,
      ticking,
      startedAt,
      lastTickAt,
      cards: cardList().length,
    }
  }

  /**
   * 看一轮。传 cards 就只看这些卡（测试 / /status 用），不传就用 deps.cards()。
   * 返回每张到点卡的掷骰结果（没到点/被规则拦下的卡不在里面）。
   */
  async function tick(cards) {
    if (ticking) return { skipped: 'busy' }
    ticking = true
    const at = now()
    const results = []
    try {
      const list = Array.isArray(cards) && cards.length ? cards.map(String) : cardList()
      const due = []
      const today = dayKeyAt(at)

      for (const card of list) {
        try {
          const policy = policyOf(card)
          if (policy.enabled === false) continue

          let state = stateOf(card)
          if (state.dayKey !== today) {
            state = { ...state, rollsToday: 0, dayKey: today }
            saveState(card, { rollsToday: 0, dayKey: today })
          }

          if (asNum(state.nextRollAt, 0) > at) continue

          // 安静时段：跳过，并把下一次推到安静结束
          if (inQuietHours(new Date(at).getHours(), policy.quietStart, policy.quietEnd)) {
            const end = quietEndsAt(policy, at)
            saveState(card, { nextRollAt: end })
            log(`现在 ${clockOf(at)} 在安静时段（${asNum(policy.quietStart, 1)}~${asNum(policy.quietEnd, 8)} 点），跳过；${clockOf(end)} 之后再说`, card)
            continue
          }

          // 冷却：只看「这张卡上次真的开口」之后过了多久
          const cooldown = asNum(policy.cooldownMinutes, 20)
          if (cooldown > 0 && asNum(state.lastSpokeAt, 0) > 0) {
            const minutes = (at - asNum(state.lastSpokeAt, 0)) / 60000
            if (minutes < cooldown) {
              saveState(card, { nextRollAt: nextRollAtFor(policy, at) })
              log(`这张卡刚开过口（${minutes.toFixed(1)} 分钟前，冷却 ${cooldown} 分钟），这轮不掷`, card)
              continue
            }
          }

          // 今天的次数上限
          const cap = asNum(policy.dailyCap, 0)
          if (cap > 0 && asNum(state.rollsToday, 0) >= cap) {
            const nextDay = startOfNextDay(at)
            saveState(card, { nextRollAt: nextDay })
            log(`今天已经掷了 ${asNum(state.rollsToday, 0)} 次（上限 ${cap}），明天再说`, card)
            continue
          }

          due.push({ card, policy, state })
        } catch (error) {
          log(`检查这张卡时出错：${msgOf(error)}`, card)
        }
      }

      const settled = await Promise.allSettled(due.map((item) => rollOnce(item, at)))
      for (const r of settled) {
        if (r.status === 'fulfilled' && r.value) results.push(r.value)
        else if (r.status === 'rejected') log(`掷骰这一路出错：${msgOf(r.reason)}`)
      }

      // 收尾钩子：闹钟到点检查（host 注入 alarms.fireDueAlarms）
      if (typeof deps.afterTick === 'function') {
        try {
          await deps.afterTick()
        } catch (error) {
          log(`每轮收尾出错：${msgOf(error)}`)
        }
      }

      lastTickAt = now()
      return results
    } finally {
      ticking = false
    }
  }

  /** 给一张已经到点的卡掷一次（并行单元；任何异常都在内部吞掉）。 */
  async function rollOnce({ card, policy, state }, at) {
    try {
      const base = baseThreshold(policy, new Date(at))
      const factor = timeFactor(state, policy, at)
      const { line, bonus } = threshold(
        base.base,
        factor,
        asNum(state.misses, 0),
        asNum(policy.missBonus, 10),
        asNum(policy.bonusCap, 40),
      )
      const value = rollValue()
      const hit = rollDice(line, value)
      const next = nextRollAtFor(policy, at)
      const rollsToday = asNum(state.rollsToday, 0) + 1
      const equation =
        `${line.toFixed(1)} = ${base.phrase} × 时机因子 ${factor}（` +
        `${state.lastUserAt || state.lastSpokeAt ? '距上次说话已算' : '还没有说话记录'}）` +
        `${bonus > 0 ? ` + 没中加成 ${bonus.toFixed(1)}` : ''}`

      // ⚠ 先写 nextRollAt / rollsToday：进程要是死在投递里，重启也不会立刻再掷
      saveState(card, { nextRollAt: next, rollsToday, dayKey: dayKeyAt(at) })

      if (!hit) {
        saveState(card, { misses: asNum(state.misses, 0) + 1 })
        log(`没掷中 ✗ 掷出 ${value.toFixed(1)}（命中线 ${line.toFixed(1)} —— 要掷到 ${line.toFixed(1)} 以下才开口）｜${equation}`, card)
        return { card, hit: false, line, value }
      }

      log(`掷中 ✓ 掷出 ${value.toFixed(1)}（命中线 ${line.toFixed(1)}）｜${equation}｜开始按这张卡的会话投递`, card)
      const deliver = typeof deps.deliver === 'function' ? deps.deliver : null
      if (!deliver) {
        saveState(card, { misses: 0 })
        log('没有注入 deliver（delivery.js 缺失？），这轮当作没投出去', card)
        return { card, hit: true, delivered: false, line, value, error: 'no-deliver' }
      }
      try {
        const 结果 = await deliver(card, '自动')
        const 真发 = !(结果 && typeof 结果 === 'object' && 结果.how === 'dry-run')
        // 演练（dry-run）只记账，不算「开口」：不写 lastSpokeAt，否则冷却会凭空吃掉 90 分钟。
        saveState(card, 真发 ? { misses: 0, lastSpokeAt: at } : { misses: 0 })
        return { card, hit: true, delivered: true, dryRun: !真发, line, value }
      } catch (error) {
        saveState(card, { misses: asNum(state.misses, 0) + 1 })
        log(`投递失败（这轮算没投中）：${msgOf(error)}`, card)
        return { card, hit: true, delivered: false, line, value, error: msgOf(error) }
      }
    } catch (error) {
      log(`掷骰出错：${msgOf(error)}`, card)
      return { card, hit: false, error: msgOf(error) }
    }
  }

  return {
    start,
    stop,
    tick,
    tickNow: (cards) => tick(cards),
    status,
  }
}
