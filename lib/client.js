// DSH「主动搭话」· 网页半边（0.3.0：按人格卡调度）
//
// 只干一件事：在 **DSH 设置** 左侧栏加一项「主动搭话」，
// 顶部一个「卡片」下拉（默认「全部」），下面按卡摆设置、闹钟、日志，外加两个安全的试法（演练 / 真发一次）。
//
// ⚠ 这里**不碰会话、不发消息**，只是往宿主那几条 /dsh-speak-up/* 路由上读写。
//   真正的掷骰、唤醒、投递都在宿主半边（lib/host.js + scheduler/delivery），这样只有一份逻辑。
//
// ⚠ 契约：CONTRACT.md §4 的路由是唯一接口。本文件只读这些字段：
//   GET  /cards   → {ok, cards:[{card,enabled,channel,sessionId,nextRollAt,lastSpokeAt,rollsToday,misses,alarms:[{id,at,text,repeat}]}]}
//   GET  /config  → {ok, global, card, policy}
//   POST /config  → {card?, patch}           卡片级字段带 card，全局字段不带 card
//   GET  /log     → {ok, items:[{t,text,card}]}
//   POST /roll    → {card, mode:'演练'|'真发'} → {ok, hit, detail}
//   GET  /alarms  → {ok, items:[...]}        （本文件用 /cards 里的 alarms 列表，POST 才走 /alarms）
//   POST /alarms  → {action:'create'|'cancel', card, ...}
//   GET  /status  → {ok, version, timer, cards}
//
// ⚠ 0.2.9 的 /state、/save、/new-session 在 0.3.0 已经没有了，这里一个都不再引用；
//   /update、/install 是 0.2.9 的可选路由（版本检查），缺失时只显示一行灰字，不影响别的功能。
//
// ⚠ 槽位名 'settings.section' 跟 dsh-write / dsh-fish-memory 用的是同一个，
//   是在这个环境里已经跑通的路子（不确定换 DSH 版本会不会变，见 README）。

window.__ModuleLoader__.load({
  id: 'dsh-speak-up',
  factory: (require) => {
    var module = { exports: {} }
    var exports = module.exports

    const React = require('react')
    const inject = ['slots']

    const B = '/dsh-speak-up'

    // ---------- 请求 ----------
    //
    // ⚠ 0.2.9 的写法是 .catch(() => null)：请求挂了、路由不存在、返回不是 JSON，
    //   全都静默变成 null，界面上什么也看不出来。0.3.0 改成**一律带原因返回**，
    //   由调用方决定是弹顶部通报还是写在原地 —— 但绝不吞掉。
    const 请求 = async (方法, 路径, 体) => {
      let r
      try {
        r = await fetch(B + 路径, {
          method: 方法,
          cache: 'no-store',
          headers: 体 === undefined ? undefined : { 'content-type': 'application/json' },
          body: 体 === undefined ? undefined : JSON.stringify(体),
        })
      } catch (e) {
        return { ok: false, error: '发不出请求：' + ((e && e.message) || String(e)) }
      }
      let j = null
      try {
        j = await r.json()
      } catch (e) {
        j = null
      }
      if (!j || typeof j !== 'object') {
        return {
          ok: false,
          error: 'HTTP ' + r.status + '：' + 方法 + ' ' + B + 路径 + ' 没返回 JSON —— 这条路由实现了吗？',
        }
      }
      if (j.ok === false && !j.error) j.error = '宿主那边失败了（没给原因）'
      return j
    }
    const get = (p) => 请求('GET', p)
    const post = (p, b) => 请求('POST', p, b || {})

    const h = React.createElement

    // 表格列宽：卡名 / 开关 / 通道 / 下次掷骰 / 今日 / 闹钟 / 最近开口 / 会话 / 按钮
    const 列 = 'minmax(96px,1.3fr) 48px 56px minmax(120px,1fr) minmax(92px,.9fr) 56px minmax(96px,.9fr) minmax(88px,.8fr) 62px'

    // 样式贴着主题变量走，换皮肤/换深浅色都跟着变（照 dsh-write 的做法）
    const S = {
      wrap: {
        padding: '12px 14px 24px',
        fontSize: 13,
        lineHeight: 1.7,
        background: 'var(--dsw-alias-bg-layer-1, rgba(255,255,255,.92))',
        border: '1px solid var(--dsw-alias-border-l1, rgba(0,0,0,.08))',
        borderRadius: 12,
      },
      h: { fontSize: 14, fontWeight: 600, margin: '16px 0 8px' },
      dim: { opacity: 0.62, fontSize: 12 },
      card: {
        border: '1px solid var(--dsw-alias-border-l2)',
        borderRadius: 8,
        padding: '10px 12px',
        marginBottom: 10,
        background: 'var(--dsw-alias-bg-layer-1)',
      },
      row: { display: 'flex', gap: 10, alignItems: 'flex-start', marginBottom: 8, flexWrap: 'wrap' },
      lab: { minWidth: 190, paddingTop: 3, fontSize: 12.5 },
      ctl: { flex: '1 1 260px', minWidth: 220 },
      hint: { opacity: 0.6, fontSize: 11.5, marginTop: 2 },
      input: {
        border: '1px solid var(--dsw-alias-border-l2)',
        borderRadius: 6,
        padding: '4px 8px',
        background: 'transparent',
        color: 'inherit',
        fontSize: 12.5,
        width: '100%',
        boxSizing: 'border-box',
      },
      small: {
        border: '1px solid var(--dsw-alias-border-l2)',
        borderRadius: 6,
        padding: '4px 8px',
        background: 'transparent',
        color: 'inherit',
        fontSize: 12.5,
        width: 110,
        boxSizing: 'border-box',
      },
      ta: {
        border: '1px solid var(--dsw-alias-border-l2)',
        borderRadius: 6,
        padding: '8px 10px',
        background: 'transparent',
        color: 'inherit',
        fontSize: 12.5,
        width: '100%',
        boxSizing: 'border-box',
        lineHeight: 1.7,
        fontFamily: 'inherit',
        minHeight: 56,
      },
      btn: {
        border: '1px solid var(--dsw-alias-border-l2)',
        borderRadius: 6,
        padding: '5px 12px',
        background: 'transparent',
        color: 'inherit',
        cursor: 'pointer',
        fontSize: 12.5,
      },
      btnOn: {
        border: '1px solid var(--dsw-alias-state-business-primary)',
        borderRadius: 6,
        padding: '5px 12px',
        background: 'var(--dsw-alias-state-business-primary)',
        color: '#fff',
        cursor: 'pointer',
        fontSize: 12.5,
      },
      warn: {
        border: '1px solid #c0392b',
        borderRadius: 8,
        padding: '8px 10px',
        marginBottom: 10,
        fontSize: 12,
        lineHeight: 1.7,
        color: '#c0392b',
      },
      ok: { color: 'var(--dsw-alias-state-business-primary)', fontSize: 12 },
      已同步: {
        margin: '6px 0 10px',
        fontSize: 12,
        color: 'var(--dsw-alias-state-business-primary)',
      },
      未保存: {
        margin: '6px 0 10px',
        fontSize: 12,
        color: '#c0392b',
        fontWeight: 600,
      },
      /**
       * 悬浮的保存条（只在「有改动还没保存」时渲染）。
       * ⚠ sticky 而不是 fixed：它属于这张设置页，滚动到哪都贴在**这一页**的底部；
       *   页面上没有改动时它压根不渲染，所以平时不占地方、不挡内容。
       */
      悬浮保存条: {
        position: 'sticky',
        bottom: 0,
        marginTop: 12,
        display: 'flex',
        alignItems: 'center',
        gap: 12,
        flexWrap: 'wrap',
        padding: '8px 12px',
        borderRadius: 10,
        border: '1px solid var(--dsw-alias-border-l2)',
        background: 'var(--dsw-alias-bg-layer-1, rgba(255,255,255,.95))',
        boxShadow: '0 -6px 18px rgba(0,0,0,.18)',
        zIndex: 5,
      },
      已勾: {
        border: '1px solid var(--dsw-alias-border-l2)',
        borderRadius: 6,
        padding: '5px 8px',
        fontSize: 12,
        lineHeight: 1.6,
      },
      tag: {
        display: 'inline-block',
        border: '1px solid var(--dsw-alias-border-l2)',
        borderRadius: 4,
        padding: '0 6px',
        fontSize: 11,
        marginRight: 6,
        opacity: 0.9,
        whiteSpace: 'nowrap',
      },
      日志行: { fontFamily: 'ui-monospace, Consolas, monospace', fontSize: 11.5, whiteSpace: 'pre-wrap' },

      // —— 0.3.0 新增：顶部工具条 / 卡表 / 通报条 ——
      顶: { display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap', marginBottom: 8 },
      选择: {
        border: '1px solid var(--dsw-alias-border-l2)',
        borderRadius: 6,
        padding: '4px 8px',
        background: 'transparent',
        color: 'inherit',
        fontSize: 12.5,
        minWidth: 130,
        maxWidth: 260,
      },
      表: {
        border: '1px solid var(--dsw-alias-border-l2)',
        borderRadius: 8,
        overflowX: 'auto',
        marginTop: 4,
      },
      表头: {
        display: 'grid',
        gridTemplateColumns: 列,
        gap: 8,
        padding: '6px 10px',
        fontSize: 11.5,
        opacity: 0.62,
        borderBottom: '1px solid var(--dsw-alias-border-l2)',
        minWidth: 800,
        whiteSpace: 'nowrap',
      },
      表行: {
        display: 'grid',
        gridTemplateColumns: 列,
        gap: 8,
        padding: '7px 10px',
        borderBottom: '1px solid var(--dsw-alias-border-l1, rgba(0,0,0,.06))',
        minWidth: 800,
        alignItems: 'center',
      },
      表行亮: { background: 'var(--dsw-alias-interactive-bg-hover, rgba(0,0,0,.04))' },
      格: { fontSize: 12.5, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' },
      通报好: {
        margin: '0 0 10px',
        padding: '7px 10px',
        borderRadius: 8,
        border: '1px solid var(--dsw-alias-state-business-primary)',
        color: 'var(--dsw-alias-state-business-primary)',
        fontSize: 12,
        lineHeight: 1.7,
        whiteSpace: 'pre-wrap',
      },
      通报坏: {
        margin: '0 0 10px',
        padding: '7px 10px',
        borderRadius: 8,
        border: '1px solid #c0392b',
        color: '#c0392b',
        fontSize: 12,
        lineHeight: 1.7,
        whiteSpace: 'pre-wrap',
      },
      通报等: {
        margin: '0 0 10px',
        padding: '7px 10px',
        borderRadius: 8,
        border: '1px solid var(--dsw-alias-border-l2)',
        opacity: 0.75,
        fontSize: 12,
        lineHeight: 1.7,
        whiteSpace: 'pre-wrap',
      },
    }

    // ---------- 小控件 ----------

    const 提示 = (文本) => h('div', { style: S.hint }, 文本)
    const 行 = (标签, 控件, 说明) =>
      h(
        'div',
        { style: S.row },
        h('div', { style: S.lab }, 标签),
        h('div', { style: S.ctl }, 控件, 说明 ? 提示(说明) : null),
      )
    const 按钮 = (文字, onClick, 亮, 关) =>
      h(
        'button',
        { type: 'button', style: 亮 ? S.btnOn : S.btn, onClick, disabled: !!关, title: 文字 },
        文字,
      )
    const 勾 = (值, onChange) =>
      h('input', { type: 'checkbox', checked: !!值, onChange: (e) => onChange(e.target.checked) })
    const 数 = (值, onChange, 步) =>
      h('input', {
        type: 'number',
        value: 值 === undefined || 值 === null ? '' : 值,
        step: 步 || 1,
        style: S.small,
        onChange: (e) => onChange(e.target.value),
      })

    /** 会话 id 的后 8 位 —— 前面那截（session- 和 uuid 开头）全都一样，只有尾巴分得出谁是谁。 */
    const 短id = (id) => {
      const s = String(id)
      return s.length <= 8 ? s : s.slice(-8)
    }

    // ---------- 时间 / 字段小工具 ----------
    //
    // ⚠ CONTRACT §2.3 里 nextRollAt / lastSpokeAt / alarms[].at 写的是**毫秒数**，
    //   但计划书 §3.4 写的是 ISO 字符串。宿主最后用哪种我这边不知道，
    //   所以这里两种都吃：数字当毫秒，字符串走 Date.parse（失败算 0 = 没值）。
    const 解析时刻 = (v) => {
      if (v === undefined || v === null || v === '') return 0
      if (typeof v === 'number') return Number.isFinite(v) && v > 0 ? v : 0
      const n = Date.parse(String(v))
      return Number.isFinite(n) && n > 0 ? n : 0
    }
    const 两位 = (n) => (n < 10 ? '0' + n : String(n))
    const 钟点 = (v) => {
      const t = 解析时刻(v)
      if (!t) return '—'
      const d = new Date(t)
      return 两位(d.getMonth() + 1) + '-' + 两位(d.getDate()) + ' ' + 两位(d.getHours()) + ':' + 两位(d.getMinutes())
    }
    /** 一段时长 → 「1 小时 20 分」。 */
    const 时长 = (毫秒) => {
      const m = Math.round(Math.abs(毫秒) / 60000)
      if (m < 1) return '不到 1 分钟'
      if (m < 60) return m + ' 分钟'
      const 时 = Math.floor(m / 60)
      const 分 = m % 60
      return 时 + ' 小时' + (分 ? ' ' + 分 + ' 分' : '')
    }
    /** 下次掷骰：「还有 X 分钟」/「—」/「已到点」。 */
    const 下次话 = (v, 现在) => {
      const t = 解析时刻(v)
      if (!t) return '—'
      const 差 = t - 现在
      if (差 <= 0) return '已到点（等下一轮）'
      return '还有 ' + 时长(差)
    }
    /** 上次开口：「X 分钟前」/「—」。 */
    const 前次话 = (v, 现在) => {
      const t = 解析时刻(v)
      if (!t) return '—'
      const 差 = 现在 - t
      return 差 < 60000 ? '刚刚' : 时长(差) + '前'
    }
    const 通道名 = (v) => (v === 'qq' ? 'QQ' : v === 'dsh' ? 'DSH' : '自动')
    const 重复名 = (a) => {
      const r = a && a.repeat
      if (r === 'daily') return '每天'
      if (r === 'interval') return '每 ' + Number(a.intervalMinutes || 0) + ' 分'
      if (r === 'weekly') return '每周'
      return '一次'
    }

    /** 徽标：开关 / 通道 这类短状态。坏状态用红字（不新造颜色，复用 #c0392b）。 */
    const 徽 = (文, 坏) =>
      h(
        'span',
        { style: 坏 ? { ...S.tag, color: '#c0392b', borderColor: '#c0392b' } : S.tag },
        文,
      )

    // ---------- 设置页 ----------

    function Section() {
      // 读回来的东西
      const [状, 设状] = React.useState(null) // GET /status
      const [卡表, 设卡表] = React.useState([]) // GET /cards 的 cards
      const [卡, 设卡] = React.useState('') // '' = 全部
      const [配置, 设配置] = React.useState(null) // GET /config 的 {global, policy}
      const [日志, 设日志] = React.useState([]) // GET /log 的 items
      // 编辑草稿：只装当前视图要改的那几格；服务端那份单独留着做对照
      const [草稿, 设草稿] = React.useState(null) // {global:{}, policy:{}}
      const [改过, 设改过] = React.useState({ global: {}, policy: {} }) // 哪些键被改过（只存这些）
      // 通报与忙闲
      const [说, 设说] = React.useState('')
      const [说类, 设说类] = React.useState('ok') // ok | bad | wait
      const [忙, 设忙] = React.useState(false)
      const [读到, 设读到] = React.useState('')
      const [读错, 设读错] = React.useState('') // /cards 或 /config 读不到（致命，页面级红框）
      const [日志错, 设日志错] = React.useState('') // /log 读不到（写在日志卡里）
      // 掷骰结果（留在动作卡里，不会因为一次新通报就被刷掉）
      const [掷果, 设掷果] = React.useState(null) // {模式, 中, 详情, 时间}
      // 闹钟草稿
      const [新钟, 设新钟] = React.useState({ 时间: '', 分钟后: '', 文案: '', 重复: 'none', 间隔: '' })
      const [钟忙, 设钟忙] = React.useState(false)
      // 版本检查（0.2.9 的可选路由，这一版没提供也能用）
      const [更新, 设更新] = React.useState(null)
      const [更新忙, 设更新忙] = React.useState(false)

      // 每 20 秒重新算一次「还有几分钟」，不用重新拉接口
      const [现在, 设现在] = React.useState(Date.now())
      React.useEffect(() => {
        const t = setInterval(() => 设现在(Date.now()), 20000)
        return () => clearInterval(t)
      }, [])

      const 报 = (文本, 类) => {
        设说(文本 || '')
        设说类(类 || 'ok')
      }

      const 拉状态 = React.useCallback(async () => {
        const r = await get('/status')
        if (r && r.ok) 设状(r)
      }, [])

      const 拉卡 = React.useCallback(async () => {
        const r = await get('/cards')
        if (r && r.ok) {
          设卡表(Array.isArray(r.cards) ? r.cards : [])
          设读错('')
        } else {
          设读错('读不到卡片列表（GET /cards）：' + ((r && r.error) || '宿主没回话'))
        }
        return r
      }, [])

      const 拉配置 = React.useCallback(async (c) => {
        const r = await get('/config' + (c ? '?card=' + encodeURIComponent(c) : ''))
        if (r && r.ok) {
          设配置({ global: r.global || {}, policy: r.policy || {} })
          设草稿({ global: { ...(r.global || {}) }, policy: { ...(r.policy || {}) } })
          设改过({ global: {}, policy: {} })
          设读错('')
        } else {
          设读错('读不到配置（GET /config' + (c ? '?card=' + c : '') + '）：' + ((r && r.error) || '宿主没回话'))
        }
        return r
      }, [])

      const 拉日志 = React.useCallback(async (c) => {
        const q = '?limit=100' + (c ? '&card=' + encodeURIComponent(c) : '')
        const r = await get('/log' + q)
        if (r && r.ok) {
          设日志(Array.isArray(r.items) ? r.items : [])
          设日志错('')
        } else {
          设日志([])
          设日志错('读不到日志（GET /log' + (c ? '?card=' + c : '') + '）：' + ((r && r.error) || '宿主没回话'))
        }
        return r
      }, [])

      const 拉卡表 = 拉卡
      const 刷新 = React.useCallback(
        async (c) => {
          设忙(true)
          await Promise.all([拉状态(), 拉卡表(), 拉配置(c || ''), 拉日志(c || '')])
          设读到(new Date().toLocaleTimeString())
          设忙(false)
        },
        [拉状态, 拉卡表, 拉配置, 拉日志],
      )

      // 卡一变就整页重读（「全部」也要读全局配置和全量日志）
      React.useEffect(() => {
        刷新(卡)
      }, [卡, 刷新])

      // ---------- 脏 / 改值 ----------

      const 有改 = (域) => Object.keys((改过 && 改过[域]) || {}).length > 0
      const 脏 = 有改('policy') || 有改('global')

      /** 域 = 'policy'（这张卡）| 'global'（全局默认） */
      const 改 = (域, k, v) => {
        设草稿((旧) => (旧 ? { ...旧, [域]: { ...旧[域], [k]: v } } : 旧))
        设改过((旧) => ({ ...旧, [域]: { ...旧[域], [k]: true } }))
      }
      const 改卡 = (k, v) => 改('policy', k, v)
      const 改全 = (k, v) => 改('global', k, v)
      const 卡值 = (k) => (草稿 && 草稿.policy ? 草稿.policy[k] : '')
      const 全值 = (k) => (草稿 && 草稿.global ? 草稿.global[k] : '')

      /** 切卡：有没保存的改动先问一句，别默默丢掉。 */
      const 切卡 = (下一个) => {
        if (下一个 === 卡) return
        if (脏 && !window.confirm('有改动还没保存，切走就丢了。要继续吗？')) return
        设卡(下一个)
      }

      // ---------- 存 ----------
      //
      // 契约 §2.1 / §2.2：卡片级字段（带 card 发）与全局字段（不带 card 发）是两处落盘，
      // 所以按字段名分成两个补丁、必要时发两次 POST /config。
      const 数字键 = {
        intervalMinutes: 1, cooldownMinutes: 1, missBonus: 1, bonusCap: 1,
        quietStart: 1, quietEnd: 1, nearMinutes: 1, nearFactor: 1,
        farMinutes: 1, farFactor: 1, peakThreshold: 1, offThreshold: 1, dailyCap: 1,
      }
      const 布尔键 = { enabled: 1, dryRun: 1, deliverText: 1 }

      const 组补丁 = (域) => {
        const 源 = (草稿 && 草稿[域]) || {}
        const 改键 = (改过 && 改过[域]) || {}
        const 补 = {}
        const 空 = []
        Object.keys(改键).forEach((k) => {
          const v = 源[k]
          if (数字键[k]) {
            if (v === '' || v === null || v === undefined) {
              空.push(k)
              return
            }
            const n = Number(v)
            if (!Number.isFinite(n)) {
              空.push(k)
              return
            }
            补[k] = n
          } else if (布尔键[k]) {
            补[k] = !!v
          } else {
            补[k] = v === undefined || v === null ? '' : String(v).trim()
          }
        })
        return { 补, 空 }
      }

      const 存 = async () => {
        if (忙) return
        if (!草稿) return
        const 卡侧 = 组补丁('policy')
        const 全侧 = 组补丁('global')
        // 「全部」视图下没有具体卡：那里露出来的都是全局默认
        const 有卡 = 卡 !== ''
        const 卡补 = 有卡 ? 卡侧.补 : {}
        const 全补 = 全侧.补
        const 空 = (有卡 ? 卡侧.空 : []).concat(全侧.空)
        if (!Object.keys(卡补).length && !Object.keys(全补).length) {
          报(空.length ? '这些格子是空的，没法存：' + 空.join('、') : '没有改过的项，不用存', 'bad')
          return
        }
        设忙(true)
        报('保存中…', 'wait')
        const 结果 = []
        if (Object.keys(卡补).length) {
          const r = await post('/config', { card: 卡, patch: 卡补 })
          结果.push({ 名: '《' + 卡 + '》的策略', r })
        }
        if (Object.keys(全补).length) {
          const r = await post('/config', { patch: 全补 })
          结果.push({ 名: '全局默认', r })
        }
        const 坏 = 结果.filter((x) => !x.r || x.r.ok === false)
        if (坏.length) {
          报(
            '保存失败：' +
              坏.map((x) => x.名 + ' → ' + ((x.r && x.r.error) || '宿主没回话')).join('；') +
              (坏.length < 结果.length ? '（另一半存上了）' : ''),
            'bad',
          )
        } else {
          设改过({ global: {}, policy: {} })
          报(
            '已保存 ✓ ' + 结果.map((x) => x.名).join('、') +
              (空.length ? '（空的格子没存：' + 空.join('、') + '）' : ''),
            'ok',
          )
          await 拉配置(卡)
          await 拉卡表()
        }
        设忙(false)
      }

      // ---------- 演练 / 真发 ----------

      const 掷 = async (模式) => {
        if (!卡) {
          报('先在最上面的「卡片」里选一张卡，「' + 模式 + '」是按卡执行的', 'bad')
          return
        }
        if (忙) return
        设忙(true)
        报(模式 + '中…', 'wait')
        const r = await post('/roll', { card: 卡, mode: 模式 })
        if (!r || r.ok === false) {
          const 因 = (r && (r.error || r.detail)) || '宿主没回话'
          报(模式 + '失败：' + 因, 'bad')
          设掷果({ 模式, 中: false, 详情: 因, 失败: true, 时间: Date.now() })
        } else {
          const 中 = !!r.hit
          设掷果({ 模式, 中, 详情: r.detail ? String(r.detail) : '', 失败: false, 时间: Date.now() })
          报(模式 + '：' + (中 ? '掷中了 ✓' : '没掷中') + (r.detail ? ' —— ' + r.detail : ''), 中 ? 'ok' : 'ok')
          await 拉卡表()
          await 拉日志(卡)
        }
        设忙(false)
      }

      // ---------- 闹钟 ----------

      const 新钟建 = async () => {
        if (钟忙) return
        if (!卡) {
          报('闹钟要挂在某一张卡上 —— 先选一张卡', 'bad')
          return
        }
        if (!String(新钟.文案 || '').trim()) {
          报('写一句到点要提醒自己的话（比如「提醒主人去拿快递」）', 'bad')
          return
        }
        // ⚠ 时间只用 inMinutes 传给宿主：CONTRACT 里 alarms.createAlarm 同时收 at / inMinutes，
        //   而 at 到底是毫秒还是 ISO 两处写法不一致（§2.3 vs 计划书 §3.4）。算成分钟最稳。
        let 分钟后 = null
        if (String(新钟.时间 || '').trim()) {
          const t = new Date(新钟.时间).getTime()
          if (!Number.isFinite(t)) {
            报('那个时间看不懂，换一个（日期框里重新选）', 'bad')
            return
          }
          分钟后 = Math.max(0, Math.round((t - Date.now()) / 60000))
        } else if (String(新钟.分钟后 || '').trim() !== '') {
          const n = Number(新钟.分钟后)
          if (!Number.isFinite(n) || n < 0) {
            报('「几分钟后」要填一个不小于 0 的数字', 'bad')
            return
          }
          分钟后 = Math.round(n)
        } else {
          报('填一个时间：要么选日期时间，要么填「几分钟后」', 'bad')
          return
        }
        设钟忙(true)
        const 重复 = 新钟.重复 === 'daily' || 新钟.重复 === 'interval' ? 新钟.重复 : 'none'
        const 体 = {
          action: 'create',
          card: 卡,
          inMinutes: 分钟后,
          text: String(新钟.文案).trim(),
          repeat: 重复,
        }
        if (重复 === 'interval') {
          const n = Number(新钟.间隔)
          体.intervalMinutes = Number.isFinite(n) && n > 0 ? Math.round(n) : 60
        }
        const r = await post('/alarms', 体)
        if (r && r.ok !== false) {
          报('闹钟建好了 ✓ ' + 分钟后 + ' 分钟后到点（' + 卡 + '）', 'ok')
          设新钟({ 时间: '', 分钟后: '', 文案: '', 重复: 'none', 间隔: '' })
          await 拉卡表()
        } else {
          报('闹钟没建成：' + ((r && r.error) || '宿主没回话'), 'bad')
        }
        设钟忙(false)
      }

      const 取消钟 = async (id) => {
        if (钟忙) return
        设钟忙(true)
        const r = await post('/alarms', { action: 'cancel', card: 卡, id })
        if (r && r.ok !== false) {
          报('闹钟已取消 ✓', 'ok')
          await 拉卡表()
        } else {
          报('取消失败：' + ((r && r.error) || '宿主没回话'), 'bad')
        }
        设钟忙(false)
      }

      // ---------- 版本检查（可选路由） ----------

      const 查更新 = async () => {
        设更新忙(true)
        const r = await get('/update?refresh=1')
        if (r && typeof r === 'object') 设更新(r)
        else 设更新({ ok: false, error: '这一版没提供 /update' })
        设更新忙(false)
      }
      const 一键更新 = async () => {
        设更新忙(true)
        报('正在装…', 'wait')
        const r = await post('/install', {})
        if (r && r.ok) 报('已经开始装了 —— 装完重启（或重载）一次 dsh 才生效', 'ok')
        else 报('没装成：' + ((r && r.error) || '宿主没回话'), 'bad')
        设更新忙(false)
      }

      // ---------- 组装 ----------

      if (!草稿) {
        return h(
          'div',
          { style: S.wrap },
          h('div', { style: S.h, margin: '0 0 8px' }, '主动搭话'),
          读错 ? h('div', { style: S.warn }, 读错) : h('div', { style: S.dim }, '读取中…'),
          读错 ? h('div', null, 按钮('重试', () => 刷新(卡), false, 忙)) : null,
        )
      }

      const 版本 = String((状 && 状.version) || '0.3.0')
      const 当卡行 = 卡 ? 卡表.filter((x) => x && x.card === 卡)[0] || null : null
      const 钟们 = 当卡行 && Array.isArray(当卡行.alarms) ? 当卡行.alarms : []

      const 通道选择 = (值, onChange) =>
        h(
          'select',
          {
            style: S.选择,
            value: String(值 || 'auto'),
            onChange: (e) => onChange(e.target.value),
          },
          h('option', { value: 'auto' }, 'auto（自动：有号走 QQ，没号留在 DSH）'),
          h('option', { value: 'qq' }, 'qq（只走 QQ）'),
          h('option', { value: 'dsh' }, 'dsh（只留在 DSH 会话）'),
        )

      // —— 卡片表的一行（「全部」视图） ——
      const 卡行 = (c) =>
        h(
          'div',
          { key: c.card || '?', style: { ...S.表行, ...(c.card === 卡 ? S.表行亮 : null) } },
          h('div', { style: { ...S.格, fontWeight: 600 }, title: String(c.card || '') }, String(c.card || '（没名字）')),
          h('div', { style: S.格 }, c.enabled ? 徽('开') : 徽('关', true)),
          h('div', { style: S.格 }, 徽(通道名(c.channel))),
          h('div', { style: S.格, title: 钟点(c.nextRollAt) }, 下次话(c.nextRollAt, 现在)),
          h(
            'div',
            { style: S.格, title: '今日掷中 ' + Number(c.rollsToday || 0) + ' 次；连着没中 ' + Number(c.misses || 0) + ' 次' },
            Number(c.rollsToday || 0) + ' 次',
            Number(c.misses || 0) > 0
              ? h('span', { style: S.dim }, ' · 没中 ' + Number(c.misses || 0))
              : null,
          ),
          h('div', { style: S.格 }, (Array.isArray(c.alarms) ? c.alarms.length : 0) + ' 个'),
          h('div', { style: S.格, title: 钟点(c.lastSpokeAt) }, 前次话(c.lastSpokeAt, 现在)),
          h(
            'div',
            { style: S.格 },
            c.sessionId
              ? h('span', { title: String(c.sessionId) }, '…' + 短id(c.sessionId))
              : h('span', { style: S.dim }, '自动'),
          ),
          h('div', { style: S.格 }, 按钮('进入', () => 切卡(c.card), true)),
        )

      const 表头 = ['卡名', '开关', '通道', '下次掷骰', '今日', '闹钟', '最近开口', '会话', ''].map((t, i) =>
        h('div', { key: i, style: S.格 }, t),
      )

      // —— 「全部」视图 ——
      const 全部组 = () => [
        h(
          'div',
          { key: '全部-全局', style: S.card },
          h('div', { style: { ...S.h, margin: '0 0 8px' } }, '全局默认（所有卡共用；单卡可以各自覆盖）'),
          h('div', { style: S.dim }, '这里是「默认值」：新卡继承它，单卡里改过的项盖在它上面。这一页的保存只写全局。'),
          行(
            '总开关（全局总闸）',
            勾(全值('enabled'), (v) => 改全('enabled', v)),
            '关掉 = 所有卡都不掷（单卡那些开关原样保留，只是不起作用）。',
          ),
          行(
            '试运行（全局）',
            勾(全值('dryRun'), (v) => 改全('dryRun', v)),
            '开着的时候：掷中了也只写一条记录，不真的发。先看几轮记录，确认时机合适了再关掉它。',
          ),
          行(
            '默认通道',
            通道选择(全值('channel'), (v) => 改全('channel', v)),
            '默认 auto：这张卡绑了 QQ 号就走 QQ，没绑就留在它的 DSH 会话里（还会提醒主人给它一个号）。',
          ),
          行(
            '把她的回复转发到 QQ（全局）',
            勾(全值('deliverText'), (v) => 改全('deliverText', v)),
            '关掉 = 只投递「念头」，她说了什么不再转发到手机（留在会话里）。',
          ),
        ),
        h(
          'div',
          { key: '全部-表', style: S.card },
          h('div', { style: { ...S.h, margin: '0 0 8px' } }, '每张卡（' + 卡表.length + ' 张）'),
          h('div', { style: S.dim }, '一行一张：开关 / 通道 / 下次掷骰 / 今日掷中 / 闹钟数 / 最近开口。点「进入」按这张卡单独调。'),
          卡表.length === 0
            ? h(
                'div',
                { style: { ...S.dim, marginTop: 8 } },
                读错 ? '读不到卡片列表：' + 读错 : '一张卡都没读到 —— soul-md 里还没有人格卡？',
              )
            : h('div', { style: S.表 }, h('div', { style: S.表头 }, 表头), 卡表.map(卡行)),
          h(
            'div',
            { style: { marginTop: 8 } },
            按钮('刷新', () => 刷新(卡), false, 忙),
            h('span', { style: S.dim }, '　' + (读到 ? '最后刷新 ' + 读到 : '')),
          ),
        ),
        h(
          'div',
          { key: '全部-动作', style: S.card },
          h('div', { style: { ...S.h, margin: '0 0 8px' } }, '自己的动作'),
          h('div', null, 按钮('保存设置', 存, true, 忙), h('span', { style: S.dim }, '　'), 按钮('刷新', () => 刷新(卡), false, 忙)),
          h(
            'div',
            { style: { marginTop: 6 } },
            h('div', { style: S.dim }, '「演练」「真发一次」是按卡执行的 —— 先在下面的表里点一张卡的「进入」。'),
          ),
        ),
      ]

      // —— 单卡视图 ——
      const 单卡组 = () => [
        h(
          'div',
          { key: '卡-现状', style: S.card },
          h('div', { style: { ...S.h, margin: '0 0 8px' } }, '《' + 卡 + '》现在怎么样'),
          当卡行
            ? h(
                'div',
                { style: { ...S.已勾, lineHeight: 1.9 } },
                '状态：' + (当卡行.enabled ? '开' : '关（这张卡不掷）') +
                  '　·　通道：' + 通道名(当卡行.channel) +
                  '　·　下次掷骰：' + 下次话(当卡行.nextRollAt, 现在) +
                  '（' + 钟点(当卡行.nextRollAt) + '）',
                h('br'),
                '今日掷中：' + Number(当卡行.rollsToday || 0) + ' 次' +
                  '　·　连着没中：' + Number(当卡行.misses || 0) + ' 次' +
                  '　·　最近开口：' + 前次话(当卡行.lastSpokeAt, 现在) +
                  '（' + 钟点(当卡行.lastSpokeAt) + '）',
                h('br'),
                '闹钟：' + 钟们.length + ' 个' +
                  '　·　指定会话：' + (当卡行.sessionId ? '…' + 短id(当卡行.sessionId) : '自动（宿主解析）'),
              )
            : h('div', { style: S.dim }, '宿主没在 /cards 里报这张卡的状态（可能卡片列表刚变过），点「刷新」看看。'),
        ),

        // —— 开关 + 通道 + 会话 ——
        h(
          'div',
          { key: '卡-开关', style: S.card },
          h('div', { style: { ...S.h, margin: '0 0 8px' } }, '开关 · 通道 · 会话'),
          行(
            '这一张的开关',
            勾(卡值('enabled'), (v) => 改卡('enabled', v)),
            '只管《' + 卡 + '》这一张；别的卡照旧。新卡出场默认是开的。',
          ),
          行(
            '试运行（全局）',
            勾(全值('dryRun'), (v) => 改全('dryRun', v)),
            '全局开关：所有卡都只记账不投递。注意它不属于单卡，改了所有卡一起变。',
          ),
          行(
            '通道',
            通道选择(卡值('channel'), (v) => 改卡('channel', v)),
            'auto = 这张卡绑了 QQ 号就走 QQ，没绑就留在它自己的 DSH 会话里；qq = 只走 QQ；dsh = 只留在会话里（不发手机）。',
          ),
          行(
            '显式会话 id',
            h('input', {
              style: S.input,
              placeholder: '留空 = 自动（该卡最近会话 → 开荒会话 → 现开一条）',
              value: String(卡值('sessionId') || ''),
              onChange: (e) => 改卡('sessionId', e.target.value),
            }),
            '填了就一直投到这条会话里；填错了宿主会记账并报错，不会拿别的卡的会话顶班。',
          ),
        ),

        // —— 骰子 ——
        h(
          'div',
          { key: '卡-骰子', style: S.card },
          h('div', { style: { ...S.h, margin: '0 0 8px' } }, '骰子（这张卡的节奏）'),
          h('div', { style: S.dim }, '每轮掷一个 0~100 的数，比命中线小就开口。命中线 =（峰时或谷时的那格）× 时机因子，再加上攒下来的没中加成。'),
          行('掷骰子间隔（分钟）', 数(卡值('intervalMinutes'), (v) => 改卡('intervalMinutes', v)), '默认 30。范围 1~1440；改完保存，下一轮就按新间隔走（不用重启）。'),
          行(
            '搭话冷却（分钟）',
            数(卡值('cooldownMinutes'), (v) => 改卡('cooldownMinutes', v)),
            '她真的说了话之后，这么多分钟内不再开口（默认 20）。只是把一句念头投进去、她看完没开口，不算开过口。0 = 不冷却。',
          ),
          行('没中加成（百分点）', 数(卡值('missBonus'), (v) => 改卡('missBonus', v)), '每没掷中一次，下一次命中线加这么多（默认 10）。填 0 = 关掉这个功能。'),
          行('加成上限（百分点）', 数(卡值('bonusCap'), (v) => 改卡('bonusCap', v)), '加成最多加到这么多（默认 40）。'),
          h('div', { style: S.dim }, '掷中就清零，从头开始；连着没中就一次一次往上加，加到上限为止。'),
          行(
            '安静时段（起 / 止，小时）',
            h(
              'div',
              null,
              数(卡值('quietStart'), (v) => 改卡('quietStart', v)),
              h('span', { style: S.dim }, ' 点 ~ '),
              数(卡值('quietEnd'), (v) => 改卡('quietEnd', v)),
              h('span', { style: S.dim }, ' 点'),
            ),
            '默认 1 ~ 8 点不掷（含 1 点、不含 8 点）。跨午夜也行（比如 23 ~ 7）。',
          ),
          行(
            '每日开口上限',
            数(卡值('dailyCap'), (v) => 改卡('dailyCap', v)),
            '0 = 不限（默认）。填了数就按「今日真的说了几次」拦，超过就当天不再掷。',
          ),
          h('div', { style: S.未保存 }, '⚠ 两个数字填成一样（比如 8 和 8）= 不启用安静时段：整天都可能掷骰子'),
        ),

        // —— 时机因子 ——
        h(
          'div',
          { key: '卡-因子', style: S.card },
          h('div', { style: { ...S.h, margin: '0 0 8px' } }, '时机因子（刚聊过就少开口，冷太久了就多开口）'),
          行(
            '近：刚聊过',
            h(
              'div',
              null,
              数(卡值('nearMinutes'), (v) => 改卡('nearMinutes', v)),
              h('span', { style: S.dim }, ' 分钟内 → ×'),
              数(卡值('nearFactor'), (v) => 改卡('nearFactor', v), 0.05),
            ),
            '距她上次说话不到这个分钟数 → 命中线乘这个因子（更难开口）。默认 20 分钟 ×0.15。',
          ),
          行(
            '远：冷太久',
            h(
              'div',
              null,
              数(卡值('farMinutes'), (v) => 改卡('farMinutes', v)),
              h('span', { style: S.dim }, ' 分钟以上 → ×'),
              数(卡值('farFactor'), (v) => 改卡('farFactor', v), 0.1),
            ),
            '超过这个分钟数没说话 → 命中线乘这个因子（更容易开口）。默认 360 分钟（6 小时）×1.5。',
          ),
          h('div', { style: S.dim }, '中间那一段：命中线 ×1。最后会夹在 0~100。'),
        ),

        // —— 峰谷分时 ——
        h(
          'div',
          { key: '卡-峰谷', style: S.card },
          h('div', { style: { ...S.h, margin: '0 0 8px' } }, '峰谷分时（贵的时候少开口，便宜的时候多开口）'),
          h('div', { style: S.dim }, '时段是写死的（峰时 = 周一~周五 9:00~12:00、14:00~18:00），不用你填；只有这两个数字要你定：'),
          行(
            '峰时命中线（%）',
            数(卡值('peakThreshold'), (v) => 改卡('peakThreshold', v)),
            '贵的时候少开口。默认 20。',
          ),
          行(
            '谷时命中线（%）',
            数(卡值('offThreshold'), (v) => 改卡('offThreshold', v)),
            '其余全是谷时（午休、18:00 到次日 9:00、周末全天）。默认 60。',
          ),
          行(
            '按哪个时区算峰谷（全局）',
            h('input', {
              style: S.small,
              placeholder: '留空 = 本机时区',
              value: String(全值('timezone') || ''),
              onChange: (e) => 改全('timezone', e.target.value),
            }),
            '峰谷按北京时间算。机器不在东八区时填 Asia/Shanghai，别让它按本地时间错判。写成别的 IANA 名字也行。',
          ),
          h('div', { style: S.未保存 }, '⚠ 两个数字填成一样 = 不分峰谷，全天一个命中线'),
          h(
            'div',
            { style: S.未保存 },
            '⚠ 注意：安静时段会盖住谷时 —— 这张卡现在是 ' +
              String(卡值('quietStart')) + '~' + String(卡值('quietEnd')) +
              ' 点不掷，谷时命中线再高也用不上。',
          ),
        ),

        // —— 触发文案 ——
        h(
          'div',
          { key: '卡-文案', style: S.card },
          h('div', { style: { ...S.h, margin: '0 0 8px' } }, '触发文案'),
          行(
            '掷中之后送出去的那句话',
            h('textarea', {
              style: S.ta,
              value: 卡值('triggerText') === undefined ? '' : String(卡值('triggerText')),
              onChange: (e) => 改卡('triggerText', e.target.value),
            }),
            '用她自己的口吻写一句「心里话」。发出去时会自动加上一句说明「这是你自己冒出来的念头、不是对方说的」，所以别在这里再写解释。',
          ),
        ),

        // —— 角色（全局） ——
        h(
          'div',
          { key: '卡-角色', style: S.card },
          h('div', { style: { ...S.h, margin: '0 0 8px' } }, '触发消息的角色（全局）'),
          行(
            '角色',
            h(
              'select',
              {
                style: S.选择,
                value: String(全值('role') || 'user'),
                onChange: (e) => 改全('role', e.target.value),
              },
              h('option', { value: 'user' }, 'user（当前唯一跑得通的）'),
              h('option', { value: 'developer' }, 'developer（当前 DSH 送不了）'),
            ),
            '选 developer 时插件会主动拒发并记一条，不会去写坏会话日志。原因与证据见 README「做不到的地方」。',
          ),
        ),

        // —— 闹钟 ——
        h(
          'div',
          { key: '卡-闹钟', style: S.card },
          h('div', { style: { ...S.h, margin: '0 0 8px' } }, '闹钟（她给自己定的时间表）'),
          h('div', { style: S.dim }, '到点宿主会往这张卡的会话里投一条「【你自己定的闹钟】…」，由她自己决定说什么、发不发。闹钟不消耗骰子。'),
          钟们.length === 0
            ? h('div', { style: { ...S.dim, marginTop: 8 } }, '这张卡现在没有闹钟。')
            : h(
                'div',
                { style: { marginTop: 8, border: '1px solid var(--dsw-alias-border-l2)', borderRadius: 6 } },
                钟们.map((a, i) =>
                  h(
                    'div',
                    {
                      key: a && a.id ? String(a.id) : i,
                      style: {
                        display: 'flex',
                        gap: 10,
                        alignItems: 'center',
                        padding: '6px 8px',
                        borderTop: i === 0 ? 'none' : '1px solid var(--dsw-alias-border-l1, rgba(0,0,0,.06))',
                        flexWrap: 'wrap',
                      },
                    },
                    h('span', { style: { fontSize: 12.5, minWidth: 110 } }, 钟点(a && a.at)),
                    徽(重复名(a)),
                    h(
                      'span',
                      { style: { flex: '1 1 200px', minWidth: 120, fontSize: 12.5, wordBreak: 'break-word' } },
                      String((a && a.text) || '（没写文案）'),
                    ),
                    按钮('取消', () => 取消钟(a && a.id), false, 钟忙 || !(a && a.id)),
                  ),
                ),
              ),
          h(
            'div',
            { style: { marginTop: 12, borderTop: '1px solid var(--dsw-alias-border-l2)', paddingTop: 10 } },
            h('div', { style: { ...S.dim, fontWeight: 600, marginBottom: 6 } }, '新建一个闹钟'),
            行(
              '到点时间',
              h(
                'div',
                null,
                h('input', {
                  type: 'datetime-local',
                  style: { ...S.small, width: 200 },
                  value: 新钟.时间,
                  onChange: (e) => 设新钟({ ...新钟, 时间: e.target.value, 分钟后: '' }),
                }),
                h('span', { style: S.dim }, ' 或者 '),
                h('input', {
                  type: 'number',
                  min: 0,
                  style: S.small,
                  placeholder: '几分钟后',
                  value: 新钟.分钟后,
                  onChange: (e) => 设新钟({ ...新钟, 分钟后: e.target.value, 时间: '' }),
                }),
              ),
              '两个填一个就行：「日期时间」按本机时区算，「几分钟后」是相对现在。',
            ),
            行(
              '到点说的那句话',
              h('textarea', {
                style: { ...S.ta, minHeight: 44 },
                placeholder: '例如：提醒主人 10 点把方案发出去',
                value: 新钟.文案,
                onChange: (e) => 设新钟({ ...新钟, 文案: e.target.value }),
              }),
              '这是投给她自己的提醒，不是直接发给主人的话。',
            ),
            行(
              '重复',
              h(
                'div',
                null,
                h(
                  'select',
                  {
                    style: S.选择,
                    value: 新钟.重复,
                    onChange: (e) => 设新钟({ ...新钟, 重复: e.target.value }),
                  },
                  h('option', { value: 'none' }, '一次'),
                  h('option', { value: 'daily' }, '每天'),
                  h('option', { value: 'interval' }, '每隔几分钟'),
                ),
                新钟.重复 === 'interval'
                  ? h('span', null, h('span', { style: S.dim }, '　每 '), 数(新钟.间隔, (v) => 设新钟({ ...新钟, 间隔: v })), h('span', { style: S.dim }, ' 分钟'))
                  : null,
              ),
              '重复的闹钟由宿主在触发后自动算下一次。',
            ),
            h('div', { style: { marginTop: 6 } }, 按钮(钟忙 ? '建…' : '建这个闹钟', 新钟建, true, 钟忙)),
          ),
        ),
      ]

      // —— 日志（两种视图共用；单卡只显示该卡） ——
      const 日志卡 = () =>
        h(
          'div',
          { style: S.card },
          h('div', { style: { ...S.h, margin: '0 0 8px' } }, '最近 ' + 日志.length + ' 条记录' + (卡 ? '（只看《' + 卡 + '》）' : '（所有卡）')),
          h('div', { style: S.dim }, '定时器每轮都会留一条：没掷中也留（好确认它到底有没有在跑）。'),
          日志错 ? h('div', { style: { ...S.未保存 } }, '⚠ ' + 日志错) : null,
          h(
            'div',
            { style: { marginTop: 6, maxHeight: 260, overflowY: 'auto' } },
            日志.length === 0
              ? h('div', { style: S.dim }, 日志错 ? '没有可显示的日志。' : '还没有记录。')
              : 日志.map((条, i) => {
                  const 文 = 条 && typeof 条 === 'object' ? 条 : { text: String(条) }
                  const 前 = 时刻头(文.t) + '　' + (卡 ? '' : '[' + String(文.card || '?') + '] ')
                  return h('div', { key: i, style: S.日志行 }, 前 + String(文.text === undefined ? '' : 文.text))
                }),
          ),
          h('div', { style: { marginTop: 6 } }, 按钮('刷新日志', () => 拉日志(卡), false, 忙)),
        )

      /** 日志时间戳：日期 + 时分秒（比掷骰状态更需要「几点几分」。 */
      const 时刻头 = (v) => {
        const t = 解析时刻(v)
        if (!t) return '—'
        const d = new Date(t)
        return 两位(d.getHours()) + ':' + 两位(d.getMinutes()) + ':' + 两位(d.getSeconds())
      }

      // —— 版本与更新（0.2.9 的可选路由，缺失只显示一行灰字） ——
      const 更新卡 = () =>
        h(
          'div',
          { style: { ...S.card, marginTop: 4 } },
          h('div', { style: { ...S.h, margin: '0 0 6px' } }, '版本'),
          h(
            'div',
            { style: S.dim },
            更新 && 更新.ok === false
              ? '版本检查没应答（' + (更新.error || '这一版可能没提供 /update') + '）—— 要更新请手动装包。'
              : 更新 && 更新.hasUpdate
                ? '仓库里已经有 v' + 更新.latest + ' 了'
                : 更新 && 更新.ok
                  ? '已经是最新版'
                  : '当前版本 ' + 版本 + '。0.3.0 起按人格卡分别掷骰、分通道投递。',
          ),
          h(
            'div',
            { style: { marginTop: 6 } },
            按钮(更新忙 ? '查…' : '检查更新', 查更新, false, 更新忙),
            更新 && 更新.hasUpdate
              ? h(
                  'span',
                  null,
                  h('span', { style: S.dim }, '　'),
                  更新.canInstall
                    ? 按钮(更新忙 ? '装…' : '一键更新到 v' + 更新.latest, 一键更新, false, 更新忙)
                    : h('span', { style: S.dim }, '这是本地开发副本（link: 进来的），请手动更新。'),
                )
              : null,
            更新 && 更新.hasUpdate ? h('div', { style: S.dim }, '装完重启（或重载）一次 dsh 才生效。') : null,
          ),
        )

      const 掷果行 = 掷果
        ? h(
            'div',
            {
              style: {
                marginTop: 8,
                padding: '7px 10px',
                borderRadius: 8,
                border: '1px solid ' + (掷果.失败 ? '#c0392b' : 'var(--dsw-alias-border-l2)'),
                color: 掷果.失败 ? '#c0392b' : 'inherit',
                fontSize: 12,
                lineHeight: 1.7,
              },
            },
            '上次' + String(掷果.模式) + '（' + 时刻头(掷果.时间) + '）：' +
              (掷果.失败 ? '失败 —— ' : 掷果.中 ? '掷中了 ✓' : '没掷中') +
              (掷果.详情 ? '　' + 掷果.详情 : ''),
          )
        : null

      const 主体 = 卡 ? 单卡组() : 全部组()

      return h(
        'div',
        { style: S.wrap },

        // —— 顶栏：标题 + 卡片下拉 + 刷新 ——
        h(
          'div',
          { style: S.顶 },
          h('div', { style: { ...S.h, margin: 0 } }, '主动搭话'),
          h(
            'span',
            { style: S.dim },
            '版本 ' + 版本 +
              (状 && 状.timer === true ? ' · 定时器在跑' : 状 && 状.timer === false ? ' · 定时器没在跑' : '') +
              (读到 ? ' · 最后刷新 ' + 读到 : ''),
          ),
          h('span', { style: { flex: 1 } }),
          h('span', { style: S.dim }, '卡片'),
          h(
            'select',
            {
              style: S.选择,
              value: 卡,
              onChange: (e) => 切卡(e.target.value),
              title: '选一张卡只看它；「全部」是概览 + 全局默认',
            },
            h('option', { value: '' }, '全部（' + 卡表.length + ' 张）'),
            卡表.map((c) => h('option', { key: c.card, value: c.card }, String(c.card || '（没名字）'))),
          ),
          按钮(忙 ? '…' : '刷新', () => 刷新(卡), false, 忙),
        ),

        h(
          'div',
          { style: S.dim },
          '没人在跟她说话的时候，她也有可能先开口：每张卡按自己的间隔掷一次骰子（纯本地随机，不花模型），' +
            '掷中了才按该卡的通道投递 —— 绑了 QQ 就发到手机，没绑就留在她自己的 DSH 会话里。',
        ),

        // —— 通报条（成功/失败都可见；绝不静默） ——
        说 ? h('div', { style: 说类 === 'bad' ? S.通报坏 : 说类 === 'wait' ? S.通报等 : S.通报好 }, 说) : null,

        // —— 致命读取错误（/cards、/config 挂了） ——
        读错 && 卡 ? h('div', { style: S.warn }, 读错) : null,

        // —— 脏标记 ——
        脏
          ? h('div', { style: S.未保存 }, '⚠ 上面有改动还没保存 —— 数字/文案/开关改完要点「保存设置」（保存条贴在下面）')
          : null,

        ...主体,

        日志卡(),

        h(
          'div',
          { style: S.dim },
          '⚠ 掷骰子是纯本地随机，不花模型；只有「掷中之后真发」才会走 DSH 的一轮（会花 token）。',
        ),

        更新卡(),

        // —— 悬浮的保存条：**只要有没保存的改动，就贴在底下冒出来** ——
        脏
          ? h(
              'div',
              { style: S.悬浮保存条 },
              h('span', { style: { fontWeight: 600, color: '#c0392b' } }, '⚠ 有改动还没保存'),
              h('span', { style: S.dim }, 卡 ? '这一页存的是《' + 卡 + '》的策略 + 全局项' : '这一页存的是全局默认'),
              按钮('保存设置', 存, true, 忙),
            )
          : null,
      )
    }

    function apply(ctx) {
      const slots = ctx.get('slots')
      if (slots === undefined) return
      slots.inject('settings.section', () =>
        slots.register(
          { name: 'settings.section', id: 'speak-up', order: 53, label: () => '主动搭话' },
          Section,
        ),
      )
    }

    exports.apply = apply
    exports.inject = inject
    return module.exports
  },
})
