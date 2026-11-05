# dsh-speak-up 0.3.0 施工契约（Captain 定稿）

> 本文件是施工的唯一接口约定。子 agent 只按自己领到的「文件所有权」写，**不许改别人名下的文件**。
> 代码目录：`D:\dsh\plugins\dsh-speak-up`（已 git init，基线 commit 30062bc）。
> 计划书：`F:\dsh零散工作区\大肥鱼计划\16-speak-up多鱼主动机制改造计划.md`（设计与理由看它，这里只写接口）。

## 0. 一句话

0.2.9 是「一个插件一份配置、一个定时器、一次掷一粒骰子」。0.3.0 要变成：
**每张人格卡各自一份策略、各自一粒骰子、各自一个闹钟表；掷中后按「该卡的会话」投递，会话不在就现开；话默认经 QQ 送到主人手里，没绑 QQ 就留在该卡的开荒会话里。**

## 1. 目录与文件所有权

```
lib/
  host.js        ← A1 拥有（入口/装配/路由；可以大改）
  config.js      ← A1 新建
  cards.js       ← A1 新建
  dice.js        ← A1 新建
  scheduler.js   ← A1 新建
  delivery.js    ← A2 新建
  channels.js    ← A2 新建
  alarms.js      ← A3 新建
  tools.js       ← A3 新建
  client.js      ← B 拥有（网页半边）
  selfupdate.mjs ← 不动
tests/           ← 谁改代码谁补自己的测试；宿主半边.mjs 由 A1 负责更新
package.json     ← A1 改 version / repository
CHANGELOG.md     ← A1 记 0.3.0
README.md        ← 最后 Captain 统一改
```

## 2. 数据文件（全部在 `$DSH_HOME/speak-up/`，本机 DSH_HOME = D:\dsh\.dsh）

```
config.json              全局默认（沿用 0.2.9 的全部键）
card.<安全卡名>.json      该卡策略（可只写覆盖项）
card.<安全卡名>.state.json 该卡状态（运行时，别手写）
```
- 安全卡名：卡名里 `/ \ : * ? " < > |` 和控制字符替换成 `_`，其余中文原样保留。导出 `safeCardName(card)`。
- 所有写盘：先写 `xxx.tmp` 再 `rename`（原子），失败只记账不抛。
- 读坏文件：返回默认值 + 记账，绝不 crash（0.2.9 已有这个习惯，保持）。

### 2.1 全局 config.json 默认值
沿用 0.2.9：`enabled:true, dryRun:true, intervalMinutes:30, peakThreshold:20, offThreshold:60, timezone:'', missBonus:10, bonusCap:40, quietStart:1, quietEnd:8, nearMinutes:20, nearFactor:0.15, farMinutes:360, farFactor:1.5, cooldownMinutes:20, triggerText:'好久没人跟我说话了，我该主动去打个招呼', role:'user', dailyCap:0(0=不限)`。
新增全局键：`channel:'auto'`（auto/qq/dsh）、`deliverText:true`（是否把她的回复转发到 QQ）。

### 2.2 每卡策略 card.<卡>.json（缺省继承全局）
可覆盖：`enabled, intervalMinutes, peakThreshold, offThreshold, missBonus, bonusCap, quietStart, quietEnd, nearMinutes, nearFactor, farMinutes, farFactor, cooldownMinutes, dailyCap, channel, sessionId(显式指定), triggerText`。

### 2.3 每卡状态 card.<卡>.state.json
```json
{
  "nextRollAt": 0, "misses": 0, "lastSpokeAt": 0, "rollsToday": 0, "dayKey": "2026-11-05",
  "lastSessionId": "", "alarms": [ {"id":"...","at":0,"text":"...","repeat":"none|daily|interval","intervalMinutes":0,"createdAt":0,"card":"..."} ]
}
```

### 2.4 迁移（A1 负责，幂等）
`$DSH_HOME/speak-up-config.json` 存在且新目录没有 config.json 时：
- 全局 config.json = 旧配置逐键拷贝（未知键丢弃，`sessionIds` 存成 `legacySessionIds`）；
- 旧 `sessionIds` 里每个 sid 用 `memoryCore.cardOf(sid)` 归属到卡，写进该卡策略的 `sessionId`；归不到卡的忽略；
- 旧文件不删，改名 `speak-up-config.json.migrated`；写一行日志。

## 3. 模块接口（全部 ESM，只用 node: 内置模块）

### lib/config.js
```js
export function safeCardName(card)
export function loadGlobal()                 // 缺省合并，返回完整对象
export function saveGlobal(patch)            // 浅合并后写盘，返回新对象
export function loadCardPolicy(card)         // global + 覆盖，返回完整对象
export function saveCardPolicy(card, patch)
export function loadCardState(card)
export function saveCardState(card, patch)
export function migrateLegacy(ctx)           // 幂等；返回 {migrated:boolean, cards:string[]}
export function configDir()                  // 绝对路径
```

### lib/cards.js
```js
export function listCards(ctx)   // 1) ctx.get('memoryCore')?.listCards() 2) soul-md settings cards 3) cordis.patch.yml 正则；返回 string[]（去重、去掉 'none'）
export function cardOf(ctx, sid) // 尽量 memoryCore.cardOf(sid)；没有就自己查 soul-md settings.sessions，再回退 active
export function setupOf(ctx, card)// memoryCore.setupOf(card) → {status, sessionId, ...}；没有返回 null
```
读 soul-md settings 用 `ctx.get('settings')`；服务不在就退回 `D:\dsh\.dsh\profiles\web\cordis.patch.yml` 文本正则（可复用 memory-core 的做法，但别 import 它的文件）。

### lib/dice.js（纯函数，从 host.js 142-430 搬）
```js
export function inQuietHours(hour, start, end)   // 含起不含止，跨零点也对
export function isPeakTime(date, tz)
export function baseThreshold(policy, date)
export function threshold(base, factor, misses, missBonus, bonusCap)
export function timeFactor(state, policy, now)
export function roll(hitLine)                    // Math.random()*100 < hitLine
export function nextRollAt(policy, from)         // from + intervalMinutes*60000（带 ±10% 抖动，防所有卡同一秒掷）
```

### lib/scheduler.js
```js
export function createScheduler(ctx, deps)
// deps = { deliver: async (card, mode) => void, log: (text, card?) => void, cards: () => string[], policy: (card) => object, state: (card) => object, saveState: (card, patch) => void }
// 返回 { start(), stop(), tickNow(cards?), status() }
```
行为：
- `start()` 装一个 60s 的 `ctx.interval`（找不到 timer 就记账并退化为只能手动）；
- 每秒轮不掷骰，**只有 `now >= state.nextRollAt` 的卡才掷**；安静时段直接跳过并把 nextRollAt 推到安静结束；
- 掷中：`await deps.deliver(card, '自动')`，然后 `misses=0, lastSpokeAt=now`；掷不中 `misses++`；
- 掷完（无论中没中）`nextRollAt = nextRollAt(policy, now)`；`rollsToday` 跨天清零；
- dailyCap>0 且 rollsToday>=cap 时，当天不再掷（nextRollAt 推到明天 0 点）；
- 并发：多卡同时到点时用 `Promise.allSettled` 并行，**不要全局串行**（用户拍板允许并行）；
- 单卡 deliver 抛错只记账，不能影响别的卡，也不能变成 unhandled rejection。

### lib/delivery.js（A2）
```js
export async function deliverToCard(ctx, card, mode)   // mode: '自动'|'演练'|'真发'
// 内部依次：resolveTarget → 造念头 → sayInSession 或 sendViaChannel
export async function resolveTarget(ctx, card)         // → {sessionId, how:'explicit'|'recent'|'onboard'|'new'} 或 null
export async function ensureSession(ctx, card)         // 照抄 bili-whale openSession：先 registerSession 再 controller.create
export async function sayInSession(ctx, sid, text)     // resolveAgent → agent.followup(createUserMessage([{type:'text',text}], {source})) → await → sessions.flush
export function makeSource()                           // {kind:'speak-up', plugin:'dsh-speak-up'}
export async function waitForReply(ctx, sid, sinceMs)  // 轮询 inspect(sid) 找 sinceMs 之后第一条有正文的 assistant 消息，超时 120s 返回 null
```
要点：
- `resolveAgent` 对冷会话会 resume；返回 `{agent}` 或 `{error}`，错误码要原样记账；
- 消息 source 必须是 `{kind:'speak-up', plugin:'dsh-speak-up'}`，否则 memory-core 会把它当主人说的话写进库；
- `followup` 必须 await；`createUserMessage` 用 0.2.9 已有的「拿造消息工厂()」方式（动态 import，失败就手搓形状），不要硬写死；
- 没有会话时 `ensureSession`：新 sid = `speak-${safeCardName(card)}-${Date.now()}`，**先登记** `settings.update('soul-md',{sessions:{[sid]:card}})`，兜底逐行改 patch yml（原子写），再 `controller.create({sessionId:sid, cwd})`；
- 全程只改自己写的 state（lastSessionId），不碰别人的文件。

### lib/channels.js（A2）
```js
export async function sendQQ(ctx, card, text)   // → {ok:true, via:'qq'} | {ok:false, reason}
export function cardQQTarget(ctx, card)         // 该卡绑定的 QQ 号/chatId；没绑返回 null
```
- 用 `ctx.get('aurabot')`；`aurabot.ops.send({target:'private:<qq>', text})`；
- 该卡从哪拿 QQ 号：`ctx.get('aurabot')` 的号→卡映射（14 号计划的口径：accounts[i].card），拿不到就看 `aurabot.ops.info()`；都拿不到返回 null；
- 没绑 QQ → 返回 `{ok:false, reason:'no-qq'}`，由 delivery 决定「留在开荒会话」；
- au 服务不在或抛错 → `{ok:false, reason:'no-aurabot'}`，绝不 crash。

### lib/alarms.js（A3）
```js
export function alarmsOf(card)                   // state.alarms
export function createAlarm(card, {at, inMinutes, text, repeat='none', intervalMinutes=0})
export function cancelAlarm(card, id)            // → boolean
export function dueAlarms(now = Date.now())      // 跨所有卡扫 → [{card, alarm}]
export function fireAlarm(card, id, now)         // 复发则算下一次 at，否则移除；返回更新后的 alarm 或 null
```
闹钟存 `card.<卡>.state.json` 的 `alarms`，id 用 `al-${Date.now()}-${rand}`。

### lib/tools.js（A3）
```js
export function installTools(ctx, deps)   // deps = { deliver, log }
```
注册两个工具（用 DSH 的 tools 服务；写法抄 dsh-soul-md / dsh-memory-core）：
- `speak_alarm`：`{action:'create'|'list'|'cancel', at?, inMinutes?, text?, repeat?, intervalMinutes?, id?, card?}`，card 缺省取当前会话的卡（`cardOf(ctx, 当前 sid)`）；
- `speak_send`：`{text, card?}` 立刻经通道发一条（调试/手动用）。
工具描述要写清「这是你自己给自己定的闹钟，到点宿主会重新叫醒你」。

### host.js（A1 装配）
- `inject` 增加 `'tools'`、`'settings'`；
- `apply()`：`migrateLegacy` → 读全局 → `createScheduler` → `scheduler.start()` → `installTools` → 路由；
- 旧「造执行体」里的投递/筛选逻辑删掉，`掷一次` 改为委派 scheduler/delivery；
- 保留：日志（按卡附带 card 字段）、演练/真发手动入口、路由鉴权/错误兜底。

## 4. HTTP 路由（A1 实现，B 的 UI 只用这些）

```
GET  /cards                → {ok, cards:[{card, enabled, channel, sessionId, nextRollAt, lastSpokeAt, rollsToday, misses, alarms:[{id,at,text,repeat}]}]}
GET  /config?card=<卡>     → {ok, global, card, policy}
POST /config               → body {card?, patch}  {ok, global, card, policy}
GET  /log?card=<卡>&limit= → {ok, items:[{t, text, card}]}
POST /roll                 → body {card, mode:'演练'|'真发'}  {ok, hit, detail}
GET  /alarms?card=<卡>     → {ok, items:[...]}
POST /alarms               → body {action:'create'|'cancel', card, ...}  {ok, ...}
GET  /status               → {ok, version, timer:boolean, cards:[...]}
POST /migrate              → {ok, migrated, cards}
```
卡名走 query 时用 `encodeURIComponent`。所有 handler 内部 try/catch，返回 `{ok:false, error}`。

## 5. UI（B）
- 左侧设置项「主动搭话」保留；顶部加卡片下拉（默认「全部」）；
- 「全部」视图：每张卡一行（卡名 / 开关 / 通道 / 下次掷骰 / 今日次数 / 闹钟数 / 最近一次），点进去切到该卡；
- 单卡视图：沿用 0.2.9 的 7 组设置 + 通道选择 + 闹钟列表（创建/取消）+ 最近日志（只显示该卡）；
- 「演练 / 真发一次」按卡执行；
- 不改宿主逻辑；所有请求失败要有可见提示（0.2.9 的 catch(()=>null) 保留但加 toast）。

## 6. 验收（Captain 跑）
1. `node --check lib/*.js` 全过；
2. `node tests/宿主半边.mjs` 通过（A1 更新后）；
3. 假 ctx 单测：`listCards` 3 级回退、`resolveTarget` 4 级顺序、`dueAlarms` 复发计算、`migrateLegacy` 幂等；
4. 真机：装 link 版 + bundles，重启 DSH，设置页能看到按卡分组；手动「真发」到一张卡能进它的会话；日志里 source 带 plugin；memory-core 不把这条当人话入库；
5. git：每完成一块单独 commit，最后 push 到 `https://github.com/abcd20241629/dsh-speak-up`。

## 7. 禁止
- 不 import `dsh-bili-whale` / `dsh-memory-core` 的内部文件（package exports 不含 lib/*），要抄就抄进本仓库；
- 不新增 npm 依赖；
- 不删 tests/宿主半边.mjs，只能改它适配新结构；
- 不把配置写回 `cordis.patch.yml`，除非是「sessions 映射」这一件事（且原子写）；
- 不在代码里写死 D:\dsh\.dsh（一律 `process.env.DSH_HOME`，缺失时回退 `os.homedir()/.dsh`）；
- **不要动运行中的 DSH / profile / bundles / junction**，那些由 Captain 最后做。
