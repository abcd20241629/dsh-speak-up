// 卡名解析 —— 「现在有哪些人格卡」「这个会话属于哪张卡」「这张卡开荒完了没」。
//
// 三级回退（从最可信到最兜底）：
//   ① ctx.get('memoryCore') 服务 —— 它自己已经合并了 settings 和记忆库目录
//   ② ctx.get('settings') 的 soul-md 命名空间（和设置界面同源）
//   ③ 直接解析 $DSH_HOME/profiles/*/cordis.patch.yml 里 `- id: soul-md` 那段
//
// ⚠ 只读别人的公开服务 / 配置文件，不 import dsh-memory-core、dsh-card-workspace 的内部模块。

import { readFileSync, readdirSync, existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

const NS = 'soul-md'

function dshHome() {
  return process.env.DSH_HOME || join(homedir(), '.dsh')
}

function service(ctx, name) {
  try {
    return typeof ctx?.get === 'function' ? ctx.get(name) : null
  } catch (error) {
    return null
  }
}

function cleanCard(v) {
  const s = String(v == null ? '' : v).trim()
  return s && s !== 'none' && s !== 'null' ? s : ''
}

export function stripSessionPrefix(id) {
  const s = String(id == null ? '' : id).trim()
  return s.startsWith('session-') ? s.slice('session-'.length) : s
}

// ---------- ① memoryCore ----------

function cardsFromMemoryCore(ctx) {
  const mc = service(ctx, 'memoryCore')
  if (!mc || typeof mc.listCards !== 'function') return null
  try {
    const list = mc.listCards()
    if (!Array.isArray(list)) return null
    return list.map(cleanCard).filter(Boolean)
  } catch (error) {
    return null
  }
}

// ---------- ② settings ----------

function fromSettings(ctx) {
  const settings = service(ctx, 'settings')
  if (!settings || typeof settings.describe !== 'function') return null
  try {
    const raw = settings.describe()
    const list = Array.isArray(raw) ? raw : (raw && Array.isArray(raw.entries) ? raw.entries : [])
    const row = list.find((x) => x && x.ns === NS)
    const v = row && row.value
    if (!v || typeof v !== 'object') return null
    const cards = v.cards && typeof v.cards === 'object' ? Object.keys(v.cards) : []
    const sessions = v.sessions && typeof v.sessions === 'object' ? v.sessions : {}
    const active = typeof v.active === 'string' ? v.active : ''
    return { cards, sessions, active, source: 'settings' }
  } catch (error) {
    return null
  }
}

// ---------- ③ cordis.patch.yml ----------

/**
 * 解析 `- id: soul-md` 那一块。
 * 真实文件缩进：entry 0 / name·config 2 / cards·sessions·active 4 / 键 6 / 内容 8。
 * 用「相对缩进」判断，别写死 6 空格 —— 换了排版也能读。
 */
export function parseSoulBlock(text) {
  const lines = String(text || '').split(/\r?\n/)
  let start = -1
  let base = 0
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(/^(\s*)- id:\s*soul-md\s*$/)
    if (m) {
      start = i
      base = m[1].length
      break
    }
  }
  if (start < 0) return null

  let active = ''
  let mode = ''
  let modeIndent = -1
  const sessions = {}
  const cards = []

  for (let i = start + 1; i < lines.length; i++) {
    const line = lines[i]
    if (!line.trim()) continue
    const indent = (line.match(/^\s*/) || [''])[0].length
    // 下一个插件条目 → 本块结束
    if (indent <= base && /^\s*- id:/.test(line)) break

    const kv = line.match(/^\s*([A-Za-z][\w-]*):\s*(.*)$/)
    if (kv && indent <= base + 4) {
      const key = kv[1]
      if (key === 'active') {
        active = kv[2].trim().replace(/^["']|["']$/g, '')
        mode = ''
        continue
      }
      if (key === 'sessions' || key === 'cards' || key === 'workspaces') {
        mode = key
        modeIndent = indent
        continue
      }
    }

    if (!mode) continue
    if (indent <= modeIndent) {
      mode = ''
      continue
    }

    if (mode === 'sessions') {
      const m = line.match(/^\s*([^:]+):\s*(.*)$/)
      if (m) sessions[m[1].trim()] = m[2].trim().replace(/^["']|["']$/g, '')
    } else if (mode === 'cards') {
      // 卡名只认紧贴 cards: 下一层（+2 空格）；卡正文在更深一层，不会被误当卡名
      if (indent === modeIndent + 2) {
        const m = line.match(/^\s*(\S.*?):\s*(\|.*)?$/)
        if (m) cards.push(m[1].trim())
      }
    }
  }
  return { active, sessions, cards }
}

function fromYaml() {
  const out = { active: '', sessions: {}, cards: [], source: 'yaml' }
  const dir = join(dshHome(), 'profiles')
  try {
    for (const p of readdirSync(dir)) {
      const file = join(dir, p, 'cordis.patch.yml')
      if (!existsSync(file)) continue
      let block = null
      try {
        block = parseSoulBlock(readFileSync(file, 'utf8'))
      } catch (error) {
        continue
      }
      if (!block) continue
      if (!out.active && block.active) out.active = block.active
      Object.assign(out.sessions, block.sessions)
      for (const c of block.cards) if (!out.cards.includes(c)) out.cards.push(c)
    }
  } catch (error) {
    /* 没有 profiles 目录就算了 */
  }
  return out
}

/** settings 优先，没有就 yaml。返回 {cards, sessions, active, source}。 */
function readCardConfig(ctx) {
  return fromSettings(ctx) || fromYaml()
}

// ---------- 对外 ----------

/**
 * 现在有哪些卡。三级来源取并集、去重、去掉 none。
 * 顺序：memoryCore 先，settings / yaml 补漏。
 */
export function listCards(ctx) {
  const out = []
  const seen = new Set()
  const add = (name) => {
    const c = cleanCard(name)
    if (!c || seen.has(c)) return
    seen.add(c)
    out.push(c)
  }
  const fromMc = cardsFromMemoryCore(ctx)
  if (fromMc) for (const c of fromMc) add(c)
  const settings = fromSettings(ctx)
  if (settings) for (const c of settings.cards) add(c)
  const yaml = fromYaml()
  for (const c of yaml.cards) add(c)
  return out
}

/** 这个会话属于哪张卡。memoryCore → settings.sessions → active。归不到回 ''。 */
export function cardOf(ctx, sid) {
  const id = String(sid == null ? '' : sid).trim()
  if (!id) return ''
  const key = stripSessionPrefix(id)

  const mc = service(ctx, 'memoryCore')
  if (mc && typeof mc.cardOf === 'function') {
    try {
      const c = cleanCard(mc.cardOf(id))
      if (c) return c
    } catch (error) {
      /* 服务抽风：继续往下退 */
    }
  }

  const cfg = readCardConfig(ctx)
  if (!cfg) return ''
  for (const [k, v] of Object.entries(cfg.sessions || {})) {
    if (stripSessionPrefix(k) !== key) continue
    const c = String(v == null ? '' : v).trim()
    // 显式写了 none：这个会话就是「没有卡」，不许再退到 active
    return c === 'none' || c === 'null' ? '' : c
  }
  return cleanCard(cfg.active)
}

/** 这张卡的开荒状态（memoryCore.setupOf）；没有服务 / 没有记录 → null。 */
export function setupOf(ctx, card) {
  const mc = service(ctx, 'memoryCore')
  if (!mc || typeof mc.setupOf !== 'function') return null
  try {
    const s = mc.setupOf(String(card == null ? '' : card))
    return s && typeof s === 'object' ? s : null
  } catch (error) {
    return null
  }
}

/** 诊断用：当前三级来源各自看到了什么。 */
export function cardSources(ctx) {
  return {
    memoryCore: cardsFromMemoryCore(ctx),
    settings: fromSettings(ctx),
    yaml: fromYaml(),
  }
}
