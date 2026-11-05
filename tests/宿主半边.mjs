// tests/宿主半边.mjs —— 0.3.0 多卡版宿主测试。
//
// 覆盖：
//   · 旧配置迁移（幂等；旧「目标会话」按卡归属）
//   · listCards 三级回退（memoryCore / settings / cordis.patch.yml）
//   · 每张卡各掷各的骰子、各自 nextRollAt
//   · 安静时段跳过、dailyCap 拦截
//   · 多卡同时到点并行投递（不串行）
//   · 新路由契约 /cards /config /log /roll /alarms /status /migrate
//   · 0.2.9 的纯函数（判峰时 / 算基础命中线 / 算命中线 / 规整时区名 / 在安静时段）
//
// 跑：node tests/宿主半边.mjs

import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync, renameSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { performance } from 'node:perf_hooks'

const HOME = mkdtempSync(join(tmpdir(), 'speak-up-host-'))
process.env.DSH_HOME = HOME

const 旧配置路径 = join(HOME, 'speak-up-config.json')
const 旧配置 = {
  总开关: true,
  试运行: false,
  目标会话: ['session-9c38f18c-691b-4936-9b7e-7c9947312420'],
  间隔分钟: 60,
  峰时命中线: 20,
  谷时命中线: 60,
  峰谷时区: 'Asia/Shanghai',
  没中加成: 10,
  加成上限: 40,
  安静起: 0,
  安静止: 8,
  近阈值分钟: 20,
  近因子: 0.15,
  远阈值分钟: 360,
  远因子: 1.5,
  搭话冷却分钟: 90,
  触发文案: '测试用的触发文案',
  角色: 'user',
}
writeFileSync(旧配置路径, JSON.stringify(旧配置, null, 2))

mkdirSync(join(HOME, 'profiles', 'web'), { recursive: true })
writeFileSync(
  join(HOME, 'profiles', 'web', 'cordis.patch.yml'),
  [
    '- id: soul-md',
    '  name: dsh-soul-md',
    '  config:',
    '    cards:',
    '      大肥鱼: |-',
    '        一条鱼',
    '      薇斯纳: |-',
    '        一只猫',
    '      鲸鱼: |-',
    '        只有 yaml 里有的卡',
    '    active: 大肥鱼',
    '    sessions:',
    '      session-9c38f18c-691b-4936-9b7e-7c9947312420: 大肥鱼',
    '      fish-onboard-1: 薇斯纳',
    '      session-none-1: none',
    '- id: other',
    '  name: other',
    '',
  ].join('\n'),
  'utf8',
)

const host = await import('../lib/host.js')
const config = await import('../lib/config.js')
const cardsMod = await import('../lib/cards.js')
const dice = await import('../lib/dice.js')
const { createScheduler } = await import('../lib/scheduler.js')

// ---------- 小工具 ----------

let 失败数 = 0
let 通过数 = 0
function 报(标签, 过, 详情 = '') {
  if (过) {
    通过数 += 1
  } else {
    失败数 += 1
    console.log(`✗ ${标签}${详情 ? `  —— ${详情}` : ''}`)
  }
}

function 造res() {
  return {
    statusCode: 0,
    body: null,
    writableEnded: false,
    writeHead(code) {
      this.statusCode = code
    },
    end(s) {
      this.body = JSON.parse(String(s))
      this.writableEnded = true
    },
  }
}

function 造req(method, url, body) {
  const 迭代 = async function* () {
    if (body !== undefined) yield Buffer.from(JSON.stringify(body), 'utf8')
  }
  return { method, url, [Symbol.asyncIterator]: 迭代 }
}

async function 调(routes, path, { method = 'GET', query = '', body } = {}) {
  const 全路径 = query ? `${path}?${query}` : path
  const handler = routes.get(path)
  if (!handler) return { ok: false, error: `没有路由 ${path}` }
  const res = 造res()
  await handler(造req(method, 全路径, body), res)
  return res.body
}

const 睡 = (ms) => new Promise((r) => setTimeout(r, ms))

// ---------- 假 ctx ----------

const 状态 = {
  memoryOn: true,
  settingsOn: true,
  memoryCards: ['大肥鱼', '薇斯纳'],
  settingsValue: {
    cards: { 大肥鱼: {}, 薇斯纳: {}, 海豚: {}, none: {} },
    active: '大肥鱼',
    sessions: {
      'session-9c38f18c-691b-4936-9b7e-7c9947312420': '大肥鱼',
      'fish-onboard-1': '薇斯纳',
      'session-none-1': 'none',
    },
  },
  cardOfMap: {
    'session-9c38f18c-691b-4936-9b7e-7c9947312420': '大肥鱼',
    'fish-onboard-1': '薇斯纳',
  },
  setup: null,
}

function 造ctx() {
  const routes = new Map()
  const timers = []
  const cleanups = []
  const listeners = new Map()
  const controller = {
    inspect: async () => ({ events: [] }),
    resolveAgent: async () => ({ error: 'no-agent' }),
    create: async () => ({ error: 'no-create' }),
  }
  const 会话 = { flush: async () => {}, list: () => [], getSnapshot: () => [] }
  const ctx = {
    logger: { info() {}, warn() {}, error() {}, debug() {} },
    interval(fn, ms) {
      const t = { fn, ms, stopped: false }
      timers.push(t)
      return () => {
        t.stopped = true
      }
    },
    effect(fn) {
      const d = fn()
      if (typeof d === 'function') cleanups.push(d)
      return d
    },
    on(type, fn) {
      if (!listeners.has(type)) listeners.set(type, [])
      listeners.get(type).push(fn)
      return () => {}
    },
    webServer: {
      register({ kind, path, handler }) {
        routes.set(path, handler)
        return () => routes.delete(path)
      },
    },
    sessions: 会话,
    get(name) {
      if (name === 'memoryCore') {
        if (!状态.memoryOn) return undefined
        return {
          listCards: () => 状态.memoryCards,
          cardOf: (sid) => 状态.cardOfMap[String(sid)] || '',
          setupOf: () => 状态.setup,
        }
      }
      if (name === 'settings') {
        if (!状态.settingsOn) return undefined
        return { describe: () => [{ ns: 'soul-md', value: 状态.settingsValue }] }
      }
      if (name === 'sessionController') return controller
      if (name === 'sessions') return 会话
      if (name === 'agents') return { list: () => [], get: () => undefined }
      return undefined
    },
  }
  return { ctx, routes, timers, cleanups, listeners }
}

// ---------- ① apply + 迁移 ----------

const 应用 = 造ctx()
host.apply(应用.ctx)
await 睡(60) // 让 tools.js 的动态 import 走完（fake ctx 没有 tools，只记一行跳过）

报('apply 后注册了 /cards', 应用.routes.has('/dsh-speak-up/cards'))
报('apply 后注册了 /config', 应用.routes.has('/dsh-speak-up/config'))
报('apply 后注册了 /alarms', 应用.routes.has('/dsh-speak-up/alarms'))
报('apply 后注册了 /status', 应用.routes.has('/dsh-speak-up/status'))
报('apply 后注册了 /migrate', 应用.routes.has('/dsh-speak-up/migrate'))
报('apply 后注册了更新路由', 应用.routes.has('/dsh-speak-up/update'))

报('迁移建出了 config.json', existsSync(join(HOME, 'speak-up', 'config.json')))
报('旧配置改名 .migrated', existsSync(`${旧配置路径}.migrated`))
报('旧配置不再留在原地', !existsSync(旧配置路径))

const 全局 = config.loadGlobal()
报('迁移后总开关', 全局.enabled === true)
报('迁移后试运行', 全局.dryRun === false)
报('迁移后间隔分钟', 全局.intervalMinutes === 60)
报('迁移后峰谷时区', 全局.timezone === 'Asia/Shanghai')
报('迁移后安静起', 全局.quietStart === 0)
报('迁移后冷却分钟', 全局.cooldownMinutes === 90)
报('迁移后触发文案', 全局.triggerText === '测试用的触发文案')
report_unknown_keys()

function report_unknown_keys() {
  const raw = JSON.parse(readFileSync(join(HOME, 'speak-up', 'config.json'), 'utf8'))
  报('未知中文键没有漏进新配置', raw['总开关'] === undefined && raw['目标会话'] === undefined)
}

const 大肥鱼策略 = config.loadCardPolicy('大肥鱼')
报('旧目标会话归到大肥鱼', 大肥鱼策略.sessionId === 'session-9c38f18c-691b-4936-9b7e-7c9947312420')

const 再迁 = await 调(应用.routes, '/dsh-speak-up/migrate')
报('重复迁移返回 migrated=false', 再迁 && 再迁.ok === true && 再迁.migrated === false)

// ---------- ② listCards 三级回退 ----------

const 三级 = cardsMod.listCards(应用.ctx)
报(
  'listCards 三级并集',
  三级.join(',') === '大肥鱼,薇斯纳,海豚,鲸鱼',
  `实际 ${三级.join(',')}`,
)

状态.memoryOn = false
状态.settingsOn = false
const 只有yaml = cardsMod.listCards(应用.ctx)
报('listCards 只剩 yaml 时能读出来', 只有yaml.join(',') === '大肥鱼,薇斯纳,鲸鱼', `实际 ${只有yaml.join(',')}`)

状态.memoryCards = ['只有记忆卡']
状态.memoryOn = true
const 只有记忆 = cardsMod.listCards(应用.ctx)
报('listCards 只有 memoryCore', 只有记忆[0] === '只有记忆卡' && 只有记忆.includes('大肥鱼'), `实际 ${只有记忆.join(',')}`)

状态.memoryOn = true
状态.settingsOn = true
状态.memoryCards = ['大肥鱼', '薇斯纳']

报('cardOf 认得显式绑定', cardsMod.cardOf(应用.ctx, 'session-9c38f18c-691b-4936-9b7e-7c9947312420') === '大肥鱼')
报('cardOf 认出 none 不退回 active', cardsMod.cardOf(应用.ctx, 'session-none-1') === '')
报('cardOf 未知会话退到 active', cardsMod.cardOf(应用.ctx, 'session-未知') === '大肥鱼')

// ---------- ③ 每卡独立 nextRollAt / 安静时段 / dailyCap ----------

// 先确认落盘也是「一卡一份」：两张卡的状态文件互不覆盖
{
  config.saveCardState('文件甲', { nextRollAt: 111, misses: 1 })
  config.saveCardState('文件乙', { nextRollAt: 222, misses: 2 })
  const 甲 = config.loadCardState('文件甲')
  const 乙 = config.loadCardState('文件乙')
  报('两张卡的状态文件各存各的', 甲.nextRollAt === 111 && 乙.nextRollAt === 222 && 甲.misses === 1 && 乙.misses === 2)
  报(
    '状态文件按安全卡名分开',
    existsSync(join(HOME, 'speak-up', 'card.文件甲.state.json')) &&
      existsSync(join(HOME, 'speak-up', 'card.文件乙.state.json')),
  )
}

function 造调度({ now, policies, states, deliver }) {
  const saves = []
  const logs = []
  const sched = createScheduler(
    { logger: { info() {} } },
    {
      now: () => now,
      cards: () => Object.keys(policies),
      policy: (card) => policies[card],
      state: (card) => states[card],
      saveState: (card, patch) => {
        states[card] = { ...states[card], ...patch }
        saves.push({ card, patch })
      },
      deliver: deliver || (async () => {}),
      log: (text, card) => logs.push({ text, card }),
    },
  )
  return { sched, saves, logs, states }
}

const 基准 = new Date(2026, 10, 5, 10, 0, 0).getTime() // 2026-11-05 周四 10:00 本地
const 通用策略 = {
  enabled: true,
  intervalMinutes: 10,
  peakThreshold: 100,
  offThreshold: 100,
  quietStart: 0,
  quietEnd: 0,
  missBonus: 10,
  bonusCap: 40,
  nearMinutes: 20,
  nearFactor: 0.15,
  farMinutes: 360,
  farFactor: 1.5,
  cooldownMinutes: 0,
  dailyCap: 0,
}
const 甲 = { ...通用策略, intervalMinutes: 10 }
const 乙 = { ...通用策略, intervalMinutes: 60 }
const 到点们 = []
const 并行统计 = await (async () => {
  const states = {
    甲卡: { nextRollAt: 0, misses: 0, lastSpokeAt: 0, rollsToday: 0, dayKey: dice.dayKeyAt(基准) },
    乙卡: { nextRollAt: 0, misses: 0, lastSpokeAt: 0, rollsToday: 0, dayKey: dice.dayKeyAt(基准) },
  }
  const 起 = performance.now()
  const { sched } = 造调度({
    now: 基准,
    policies: { 甲卡: 甲, 乙卡: 乙 },
    states,
    deliver: async (card) => {
      到点们.push(card)
      await 睡(70)
    },
  })
  await sched.tickNow()
  return { 用时: performance.now() - 起, states }
})()

报('两张卡都到点投递了', 到点们.includes('甲卡') && 到点们.includes('乙卡'), `实际 ${到点们.join(',')}`)
报('多卡并行（不串行）', 并行统计.用时 < 130, `${并行统计.用时.toFixed(0)}ms（串行应 ≥ 140ms）`)

const 甲下 = 并行统计.states.甲卡.nextRollAt - 基准
const 乙下 = 并行统计.states.乙卡.nextRollAt - 基准
报('甲卡 nextRollAt ≈ 10 分钟（±10%）', 甲下 >= 9 * 60000 && 甲下 <= 11 * 60000, `${(甲下 / 60000).toFixed(2)} 分钟`)
报('乙卡 nextRollAt ≈ 60 分钟（±10%）', 乙下 >= 54 * 60000 && 乙下 <= 66 * 60000, `${(乙下 / 60000).toFixed(2)} 分钟`)
报('两卡 nextRollAt 互不相同', 甲下 !== 乙下)
报('掷中后 misses 清零', 并行统计.states.甲卡.misses === 0)

// 安静时段
{
  const 凌晨 = new Date(2026, 10, 5, 3, 0, 0).getTime()
  const states = { 夜卡: { nextRollAt: 0, misses: 0, lastSpokeAt: 0, rollsToday: 0, dayKey: dice.dayKeyAt(凌晨) } }
  const 投过 = []
  const { sched, logs } = 造调度({
    now: 凌晨,
    policies: { 夜卡: { ...通用策略, quietStart: 1, quietEnd: 8 } },
    states,
    deliver: async (card) => 投过.push(card),
  })
  await sched.tickNow()
  报('安静时段不投递', 投过.length === 0)
  const 应到 = dice.quietEndsAt({ quietStart: 1, quietEnd: 8 }, 凌晨)
  报('安静时段把 nextRollAt 推到安静结束', states.夜卡.nextRollAt === 应到)
  报('安静时段留了一行日志', logs.some((x) => x.text.includes('安静时段')))
}

// dailyCap
{
  const states = { 满卡: { nextRollAt: 0, misses: 0, lastSpokeAt: 0, rollsToday: 1, dayKey: dice.dayKeyAt(基准) } }
  const 投过 = []
  const { sched } = 造调度({
    now: 基准,
    policies: { 满卡: { ...通用策略, dailyCap: 1 } },
    states,
    deliver: async (card) => 投过.push(card),
  })
  await sched.tickNow()
  报('dailyCap 到了不再掷', 投过.length === 0)
  报('dailyCap 把 nextRollAt 推到明天 0 点', states.满卡.nextRollAt === dice.startOfNextDay(基准))
}

// 冷却
{
  const states = { 冷卡: { nextRollAt: 0, misses: 0, lastSpokeAt: 基准 - 5 * 60000, rollsToday: 0, dayKey: dice.dayKeyAt(基准) } }
  const 投过 = []
  const { sched } = 造调度({
    now: 基准,
    policies: { 冷卡: { ...通用策略, cooldownMinutes: 20 } },
    states,
    deliver: async (card) => 投过.push(card),
  })
  await sched.tickNow()
  报('冷却中不掷', 投过.length === 0)
  报('冷却中也把表往后挪', states.冷卡.nextRollAt > 基准)
}

// ---------- ④ 路由契约 ----------
{
  const r = await 调(应用.routes, '/dsh-speak-up/cards')
  报('/cards ok', r && r.ok === true && Array.isArray(r.cards))
  const 有 = (r.cards || []).find((x) => x.card === '大肥鱼')
  报('/cards 含大肥鱼', Boolean(有))
  if (有) {
    报('/cards 字段齐全', ['card', 'enabled', 'channel', 'nextRollAt', 'lastSpokeAt', 'rollsToday', 'misses', 'alarms'].every((k) => k in 有))
    报('/cards alarms 是数组', Array.isArray(有.alarms))
  }
}

{
  const r = await 调(应用.routes, '/dsh-speak-up/config', { query: `card=${encodeURIComponent('大肥鱼')}` })
  报('/config?card 返回 global+policy', r && r.ok && r.global && r.policy && r.card === '大肥鱼')
  报('/config 的 policy 带卡名', r.policy.card === '大肥鱼')

  const 改 = await 调(应用.routes, '/dsh-speak-up/config', {
    method: 'POST',
    body: { card: '薇斯纳', patch: { intervalMinutes: 15, channel: 'qq' } },
  })
  报('POST /config 单卡保存生效', 改 && 改.ok && 改.policy.intervalMinutes === 15 && 改.policy.channel === 'qq')
  报('单卡保存不动全局', config.loadGlobal().intervalMinutes === 60)

  const 回 = await 调(应用.routes, '/dsh-speak-up/config', {
    method: 'POST',
    body: { card: '薇斯纳', patch: { intervalMinutes: null } },
  })
  报('POST /config 传 null 删掉覆盖项', 回 && 回.policy.intervalMinutes === 60, `实际 ${回 && 回.policy && 回.policy.intervalMinutes}`)

  const 全 = await 调(应用.routes, '/dsh-speak-up/config', {
    method: 'POST',
    body: { patch: { dailyCap: 3 } },
  })
  报('POST /config 无 card 改全局', 全 && 全.ok && 全.global.dailyCap === 3)
  config.saveGlobal({ dailyCap: 0 })
}

{
  const 全 = await 调(应用.routes, '/dsh-speak-up/log')
  报('/log 不带 card 返回全部', 全 && 全.ok && Array.isArray(全.items) && 全.items.length > 0)
  报('/log 每条都有 card 字段', 全.items.every((x) => typeof x.card === 'string'))
  const 单 = await 调(应用.routes, '/dsh-speak-up/log', { query: `card=${encodeURIComponent('薇斯纳')}` })
  报('/log?card 只回该卡', 单.items.every((x) => x.card === '薇斯纳'))
}

{
  const r = await 调(应用.routes, '/dsh-speak-up/roll', {
    method: 'POST',
    body: { card: '大肥鱼', mode: '演练' },
  })
  报('/roll 演练 ok', r && r.ok === true && typeof r.hit === 'boolean')
  报('/roll 返回 detail', r && typeof r.detail === 'string' && r.detail.includes('演练'))
}

{
  const r = await 调(应用.routes, '/dsh-speak-up/status')
  报('/status 版本 0.3.0', r && r.ok && r.version === '0.3.0', `实际 ${r && r.version}`)
  报('/status timer=true', r && r.timer === true)
  报('/status 带卡列表', r && Array.isArray(r.cards) && r.cards.includes('大肥鱼'))
}

// 闹钟：新建（UI 只发 inMinutes）→ 列表 → 取消
{
  const 新 = await 调(应用.routes, '/dsh-speak-up/alarms', {
    method: 'POST',
    body: { action: 'create', card: '大肥鱼', inMinutes: 30, text: '起来喝水' },
  })
  报('POST /alarms 用 inMinutes 建成', 新 && 新.ok && 新.alarm && 新.alarm.id)
  const id = 新 && 新.alarm && 新.alarm.id

  const 列 = await 调(应用.routes, '/dsh-speak-up/alarms', { query: `card=${encodeURIComponent('大肥鱼')}` })
  报('GET /alarms 能看到新建的', 列 && 列.ok && 列.items.some((a) => a.id === id))

  const 删 = await 调(应用.routes, '/dsh-speak-up/alarms', {
    method: 'POST',
    body: { action: 'cancel', card: '大肥鱼', id },
  })
  报('POST /alarms 取消', 删 && 删.ok && 删.cancelled === true)

  const 坏 = await 调(应用.routes, '/dsh-speak-up/alarms', { method: 'POST', body: { action: 'wat' } })
  报('POST /alarms 非法 action 回 ok=false', 坏 && 坏.ok === false && 坏.error)
}

// ---------- ⑤ 0.2.9 纯函数仍然成立 ----------

报('规整时区名 认 Asia/Shanghai', dice.normalizeTimezone('Asia/Shanghai') === 'Asia/Shanghai')
报('规整时区名 拒绝乱写', dice.normalizeTimezone('乱写的时区') === '')
报('规整时区名 接受 UTC', dice.normalizeTimezone('UTC') === 'UTC')

const 周四上午 = new Date('2026-11-05T10:30:00+08:00')
const 周六上午 = new Date('2026-11-07T10:30:00+08:00')
const 周四午休 = new Date('2026-11-05T12:30:00+08:00')
报('判峰时：工作日 10:30 是峰', dice.isPeakTime(周四上午, 'Asia/Shanghai') === true)
报('判峰时：周六不是峰', dice.isPeakTime(周六上午, 'Asia/Shanghai') === false)
报('判峰时：午休不是峰', dice.isPeakTime(周四午休, 'Asia/Shanghai') === false)

const 策略 = { timezone: 'Asia/Shanghai', peakThreshold: 20, offThreshold: 60 }
const 峰基础 = dice.baseThreshold(策略, 周四上午)
报('算基础命中线：峰时 20', 峰基础.base === 20 && 峰基础.phrase.includes('20'))
const 谷基础 = dice.baseThreshold(策略, 周四上午.toISOString ? new Date('2026-11-05T20:00:00+08:00') : 周四上午)
报('算基础命中线：谷时 60', 谷基础.base === 60 && 谷基础.phrase.includes('60'))

const 线 = dice.threshold(20, 1, 2, 10, 40)
报('算命中线：20×1 + min(40, 2×10) = 40', 线.line === 40 && 线.bonus === 20, `实际 ${JSON.stringify(线)}`)
const 封顶 = dice.threshold(90, 1.5, 9, 10, 40)
报('算命中线：封顶 100', 封顶.line === 100, `实际 ${封顶.line}`)

报('在安静时段：3 点在 1~8', dice.inQuietHours(3, 1, 8) === true)
报('在安静时段：8 点不含', dice.inQuietHours(8, 1, 8) === false)
报('在安静时段：跨零点', dice.inQuietHours(23, 22, 6) === true)
报('在安静时段：起止相同=不启用', dice.inQuietHours(3, 0, 0) === false)

// nextRollAt 抖动范围
{
  const p = { intervalMinutes: 30 }
  const from = 1_800_000_000_000
  const t = dice.nextRollAt(p, from)
  const 差 = t - from
  报('nextRollAt 在 ±10% 内', 差 >= 27 * 60000 && 差 <= 33 * 60000, `${(差 / 60000).toFixed(2)} 分钟`)
}

// ---------- ⑥ 配置文件的容错（BOM / 坏 JSON） ----------

{
  const 新配置路径 = join(HOME, 'speak-up', 'config.json')
  const 原样 = JSON.parse(readFileSync(新配置路径, 'utf8'))
  writeFileSync(新配置路径, '\uFEFF' + JSON.stringify({ ...原样, intervalMinutes: 45 }), 'utf8')
  报('BOM 开头的配置也能读', config.loadGlobal().intervalMinutes === 45, `实际 ${config.loadGlobal().intervalMinutes}`)

  writeFileSync(新配置路径, '{ 这不是 JSON', 'utf8')
  const 坏 = config.loadGlobal()
  报('坏配置不 crash，回落到默认', 坏.intervalMinutes === 30 && 坏.peakThreshold === 20, `实际 ${坏.intervalMinutes}/${坏.peakThreshold}`)
  config.saveGlobal({ intervalMinutes: 原样.intervalMinutes })
  报('坏配置之后还能正常写回', config.loadGlobal().intervalMinutes === 原样.intervalMinutes)
}

// ---------- 收尾 ----------

for (const d of 应用.cleanups) {
  try {
    d()
  } catch (error) {
    /* 收尾失败不改变测试结论 */
  }
}
await 睡(80)
rmSync(HOME, { recursive: true, force: true })

console.log(`\n宿主半边：${通过数} 过 / ${失败数} 败`)
if (失败数 > 0) process.exitCode = 1
