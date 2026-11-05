// tests/投递单测.mjs —— lib/delivery.js / lib/channels.js 的假 ctx 单测（0.3.0 A2）
//
// ⚠ 不装插件、不碰 DSH、不碰真实会话/真实 QQ：
//   · DSH_HOME 指到系统临时目录（channels 读 aurabot 配置、delivery 兜底 patch 都跟着走）；
//   · 会话/设置/控制器全是假的，只记录「谁先被调用」；
//   · 真机才验得了的（followup 真的开一轮、QQ 真的送达）这里**不验**。
//
// 覆盖（CONTRACT §6 第 3 条）：
//   ① resolveTarget 的 4 级顺序：显式 → 该卡最近未归档 → 开荒会话 → null；
//      以及「别的卡 / 已归档」的两个反例（宁可不投，也不串鱼）；
//   ② sendQQ 的三种返回：no-aurabot / no-qq / ok；
//   ③ ensureSession 的「先登记、后建」调用顺序（settings 分支 + patch 兜底分支）；
//   ④ sayInSession 的消息形状（source 带 plugin）与 flush 时机；
//   ⑤ deliverToCard 演练只造念头；
//   ⑥ deliverTextToCard（闹钟/speak_send 指定正文）：不套 frameThought，
//      dsh 通道留在会话、qq 通道等回复后转发给**主人 ownerQQ**。
//
// 跑法： node tests/投递单测.mjs

import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const 家 = mkdtempSync(join(tmpdir(), 'speak-up-a2-'))
process.env.DSH_HOME = 家
process.env.AURABOT_DATA_DIR = join(家, 'plugins-data', 'aurabot')
// 不碰真实 profile 的 patch
const 假patch = join(家, 'cordis.patch.yml')
process.env.DSH_PROFILE_PATCH = 假patch

const 投递 = await import(new URL('../lib/delivery.js', import.meta.url).href)
const 通道 = await import(new URL('../lib/channels.js', import.meta.url).href)

// ---------- 小测试框架 ----------

let 通过 = 0
const 失败 = []

function 验(名字, 条件, 细节 = '') {
  if (条件) {
    通过++
    console.log('  ✓ ' + 名字)
    return true
  }
  失败.push(名字 + (细节 ? '：' + 细节 : ''))
  console.log('  ✗ ' + 名字 + (细节 ? '：' + 细节 : ''))
  return false
}

function 相等(名字, 实际, 期望) {
  return 验(名字, Object.is(实际, 期望) || JSON.stringify(实际) === JSON.stringify(期望),
    `实际 ${JSON.stringify(实际)}，期望 ${JSON.stringify(期望)}`)
}

/** 造一个假 ctx：get(name) 查表；sessions/workspaceRegistry 也按需挂上。 */
function 造ctx(部件 = {}) {
  const 表 = new Map(Object.entries(部件).filter(([, v]) => v !== undefined))
  const ctx = {
    get: (名字) => 表.get(名字),
  }
  if (部件.sessions !== undefined) ctx.sessions = 部件.sessions
  if (部件.workspaceRegistry !== undefined) ctx.workspaceRegistry = 部件.workspaceRegistry
  return ctx
}

// ---------- ① resolveTarget 4 级顺序 ----------

console.log('\n[1] resolveTarget 4 级顺序')

{
  // 显式 sessionId 优先
  const ctx = 造ctx({
    workspaceRegistry: { archivedSessionIds: [] },
    memoryCore: { cardOf: () => '大肥鱼', setupOf: () => ({ sessionId: 'fish-onboard-1' }) },
    sessionController: { list: () => ({ items: [{ sessionId: 'session-recent' }] }) },
  })
  const 目标 = 投递.resolveTargetWithPolicy(ctx, '大肥鱼', { sessionId: 'session-explicit' })
  相等('1a 显式 sessionId', 目标 && 目标.sessionId, 'session-explicit')
  相等('1a how = explicit', 目标 && 目标.how, 'explicit')
}

{
  // 显式会话已归档 → 跳过，落到最近会话
  const ctx = 造ctx({
    workspaceRegistry: { archivedSessionIds: ['session-explicit'] },
    memoryCore: { cardOf: (sid) => (sid === 'session-recent' ? '大肥鱼' : '') },
    sessionController: { list: () => ({ items: [{ sessionId: 'session-explicit' }, { sessionId: 'session-recent' }] }) },
  })
  const 目标 = 投递.resolveTargetWithPolicy(ctx, '大肥鱼', { sessionId: 'session-explicit' })
  相等('1b 已归档的显式会话被跳过（how=recent）', 目标 && 目标.how, 'recent')
  相等('1b 命中最近会话', 目标 && 目标.sessionId, 'session-recent')
}

{
  // 最近会话：跳过别的卡、跳过已归档，只认 cardOf === 本卡
  const ctx = 造ctx({
    workspaceRegistry: { archivedSessionIds: ['session-own-archived'] },
    memoryCore: {
      cardOf: (sid) => ({ 'session-other': '薇斯纳', 'session-own-archived': '大肥鱼', 'session-own': '大肥鱼' })[sid] || '',
      setupOf: () => ({ sessionId: 'fish-onboard-1' }),
    },
    sessionController: {
      list: () => ({ items: [{ sessionId: 'session-other' }, 'session-own-archived', { sessionId: 'session-own' }] }),
    },
  })
  const 目标 = 投递.resolveTargetWithPolicy(ctx, '大肥鱼', {})
  相等('2a 不拿别的卡的会话', 目标 && 目标.sessionId, 'session-own')
  相等('2a how = recent', 目标 && 目标.how, 'recent')
}

{
  // 没有属于本卡的最近会话 → 开荒会话
  const ctx = 造ctx({
    workspaceRegistry: { archivedSessionIds: [] },
    memoryCore: {
      cardOf: () => '薇斯纳',
      setupOf: (card) => (card === '大肥鱼' ? { status: 'done', sessionId: 'fish-onboard-1' } : null),
    },
    sessionController: { list: () => ({ items: [{ sessionId: 'session-other' }] }) },
  })
  const 目标 = 投递.resolveTargetWithPolicy(ctx, '大肥鱼', {})
  相等('3a 开荒会话', 目标 && 目标.sessionId, 'fish-onboard-1')
  相等('3a how = onboard', 目标 && 目标.how, 'onboard')
}

{
  // 开荒会话也归档了 → 不投，交给现开
  const ctx = 造ctx({
    workspaceRegistry: { archivedSessionIds: ['fish-onboard-1'] },
    memoryCore: { cardOf: () => '', setupOf: () => ({ sessionId: 'fish-onboard-1' }) },
    sessionController: { list: () => ({ items: [] }) },
  })
  相等('3b 归档的开荒会话被跳过（→ null）', 投递.resolveTargetWithPolicy(ctx, '大肥鱼', {}), null)
}

{
  // 什么都没有 → null
  const ctx = 造ctx({ workspaceRegistry: { archivedSessionIds: [] } })
  相等('4a 什么都没有 → null', 投递.resolveTargetWithPolicy(ctx, '大肥鱼', {}), null)
}

{
  // 服务缺失也不崩（memoryCore / sessionController 都不在）
  const ctx = 造ctx({})
  相等('4b 服务全缺 → null（不抛）', 投递.resolveTargetWithPolicy(ctx, '大肥鱼', {}), null)
  相等('4c 空卡名 → null', 投递.resolveTargetWithPolicy(ctx, '', {}), null)
}

{
  // resolveTarget 异步包装（config.js 不在时按空策略 → 仍能走到 onboard）
  const ctx = 造ctx({
    workspaceRegistry: { archivedSessionIds: [] },
    memoryCore: { cardOf: () => '', setupOf: () => ({ sessionId: 'fish-onboard-2' }) },
    sessionController: { list: () => ({ items: [] }) },
  })
  const 目标 = await 投递.resolveTarget(ctx, '大肥鱼')
  相等('4d resolveTarget 异步路径 how = onboard', 目标 && 目标.how, 'onboard')
}

// ---------- ② sendQQ 三种返回 ----------

console.log('\n[2] sendQQ 三种返回')

{
  const ctx = 造ctx({})
  const 结果 = await 通道.sendQQ(ctx, '大肥鱼', '在吗')
  相等('2a aurabot 不在 → no-aurabot', 结果 && 结果.reason, 'no-aurabot')
  验('2a 返回 ok:false', 结果 && 结果.ok === false)
}

{
  // aurabot 在，但配置里没有这张卡的号
  const { mkdirSync } = await import('node:fs')
  mkdirSync(process.env.AURABOT_DATA_DIR, { recursive: true })
  writeFileSync(join(process.env.AURABOT_DATA_DIR, 'config.json'), JSON.stringify({
    ownerQQ: 10001,
    accounts: [{ card: '薇斯纳', qq: 20002, enabled: true }],
  }), 'utf8')

  const 调用 = []
  const au = {
    info: () => ({ online: true, enabled: true }),
    send: async (args) => { 调用.push(args); return { ok: true } },
  }
  const ctx = 造ctx({ aurabot: au })
  const 结果 = await 通道.sendQQ(ctx, '大肥鱼', '在吗')
  相等('2b 没绑该卡 → no-qq', 结果 && 结果.reason, 'no-qq')
  相等('2b 不调用 send', 调用.length, 0)
}

{
  // 绑了号：收件人是**主人 ownerQQ**，不是这张卡自己的号
  const { mkdirSync } = await import('node:fs')
  mkdirSync(process.env.AURABOT_DATA_DIR, { recursive: true })
  writeFileSync(join(process.env.AURABOT_DATA_DIR, 'config.json'), JSON.stringify({
    ownerQQ: 10001,
    accounts: [{ card: '大肥鱼', qq: 20002, enabled: true }],
  }), 'utf8')

  相等('2c cardQQTarget 读到绑定号', 通道.cardQQTarget(造ctx({}), '大肥鱼'), '20002')
  相等('2c cardQQTarget 没绑 → null', 通道.cardQQTarget(造ctx({}), '薇斯纳'), null)

  const 调用 = []
  const au = {
    info: () => ({ online: true, enabled: true }),
    send: async (args) => { 调用.push(args); return { ok: true } },
  }
  const 结果 = await 通道.sendQQ(造ctx({ aurabot: au }), '大肥鱼', '在吗')
  相等('2d 发送成功 ok:true', 结果 && 结果.ok, true)
  相等('2d via = qq', 结果 && 结果.via, 'qq')
  相等('2d target = private:主人 ownerQQ', 调用[0] && 调用[0].target, 'private:10001')
  相等('2d 没退到绑定号就不写兜底备注', 结果 && 结果.message, undefined)
  相等('2d text 原样', 调用[0] && 调用[0].text, '在吗')
}

{
  // 只有绑定号、没有 ownerQQ → 退回绑定号，并在 message 里记一句
  writeFileSync(join(process.env.AURABOT_DATA_DIR, 'config.json'), JSON.stringify({
    accounts: [{ card: '大肥鱼', qq: 20002, enabled: true }],
  }), 'utf8')

  const 调用 = []
  const au = {
    info: () => ({ online: true, enabled: true }),
    send: async (args) => { 调用.push(args); return { ok: true } },
  }
  const 结果 = await 通道.sendQQ(造ctx({ aurabot: au }), '大肥鱼', '在吗')
  相等('2g 没有 ownerQQ 时退回绑定号', 调用[0] && 调用[0].target, 'private:20002')
  验('2g message 注明没拿到 ownerQQ', 结果 && String(结果.message || '').includes('没拿到 ownerQQ'), 结果 && 结果.message)
}

{
  // 服务在、send 抛错 → 折成 no-aurabot（绝不 throw）
  const au = {
    info: () => ({ online: true, enabled: true }),
    send: async () => { throw Object.assign(new Error('桥断了'), { code: 'NO_AURABOT' }) },
  }
  let 抛了 = false
  let 结果 = null
  try {
    结果 = await 通道.sendQQ(造ctx({ aurabot: au }), '大肥鱼', '在吗')
  } catch {
    抛了 = true
  }
  验('2e send 抛错也不 throw', 抛了 === false)
  相等('2e 抛错 → no-aurabot', 结果 && 结果.reason, 'no-aurabot')
}

{
  // 离线 → offline（delivery 会退回 dsh）
  const au = { info: () => ({ online: false, enabled: true }), send: async () => ({ ok: true }) }
  const 结果 = await 通道.sendQQ(造ctx({ aurabot: au }), '大肥鱼', '在吗')
  相等('2f 离线 → offline', 结果 && 结果.reason, 'offline')
}

// ---------- ③ ensureSession 先登记后建 ----------

console.log('\n[3] ensureSession：先登记、后建会话')

{
  const 序列 = []
  const settings = {
    update: async (ns, patch) => {
      序列.push('register:' + ns + ':' + Object.keys(patch.sessions)[0])
    },
  }
  const ctrl = {
    create: async (req) => {
      序列.push('create:' + req.sessionId + ':cwd=' + req.cwd)
      return { sessionId: req.sessionId }
    },
  }
  const ctx = 造ctx({
    settings,
    sessionController: ctrl,
    sessions: { get: () => ({ append: (类型) => 序列.push('sandbox:' + 类型) }) },
    workspaceRegistry: { list: () => [{ id: 'ws1', path: 'D:/假工作区', attachSession: async () => 序列.push('attach') }] },
  })

  const 结果 = await 投递.ensureSession(ctx, '大肥鱼')
  验('3a ensureSession 成功', 结果 && 结果.ok === true, JSON.stringify(结果))
  验('3a 会话 id 形如 speak-大肥鱼-<ts>', /^speak-大肥鱼-\d+$/.test(结果.sessionId), 结果.sessionId)
  相等('3a 登记走 settings', 结果.registered, 'settings')

  验('3b 第一条调用是登记', (序列[0] || '').startsWith('register:soul-md:speak-大肥鱼-'), 序列[0])
  相等('3b 第二条调用是 create（同一个 sid）', 序列[1], 'create:' + 结果.sessionId + ':cwd=D:/假工作区')
  相等('3c 最后挂工作区', 序列[序列.length - 1], 'attach')
  验('3c 登记里写的是卡名', (序列[0] || '').endsWith('speak-大肥鱼-' + 结果.sessionId.split('-').pop()) || 序列[0].includes('大肥鱼'))
}

{
  // 登记失败 → 绝不 create（否则第一句话会用 active 卡的口吻）
  const 序列 = []
  const ctx = 造ctx({
    settings: { update: async () => { 序列.push('register'); throw new Error('settings 写不进去') } },
    sessionController: { create: async () => { 序列.push('create') } },
  })
  const 结果 = await 投递.ensureSession(ctx, '大肥鱼')
  相等('3d 登记失败 → code=register-failed', 结果.code, 'register-failed')
  相等('3d 没有 create', 序列.length, 1)
  相等('3d 只试了登记', 序列[0], 'register')
}

{
  // settings 服务不在 → patch 兜底；旧映射只留最近 2 条
  const patch原文 = [
    '- id: soul-md',
    '  config:',
    '    sessions:',
    '      speak-大肥鱼-1000: 大肥鱼',
    '      speak-大肥鱼-2000: 大肥鱼',
    '      speak-大肥鱼-3000: 大肥鱼',
    '      bili-life-大肥鱼-1000: 大肥鱼',
    '      other-card-123: 薇斯纳',
    '',
  ].join('\n')
  writeFileSync(假patch, patch原文, 'utf8')

  const 序列 = []
  const ctx = 造ctx({
    sessionController: {
      create: async (req) => { 序列.push('create:' + req.sessionId) },
    },
    sessions: { get: () => null },
  })
  const 结果 = await 投递.ensureSession(ctx, '大肥鱼')
  验('3e patch 兜底成功', 结果 && 结果.ok === true, JSON.stringify(结果))
  相等('3e registered = patch', 结果.registered, 'patch')
  验('3e 先登记（patch 先被改）再 create', (结果.sessionId && 序列[0] === 'create:' + 结果.sessionId) === true)

  const 新文本 = readFileSync(假patch, 'utf8')
  // 中文 sid 会被 yamlKey 加双引号，两种写法都认
  const 写进去了 = 新文本.includes(结果.sessionId + ': 大肥鱼') || 新文本.includes(结果.sessionId + '": 大肥鱼')
  验('3f 新 sid 已写进 sessions', 写进去了, 新文本)
  验('3f 最旧的 speak-1000 被删', !新文本.includes('speak-大肥鱼-1000'))
  验('3f 最旧的 bili-life-1000 被删', !新文本.includes('bili-life-大肥鱼-1000'))
  验('3f speak-2000 / speak-3000 还在', 新文本.includes('speak-大肥鱼-2000') && 新文本.includes('speak-大肥鱼-3000'))
  验('3f 别的卡的映射没动', 新文本.includes('other-card-123: 薇斯纳'))
}

// ---------- ④ sayInSession 的消息形状与 flush 时机 ----------

console.log('\n[4] sayInSession：消息形状 / source / flush')

{
  const 序列 = []
  let 收到 = null
  const agent = {
    status: 'idle',
    session: { id: 'session-x' },
    followup: async (消息) => {
      序列.push('followup')
      收到 = 消息
    },
  }
  const ctx = 造ctx({
    sessionController: {
      resolveAgent: async (sid) => ({ agent }),
      inspect: async () => ({ events: [] }),
    },
    sessions: { flush: async () => 序列.push('flush') },
  })

  const 结果 = await 投递.sayInSession(ctx, 'session-x', '你好')
  验('4a sayInSession 成功', 结果 && 结果.ok === true, JSON.stringify(结果))
  相等('4a followup 先于 flush', 序列.join(','), 'followup,flush')
  相等('4b 消息 role = user', 收到 && 收到.role, 'user')
  相等('4b 消息正文', 收到 && 收到.content[0] && 收到.content[0].text, '你好')
  相等('4c source.kind', 收到 && 收到.source && 收到.source.kind, 'speak-up')
  相等('4c source.plugin（防记忆污染）', 收到 && 收到.source && 收到.source.plugin, 'dsh-speak-up')
  验('4b 消息 id 非空', Boolean(收到 && 收到.id))
}

{
  // resolveAgent 返回错误码 → 原样记账，不 followup
  const ctx = 造ctx({
    sessionController: {
      resolveAgent: async () => ({ error: Object.assign(new Error('会话不存在'), { code: 'SESSION_NOT_FOUND' }) }),
    },
  })
  const 结果 = await 投递.sayInSession(ctx, 'session-none', '你好')
  相等('4d code = no-agent', 结果.code, 'no-agent')
  验('4d 错误码原样保留', String(结果.error).includes('SESSION_NOT_FOUND'), 结果.error)
}

// ---------- ⑤ 演练只造念头 ----------

console.log('\n[5] deliverToCard 演练')

{
  const ctx = 造ctx({})
  const 结果 = await 投递.deliverToCard(ctx, '大肥鱼', '演练')
  相等('5a 演练 ok', 结果.ok, true)
  相等('5a how = dry-run', 结果.how, 'dry-run')
  验('5b 念头里有「你自己心里冒出来的念头」', String(结果.text).includes('你自己心里冒出来的念头'))
  验('5b 念头里有现在这行', String(结果.text).includes('现在这会儿是'))
}

// ---------- ⑥ deliverTextToCard：指定正文（闹钟 / speak_send） ----------

console.log('\n[6] deliverTextToCard：指定正文不套 frameThought')

{
  // 准备：卡策略走 config.js（A1 已落地），写一张 dsh 通道的卡
  const { mkdirSync } = await import('node:fs')
  const 配置目录 = join(家, 'speak-up')
  mkdirSync(配置目录, { recursive: true })
  writeFileSync(join(配置目录, 'card.大肥鱼.json'), JSON.stringify({ channel: 'dsh' }), 'utf8')
  writeFileSync(join(process.env.AURABOT_DATA_DIR, 'config.json'), JSON.stringify({
    ownerQQ: 10001,
    accounts: [{ card: '大肥鱼', qq: 20002, enabled: true }],
  }), 'utf8')

  const 序列 = []
  let 收到 = null
  const agent = {
    status: 'idle',
    session: { id: 'session-a' },
    followup: async (消息) => { 序列.push('followup'); 收到 = 消息 },
  }
  const ctx = 造ctx({
    memoryCore: { cardOf: () => '大肥鱼' },
    sessionController: {
      list: () => ({ items: [{ sessionId: 'session-a' }] }),
      resolveAgent: async () => ({ agent }),
    },
    sessions: { flush: async () => 序列.push('flush') },
  })

  const 正文 = '【你自己定的闹钟｜7:00】该起床了'
  const 结果 = await 投递.deliverTextToCard(ctx, '大肥鱼', 正文, '闹钟')
  验('6a 指定正文投递成功', 结果 && 结果.ok === true, JSON.stringify(结果))
  相等('6a how = dsh（通道 dsh 不转发）', 结果.how, 'dsh')
  相等('6a mode 记账 = 闹钟', 结果.mode, '闹钟')
  相等('6a 复用已有会话', 结果.sessionId, 'session-a')
  相等('6b 正文原样进会话（不套 frameThought）', 收到 && 收到.content[0] && 收到.content[0].text, 正文)
  验('6b 正文里没有「你自己心里冒出来的念头」', !String(收到.content[0].text).includes('你自己心里冒出来的念头'))
  相等('6b source 仍是 speak-up（防记忆污染）', 收到 && 收到.source && 收到.source.kind, 'speak-up')
}

{
  // 通道 qq：投递后等到回复 → 转发给主人
  const 配置目录 = join(家, 'speak-up')
  writeFileSync(join(配置目录, 'card.大肥鱼.json'), JSON.stringify({ channel: 'qq' }), 'utf8')

  const 发出去 = []
  const au = {
    info: () => ({ online: true, enabled: true }),
    send: async (args) => { 发出去.push(args); return { ok: true } },
  }
  const 收到的话 = []
  const agent = {
    status: 'idle',
    session: { id: 'session-a' },
    followup: async (消息) => 收到的话.push(消息.content[0].text),
  }
  const ctx = 造ctx({
    aurabot: au,
    memoryCore: { cardOf: () => '大肥鱼' },
    sessionController: {
      list: () => ({ items: [{ sessionId: 'session-a' }] }),
      resolveAgent: async () => ({ agent }),
      // 第一轮 inspect 就给一条「之后」的 assistant 正文，避免等 15s
      inspect: async () => ({
        events: [{ type: 'assistant/message', time: Date.now() + 5000, data: { message: { content: [{ type: 'text', text: '起床啦，别赖床' }] } } }],
      }),
    },
    sessions: { flush: async () => {} },
  })

  const 结果 = await 投递.deliverTextToCard(ctx, '大肥鱼', '【你自己定的闹钟｜7:00】该起床了', '闹钟')
  验('6c qq 通道投递成功', 结果 && 结果.ok === true, JSON.stringify(结果))
  相等('6c how = qq', 结果.how, 'qq')
  相等('6c QQ 收件人 = 主人 ownerQQ', 发出去[0] && 发出去[0].target, 'private:10001')
  相等('6c 转发的是她的回复正文', 发出去[0] && 发出去[0].text, '起床啦，别赖床')
  相等('6d 她收到的是指定正文', 收到的话[0], '【你自己定的闹钟｜7:00】该起床了')
}

{
  // 空正文 / 空卡名：不碰会话直接返回
  const ctx = 造ctx({})
  相等('6e 空正文 → empty-text', (await 投递.deliverTextToCard(ctx, '大肥鱼', '   ')).code, 'empty-text')
  相等('6e 空卡名 → no-card', (await 投递.deliverTextToCard(ctx, '', '喂')).code, 'no-card')
}

// ---------- 收尾 ----------

console.log(`\n通过 ${通过}，失败 ${失败.length}`)
if (失败.length > 0) {
  console.log('失败项：')
  for (const 项 of 失败) console.log(' - ' + 项)
  process.exitCode = 1
}
try {
  rmSync(家, { recursive: true, force: true })
} catch {
  // 临时目录清不掉不影响结论
}
