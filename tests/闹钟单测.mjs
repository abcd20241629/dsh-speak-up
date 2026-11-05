// tests/闹钟单测.mjs —— A3 的自测：闹钟表 + 两个 agent 工具
//
// 跑法：node tests/闹钟单测.mjs
//
// 为什么在沙箱里跑：alarms.js / tools.js 依赖 config.js / dice.js 这一层落盘。
// 单测把这几份**真实文件**拷进一个临时目录，再把 DSH_HOME 指到临时 home，
// 这样测的是真代码（不是桩），又不会碰主人的 $DSH_HOME/speak-up。
//
// 时间一律用 `new Date(y, m, d, h, min)` 构造（本地时区），断言也用它，
// 所以在哪个时区跑都不该飘。

import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const 本目录 = dirname(fileURLToPath(import.meta.url))
const 仓库根 = join(本目录, '..')

const 沙箱 = mkdtempSync(join(tmpdir(), 'speakup-alarm-'))
const 沙箱lib = join(沙箱, 'lib')
mkdirSync(沙箱lib, { recursive: true })
for (const 文件 of ['config.js', 'dice.js', 'alarms.js', 'tools.js']) {
  copyFileSync(join(仓库根, 'lib', 文件), join(沙箱lib, 文件))
}
process.env.DSH_HOME = join(沙箱, 'home')

const A = await import(pathToFileURL(join(沙箱lib, 'alarms.js')).href)
const T = await import(pathToFileURL(join(沙箱lib, 'tools.js')).href)

// ---------- 极简断言 ----------
let 通过 = 0
const 失败清单 = []
function 检查(条件, 说明) {
  if (条件) {
    通过 += 1
    console.log(`  ✓ ${说明}`)
  } else {
    失败清单.push(说明)
    console.error(`  ✗ ${说明}`)
  }
}
function 相等(实际, 期望, 说明) {
  const 甲 = typeof 实际 === 'object' ? JSON.stringify(实际) : String(实际)
  const 乙 = typeof 期望 === 'object' ? JSON.stringify(期望) : String(期望)
  检查(甲 === 乙, `${说明}（期望 ${乙}，实际 ${甲}）`)
}
const 是日期 = (ms, y, m, d, h, min) => {
  const x = new Date(ms)
  return x.getFullYear() === y && x.getMonth() === m && x.getDate() === d &&
    x.getHours() === h && x.getMinutes() === min
}
const 睡着 = (ms) => new Promise((r) => setTimeout(r, ms))

const 基准 = new Date(2026, 10, 5, 20, 0, 0, 0).getTime() // 2026-11-05 20:00 本地
const 卡 = '大肥鱼'

try {
  // ========== 1. create：id 格式 / at / 落盘格式 ==========
  console.log('\n1. create：id、at、落盘格式')
  const 闹1 = A.createAlarm(卡, { inMinutes: 10, text: '去拿快递' }, 基准)
  检查(Boolean(闹1), 'createAlarm 返回闹钟')
  检查(new RegExp(`^al-${基准}-[a-z0-9]{4}$`).test(闹1.id), `id 形如 al-<time>-<4位>：${闹1 && 闹1.id}`)
  相等(闹1.at, 基准 + 10 * 60000, 'inMinutes=10 落到 10 分钟后')
  相等(闹1.repeat, 'none', 'repeat 缺省 none')
  相等(闹1.card, 卡, '闹钟里带上卡名')

  const 状态文件 = join(process.env.DSH_HOME, 'speak-up', `card.${卡}.state.json`)
  检查(existsSync(状态文件), `状态文件落在 card.${卡}.state.json`)
  const 盘 = JSON.parse(readFileSync(状态文件, 'utf8'))
  检查(Array.isArray(盘.alarms) && 盘.alarms.length === 1, '盘上 alarms 数组有 1 条')
  相等(盘.alarms[0].id, 闹1.id, '盘上的 id 一致')
  相等(盘.alarms[0].text, '去拿快递', '盘上的 text 一致')
  检查('nextRollAt' in 盘 && 'misses' in 盘, 'state 仍是 config.js 的完整形状（闹钟没把骰子字段冲掉）')
  相等(A.alarmsOf(卡).length, 1, 'alarmsOf 读回 1 条')

  // ========== 2. dueAlarms + none 移除 ==========
  console.log('\n2. due → fire → none 移除')
  相等(A.dueAlarms(基准 + 10 * 60000 - 1).length, 0, '差 1ms 不到点不算 due')
  const 到点 = A.dueAlarms(基准 + 10 * 60000)
  相等(到点.length, 1, '到点了 dueAlarms 命中 1 条')
  相等(到点[0].card, 卡, 'due 里带卡名')
  相等(A.fireAlarm(卡, 闹1.id, 基准 + 10 * 60000), null, 'none 型 fireAlarm 返回 null')
  相等(A.alarmsOf(卡).length, 0, 'none 型响过即删除')

  // ========== 3. daily：推到明天同一时刻 ==========
  console.log('\n3. daily 推明天同一时刻')
  const 日 = A.createAlarm(卡, { at: '20:30', text: '吃饭', repeat: 'daily' }, 基准)
  检查(是日期(日.at, 2026, 10, 5, 20, 30), `'20:30' 解析成今天 20:30：${new Date(日.at).toString()}`)
  const 推1 = A.fireAlarm(卡, 日.id, 日.at)
  检查(是日期(推1.at, 2026, 10, 6, 20, 30), `daily 推到明天 20:30：${new Date(推1.at).toString()}`)
  相等(A.alarmsOf(卡)[0].at, 推1.at, '推进结果已落盘')

  // ========== 4. 跨天边界：23:59 定 00:05 ==========
  console.log('\n4. 跨天边界：23:59 定 00:05')
  const 深夜 = new Date(2026, 10, 5, 23, 59).getTime()
  const 跨 = A.createAlarm(卡, { at: '00:05', text: '睡觉', repeat: 'daily' }, 深夜)
  检查(是日期(跨.at, 2026, 10, 6, 0, 5), `今天 00:05 已过 → 落到明天 00:05：${new Date(跨.at).toString()}`)
  const 推跨 = A.fireAlarm(卡, 跨.id, 跨.at)
  检查(是日期(推跨.at, 2026, 10, 7, 0, 5), `再响一次 → 后天 00:05：${new Date(推跨.at).toString()}`)

  // ========== 5. interval：推 N 分钟 + 停机不补一串 ==========
  console.log('\n5. interval：推 N 分钟、停机不补一串')
  const 间 = A.createAlarm(卡, { inMinutes: 5, text: '喝水', repeat: 'interval', intervalMinutes: 30 }, 基准)
  相等(间.at, 基准 + 5 * 60000, 'interval 的首次 at 还是 5 分钟后')
  相等(A.fireAlarm(卡, 间.id, 间.at).at, 间.at + 30 * 60000, '响过 → 推 30 分钟')

  const 间2 = A.createAlarm(卡, { inMinutes: 5, text: '停机版', repeat: 'interval', intervalMinutes: 30 }, 基准)
  const 停机后 = A.fireAlarm(卡, 间2.id, 间2.at + 100 * 60000) // 停了 100 分钟
  相等(停机后.at, 间2.at + 120 * 60000, '停机 100 分钟：只推到未来最近的 120 分钟，不是补 3 次')

  const 间3 = A.createAlarm(卡, { inMinutes: 5, text: '长停机', repeat: 'interval', intervalMinutes: 60 }, 基准)
  const 长停 = A.fireAlarm(卡, 间3.id, 间3.at + 5 * 3600000)
  检查(长停.at > 间3.at + 5 * 3600000, '停机 5 小时：下一次落在 now 之后')

  // ========== 6. cancel ==========
  console.log('\n6. cancel')
  const 取消 = A.createAlarm('卡丙', { inMinutes: 30, text: '要被取消的' }, 基准)
  相等(A.cancelAlarm('卡丙', 取消.id), true, 'cancel 成功返回 true')
  相等(A.alarmsOf('卡丙').length, 0, '取消后表里没了')
  相等(A.cancelAlarm('卡丙', 取消.id), false, '再取消同一条返回 false')

  // ========== 7. 多卡 + 排序 ==========
  console.log('\n7. 多卡、按 at 排序')
  A.createAlarm('卡甲', { inMinutes: 20, text: '后到' }, 基准)
  A.createAlarm('卡乙', { inMinutes: 10, text: '先到' }, 基准)
  const 多 = A.dueAlarms(基准 + 30 * 60000, { cards: ['卡甲', '卡乙'] })
  相等(多.map((x) => x.alarm.text).join(','), '先到,后到', '按 at 升序排列')
  相等(A.dueAlarms(基准).length, 0, '显式传卡时不会误扫别的卡')

  // ========== 8. fireDueAlarms：成功 / 失败 / 没通道 ==========
  console.log('\n8. fireDueAlarms：成功、失败、没通道')
  const 投递记录 = []
  const deps好 = {
    deliver: async (card, mode, extra) => { 投递记录.push({ card, mode, extra }) },
    log: () => {},
  }
  const 那条 = A.createAlarm('卡甲', { inMinutes: 1, text: '到点了' }, 基准)
  const r1 = await A.fireDueAlarms({}, deps好, 基准 + 60000)
  相等(r1.fired.length, 1, '成功投递记 1 条 fired')
  相等(r1.failed.length, 0, '没有 failed')
  相等(投递记录[0].card, '卡甲', 'deliver 收到卡名')
  相等(投递记录[0].mode, '自动', "deliver 的 mode 是 '自动'")
  检查(投递记录[0].extra.text.startsWith('【你自己定的闹钟｜'), '投递文本带固定前缀')
  检查(投递记录[0].extra.text.includes('到点了'), '投递文本带原话')
  检查(Boolean(投递记录[0].extra.alarm), 'extra 里带上整条闹钟')
  检查(!A.alarmsOf('卡甲').some((a) => a.id === 那条.id), 'none 型投递后被删除')

  A.createAlarm('卡丁', { inMinutes: 1, text: '送不出去', repeat: 'daily' }, 基准)
  const r2 = await A.fireDueAlarms({}, {
    deliver: async () => { throw new Error('通道断了') },
    log: () => {},
  }, 基准 + 60000)
  相等(r2.failed.length, 1, '失败记 1 条 failed')
  相等(r2.failed[0].error, '通道断了', 'failed 里带错误原因')
  const 卡丁剩 = A.alarmsOf('卡丁')
  相等(卡丁剩.length, 1, 'daily 失败后不删，只推进')
  检查(卡丁剩[0].at > 基准 + 60000, '失败也推进到未来，不会每 60s 重打')

  A.createAlarm('卡戊', { inMinutes: 1, text: '没有通道' }, 基准)
  const r3 = await A.fireDueAlarms({}, {}, 基准 + 60000)
  相等(r3.skipped.length, 1, '没有 deliver 时只记 skipped')
  相等(A.alarmsOf('卡戊').length, 1, '没有通道时闹钟留着，不推进也不删（等宿主接好）')

  // ========== 9. tools：注册、描述、create/list/cancel ==========
  console.log('\n9. tools：注册、描述、create/list/cancel')
  const 工具卡 = '工具卡' // 干净卡，避免前面几节留下的闹钟把 list 计数搅乱
  const 注册表 = []
  const 假ctx = {
    tools: { register: (def) => 注册表.push(def) },
    get: (名) => (名 === 'memoryCore' ? { cardOf: () => 工具卡 } : undefined),
  }
  const 装好 = T.installTools(假ctx, { deliver: deps好.deliver, log: () => {} })
  相等(装好, true, 'installTools 返回 true')
  相等(注册表.length, 2, '注册了 2 个工具')
  相等(注册表.map((d) => d.name).sort().join(','), 'speak_alarm,speak_send', '工具名是 speak_alarm / speak_send')

  const 闹钟工具 = 注册表.find((d) => d.name === 'speak_alarm')
  检查(闹钟工具.description.includes('你自己给自己定的闹钟'), 'speak_alarm 描述说明「自己给自己定」')
  检查(闹钟工具.description.includes('到点宿主会重新叫醒你'), 'speak_alarm 描述说明「到点重新叫醒你」')
  检查(闹钟工具.description.includes('决定要不要开口'), 'speak_alarm 描述说明「自己决定要不要开口」')
  相等(闹钟工具.parameters.properties.action.enum.join(','), 'create,list,cancel', 'action 枚举 create/list/cancel')
  相等(闹钟工具.parameters.required.join(','), 'action', '只有 action 是必填')

  const exec = { agent: { session: { id: 'session-test' } } }
  const 建 = await 闹钟工具.execute({ action: 'create', inMinutes: 2, text: '工具定的闹钟' }, exec)
  检查(建.ok, '工具 create 成功')
  相等(建.card, 工具卡, '缺省用 memoryCore.cardOf 认定的卡')
  检查(/^\d{2}-\d{2} \d{2}:\d{2}$/.test(建.alarm.atText), `atText 形如 MM-DD HH:mm：${建.alarm.atText}`)

  const 列 = await 闹钟工具.execute({ action: 'list' }, exec)
  相等(列.count, 1, '工具 list 看到 1 条')
  检查(列.alarms[0].preview.startsWith('【你自己定的闹钟｜'), 'list 带 preview')

  const 消 = await 闹钟工具.execute({ action: 'cancel', id: 建.alarm.id }, exec)
  检查(消.ok && 消.cancelled, '工具 cancel 成功')
  相等((await 闹钟工具.execute({ action: 'list' }, exec)).count, 0, 'cancel 后 list 为空')

  const 空文本 = await 闹钟工具.execute({ action: 'create', inMinutes: 2 }, exec)
  检查(!空文本.ok && /text/.test(空文本.error), 'create 缺 text 明确报错')

  // speak_send
  const 发送记录 = []
  const 假ctx2 = {
    tools: { register: () => {} },
    get: (名) => (名 === 'memoryCore' ? { cardOf: () => 工具卡 } : undefined),
  }
  T.installTools(假ctx2, { deliver: async (card, mode, extra) => { 发送记录.push({ card, mode, extra }) }, log: () => {} })
  相等(T.installTools(假ctx2, {}), true, '同一 ctx 重复 installTools 不报错也不重复注册')
  const 发工具 = 注册表.find((d) => d.name === 'speak_send')
  const 发 = await 发工具.execute({ text: '现在就想说' }, { agent: { session: { id: 'session-test' } } })
  // 注意：这里用的是第一份 deps（deps好.deliver），所以走的是投递记录
  检查(发.ok, 'speak_send 成功')
  检查(投递记录.some((x) => x.mode === '真发' && x.extra.text === '现在就想说'), "speak_send 用 '真发' 调 deliver 并带 text")

  // ========== 10. tools：没有 ctx.tools 不 crash ==========
  console.log('\n10. tools：没有 tools 服务时只记账、不 crash')
  let 账 = ''
  const 结果 = T.installTools({}, { log: (t) => { 账 = t } })
  相等(结果, false, '返回 false')
  检查(账.includes('ctx.tools'), '记账里说明了 ctx.tools 不可用')

  // ========== 11. 取卡三级回退：patch yml ==========
  console.log('\n11. 取卡回退：解析 cordis.patch.yml')
  const 档案目录 = join(process.env.DSH_HOME, 'profiles', 'web')
  mkdirSync(档案目录, { recursive: true })
  writeFileSync(join(档案目录, 'cordis.patch.yml'), [
    '- id: soul-md',
    '  config:',
    '    active: 大肥鱼',
    '    sessions:',
    '      session-yaml: 薇斯纳',
    '      session-none: none',
    '',
  ].join('\n'), 'utf8')

  const 无服务ctx = { tools: { register: () => {} }, get: () => undefined }
  T.installTools(无服务ctx, { log: () => {} })
  const 回退列 = []
  // 用一个新的 ctx 拿工具定义：register 收集一份新的
  const 回退注册 = []
  const 回退ctx = { tools: { register: (d) => 回退注册.push(d) }, get: () => undefined }
  T.installTools(回退ctx, { log: () => {} })
  const 回退工具 = 回退注册.find((d) => d.name === 'speak_alarm')
  const 回退建 = await 回退工具.execute({ action: 'create', inMinutes: 1, text: 'yaml 认卡' }, { agent: { session: { id: 'session-yaml' } } })
  检查(回退建.ok, '回退到 patch yml 后 create 成功')
  相等(回退建.card, '薇斯纳', 'session-yaml 认到「薇斯纳」')
  回退列.push(回退建)

  const 显式none = await 回退工具.execute({ action: 'create', inMinutes: 1, text: '不该落地' }, { agent: { session: { id: 'session-none' } } })
  检查(!显式none.ok && /没绑卡/.test(显式none.error), '显式 none 的会话不会回退到 active，明确报没绑卡')

  const 未知会话 = await 回退工具.execute({ action: 'create', inMinutes: 1, text: '未知会话走 active' }, { agent: { session: { id: 'session-unknown' } } })
  相等(未知会话.card, '大肥鱼', '未知会话回退到 active')

  // ========== 12. parseAt 的 ISO 分支 ==========
  console.log('\n12. parseAt')
  相等(A.parseAt('2026-11-06T09:30', 基准), new Date(2026, 10, 6, 9, 30).getTime(), 'ISO 无时区按本地时间')
  相等(A.parseAt('2026-11-06 09:30', 基准), new Date(2026, 10, 6, 9, 30).getTime(), 'YYYY-MM-DD HH:mm 也认')
  相等(A.parseAt('25:00', 基准), 0, '非法 HH:MM 返回 0')
  相等(A.parseAt('', 基准), 0, '空串返回 0')
  检查(A.alarmText({ at: new Date(2026, 10, 5, 20, 30).getTime(), text: 'x' }) === '【你自己定的闹钟｜11-05 20:30】x', 'alarmText 格式固定')
} catch (err) {
  失败清单.push(`脚本抛异常：${err && (err.stack || err.message || err)}`)
  console.error('\n脚本抛异常：', err)
} finally {
  try { rmSync(沙箱, { recursive: true, force: true }) } catch { /* 清理失败不改变结论 */ }
}

console.log(`\n结果：${通过} 通过 / ${失败清单.length} 失败`)
if (失败清单.length) {
  console.error('失败项：\n- ' + 失败清单.join('\n- '))
  process.exitCode = 1
}
