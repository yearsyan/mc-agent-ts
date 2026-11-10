/**
 * 动作规格表: act 工具的单一数据源。
 * 每个动作一条规格 (分组 / 参数 / 一句说明 / 构造函数), 由它派生:
 *  - 参数校验与归一化 (缺哪个参数、类型不对都说清楚, 并附该动作的用法)
 *  - act 工具的描述、type 枚举、参数 schema (serve.ts)
 *  - 是否参与主动作互斥 (side)
 * 加动作 / 改参数只改这里; docs/DESIGN.md 的动作表由 `pnpm check:actions` 核对有没有漏。
 */
import type { BotAgent } from '../conn/bot.js'
import { homeDimension } from '../conn/reflex.js'
import type { Action } from './base.js'
import { MAX_MOVE_DIST, MoveToAction, DigAction, PlaceAction, JumpAction, StopAction, SelectSlotAction, OpenContainerAction, ChestOpAction, DropItemAction, CloseWindowAction } from './actions.js'
import { Task, ReachThen, ChestTransferAction, containerBlocked, CraftAction, SmeltAction, CollectAction, PickupItemsAction, EquipAction, EatAction, UseItemAction, UseBlockAction, SleepAction, WakeAction, InteractEntityAction, DismountAction, TradeAction } from './tasks.js'
import { ShootAction, AttackAction } from './combat.js'
import { EnchantAction, AnvilAction } from './enchant.js'
import { ScriptAction } from './script.js'
import type { Approval } from './route.js'

// ---------- 参数规格 ----------

type Kind = 'num' | 'int' | 'str' | 'bool' | 'any'

export interface ParamSpec {
  kind: Kind
  /** 必填 */
  req?: boolean
  /** 给了这个 (旧用法的) 参数时, 本参数不再必填 */
  unless?: string
  /** 缺省值 (有缺省值的参数在用法里标 ?) */
  def?: unknown
  /** 数值范围: 超出按边界截断, 不报错 */
  min?: number
  max?: number
  /** str: 允许空串 (如 anvil rename:"" = 去掉名字); 否则空串当没传 */
  empty?: boolean
  /** 参数说明 (进 schema) */
  doc?: string
  /** 旧用法: 仍然接受, 但不出现在用法 / schema 里 */
  hidden?: boolean
}

const P = (kind: Kind, o: Omit<ParamSpec, 'kind'> = {}): ParamSpec => ({ kind, ...o })
const num = (o?: Omit<ParamSpec, 'kind'>) => P('num', o)
const int = (o?: Omit<ParamSpec, 'kind'>) => P('int', o)
const str = (o?: Omit<ParamSpec, 'kind'>) => P('str', o)
const bool = (o?: Omit<ParamSpec, 'kind'>) => P('bool', o)
const REQ = { req: true } as const
const XYZ = { x: int(REQ), y: int(REQ), z: int(REQ) }

export interface MakeCtx {
  /** 脚本里的子动作 (moveTo 默认不限路程, 脚本自己有超时与报告) */
  script?: boolean
  /** 寻路改地形的权限 (由通用参数 confirm / allow_dig / allow_place 得出) */
  moveOpts: { allowDig: boolean, allowPlace: boolean, approved?: Approval }
}

export interface ActionSpec {
  group: string
  params?: Record<string, ParamSpec>
  /** 一句说明 (进 act 工具描述) */
  doc?: string
  /** 不参与主动作互斥: 纯库存/界面操作, 可与移动等并行 */
  side?: boolean
  /** 旧动作 / 内部动作: 仍可用, 不出现在枚举和描述里 */
  hidden?: boolean
  make: (bot: BotAgent, p: Record<string, any>, ctx: MakeCtx) => Action
}

/** 任何动作都接受的寻路权限参数 (只对要走路的动作有意义) */
const ROUTE_PARAMS: Record<string, ParamSpec> = {
  confirm: P('any', { doc: '批准寻路方案 id (如 "p12-1", 多个用逗号): 只允许该方案列出的挖/放' }),
  allow_dig: bool({ doc: '寻路整趟允许挖穿方块 (默认 false; 一般用 confirm 批准具体方案)' }),
  allow_place: bool({ doc: '寻路整趟允许垫高/搭桥放方块 (默认 false)' }),
}

const MAX_DIST = int({ min: 8, max: 512, doc: '单次最多走多少格 (默认 128, 8~512)' })
/** 脚本默认不限路程; LLM 直接下达的默认 128 格 */
const maxDistance = (p: Record<string, any>, ctx: MakeCtx): number | undefined => p.max_dist ?? (ctx.script ? undefined : MAX_MOVE_DIST)
const at3 = (p: Record<string, any>) => p.x != null && p.y != null && p.z != null ? { x: p.x as number, y: p.y as number, z: p.z as number } : undefined

const chest = (dir: 'take' | 'put'): ActionSpec => ({
  group: '容器',
  side: true,
  params: {
    item: str({ req: true, unless: 'slot', doc: '物品名, 如 oak_planks / wooden_pickaxe / bread' }),
    count: int({ min: 1 }),
    x: int(), y: int(), z: int(),
    slot: int({ hidden: true }),
  },
  make: (bot, p) => {
    // 按物品名存取 (count 缺省 = 全部, 可带 x,y,z 一步完成); 只给 slot 时走旧的按槽位 shift 点击
    if (p.item) return new ChestTransferAction(bot, dir, p.item, p.count, at3(p))
    if (p.slot != null) return new ChestOpAction(bot, dir, p.slot)
    throw new Error(`chest_${dir} 缺少参数 item; ${usage(`chest_${dir}`)}`)
  },
})

export const ACTIONS: Record<string, ActionSpec> = {
  // ---- 移动 ----
  move_to: {
    group: '移动',
    params: { x: num(REQ), z: num(REQ), y: num(), tolerance: int({ min: 0, doc: 'move_to 到达容差, 0=精确' }), max_dist: MAX_DIST },
    doc: '自动开门/爬梯/游泳, 远距离分段; 一次最多走 max_dist 格, 到了就停下返回 arrived:false + remaining, 看看周围再继续',
    make: (bot, p, ctx) => new MoveToAction(bot, { x: p.x, y: p.y, z: p.z }, { tolerance: p.tolerance, ...ctx.moveOpts, maxDistance: maxDistance(p, ctx) }),
  },
  go_home: {
    group: '移动',
    params: { max_dist: MAX_DIST },
    doc: '回 set_policy 设的 home',
    make: (bot, p, ctx) => {
      const h = bot.reflex.policy.home
      if (!h) throw new Error('还没设置 home (set_policy {home: "here"} 或 {home: {x,y,z}})')
      const hd = homeDimension(h)
      if (hd !== bot.dimension) throw new Error(`home 在 ${hd.replace(/^minecraft:/, '')} (${h.x},${h.y},${h.z}), 你现在在 ${bot.dimension.replace(/^minecraft:/, '')}: 坐标不通用, 先找传送门回去`)
      return new MoveToAction(bot, h, { tolerance: 1, ...ctx.moveOpts, maxDistance: maxDistance(p, ctx) })
    },
  },
  jump: { group: '移动', make: bot => new JumpAction(bot) },
  stop: { group: '移动', doc: '停下当前主动作', make: bot => new StopAction(bot) },

  // ---- 采集 ----
  collect: {
    group: '采集',
    params: { block: str({ req: true, doc: '方块名, 如 oak_log / stone / iron_ore' }), count: int({ def: 1 }), radius: int({ def: 32 }) },
    doc: '先查工具够不够 → 找 → 走过去 → 用最佳工具挖 → 捡掉落物',
    make: (bot, p) => new CollectAction(bot, p.block, p.count, p.radius),
  },
  dig: {
    group: '采集',
    params: XYZ,
    doc: '自动换工具',
    // dig / place / open_container: 先走到够得着且看得见的位置再操作 (ReachThen)
    make: (bot, p) => new ReachThen(bot, 'dig', { x: p.x, y: p.y, z: p.z }, () => new DigAction(bot, p.x, p.y, p.z), bot.world.getBlock(p.x, p.y, p.z)?.name ?? '方块'),
  },
  pickup_items: { group: '采集', params: { radius: int({ def: 8 }) }, make: (bot, p) => new PickupItemsAction(bot, p.radius) },

  // ---- 建造 / 合成 ----
  place: {
    group: '建造/合成',
    params: { ...XYZ, item: str(), hotbar: int({ doc: 'place 用快捷栏第几格 (0-8) 的方块, 代替 item' }), face: int({ def: 1, doc: 'place 点击的面 (0=-y 1=+y 2=-z 3=+z 4=-x 5=+x), 默认 1' }) },
    make: (bot, p) => new ReachThen(bot, 'place', { x: p.x, y: p.y, z: p.z }, () => new PlaceAction(bot, p.x, p.y, p.z, p.face, { hotbar: p.hotbar, item: p.item }), '放置点'),
  },
  craft: {
    group: '建造/合成',
    params: { item: str(REQ), count: int({ def: 1 }) },
    doc: '任意配方; 3×3 自动找/放工作台',
    make: (bot, p) => new CraftAction(bot, p.item, p.count),
  },
  smelt: {
    group: '建造/合成',
    params: { item: str(REQ), count: int({ def: 1 }), fuel: str({ doc: 'smelt 指定燃料 (默认自动选)' }) },
    doc: '自动找/放熔炉、选燃料',
    make: (bot, p) => new SmeltAction(bot, p.item, p.count, p.fuel),
  },
  enchant: {
    group: '附魔/铁砧',
    params: { item: str(REQ), option: int({ doc: 'enchant 的选项 0~2 (不给 = 只看选项)' }), slot: int() },
    doc: '自动找/放附魔台、放青金石; 不给 option 只返回三个选项 (等级要求/花费/提示附魔/可不可选), 选好再带 option 下达; 经验等级见 get_scene.xp',
    make: (bot, p) => new EnchantAction(bot, p.item, p.option, p.slot),
  },
  anvil: {
    group: '附魔/铁砧',
    params: {
      item: str(REQ),
      with: str({ doc: 'anvil 的第二件 (附魔书/同类物品/修复材料)' }),
      rename: str({ empty: true, doc: 'anvil 改名 ("" = 去掉名字)' }),
      slot: int(),
      with_slot: int({ doc: 'anvil 第二件的背包槽位 (同名多件时)' }),
      preview: bool({ doc: 'anvil 只预览产物和花费, 不执行' }),
    },
    doc: '合并附魔书/同类物品、材料修复、改名; 先算花费, 等级不够或过于昂贵直接说明; 同名多件时用 slot/with_slot 指定 (槽位见 list_inventory)',
    make: (bot, p) => new AnvilAction(bot, p.item, { with: p.with, rename: p.rename, slot: p.slot, withSlot: p.with_slot, preview: !!p.preview }),
  },

  // ---- 物品 ----
  equip: { group: '物品', side: true, params: { item: str(REQ) }, doc: '工具→手上, 盔甲→身上, 盾→副手', make: (bot, p) => new EquipAction(bot, p.item) },
  eat: { group: '物品', params: { item: str() }, doc: '不给 item 自动挑最好的食物', make: (bot, p) => new EatAction(bot, p.item) },
  use_item: {
    group: '物品',
    params: { item: str(), hold_ms: int({ def: 0, doc: 'use_item 按住右键多少毫秒' }) },
    doc: '右键使用手上或指定的物品',
    make: (bot, p) => new UseItemAction(bot, p.item, p.hold_ms),
  },
  select_slot: { group: '物品', side: true, params: { slot: int({ def: 0 }) }, doc: '快捷栏 0-8', make: (bot, p) => new SelectSlotAction(bot, p.slot) },
  drop_item: {
    group: '物品',
    side: true,
    params: {
      item: str({ req: true, unless: 'slot', doc: '物品名, 如 oak_planks / wooden_pickaxe / bread' }),
      count: int({ min: 1 }),
      all: bool({ doc: 'drop_item 把这种物品全丢掉 (可跨多组)' }),
      slot: int({ doc: 'enchant / anvil / drop_item: 同名多件时指定哪一格 (槽位号见 list_inventory)' }),
    },
    doc: '按物品名丢, count 缺省 1, all:true 全丢; 同名多件时用 slot 指定丢哪一格 (会核对那格确实是 item)',
    make: (bot, p) => new DropItemAction(bot, { item: p.item, count: p.count, all: !!p.all, slot: p.slot }),
  },

  // ---- 交互 ----
  use_block: { group: '交互', params: { ...XYZ, item: str() }, doc: '门/拉杆/按钮等', make: (bot, p) => new UseBlockAction(bot, p.x, p.y, p.z, p.item) },
  sleep: {
    group: '交互',
    params: { x: int(), y: int(), z: int() },
    doc: '不给坐标自动找附近的床',
    make: (bot, p) => {
      if (p.x != null && (p.y == null || p.z == null)) throw new Error(`sleep 指定床的位置要 x,y,z 三个都给; ${usage('sleep')}`)
      return new SleepAction(bot, at3(p))
    },
  },
  wake: { group: '交互', side: true, make: bot => new WakeAction(bot) },
  interact_entity: {
    group: '交互',
    params: { entity_id: int(REQ), item: str() },
    doc: '喂食繁殖/剪毛/骑乘',
    make: (bot, p) => new InteractEntityAction(bot, p.entity_id, p.item),
  },
  dismount: { group: '交互', side: true, make: bot => new DismountAction(bot) },
  trade: {
    group: '交互',
    params: { entity_id: int(REQ), index: int({ doc: 'trade 的交易序号' }), times: int({ def: 1 }) },
    doc: '不给 index 返回交易列表',
    make: (bot, p) => new TradeAction(bot, p.entity_id, p.index, p.times),
  },

  // ---- 战斗 ----
  attack: {
    group: '战斗',
    params: { entity_id: int(REQ), hits: int({ def: 3 }) },
    doc: '自动换最好的武器; 够不着/隔墙看不见会追过去; 挥砍间隔按武器攻速',
    make: (bot, p) => new AttackAction(bot, p.entity_id, p.hits),
  },
  shoot: {
    group: '战斗',
    params: { entity_id: int(REQ), shots: int({ def: 5, min: 1, max: 64, doc: 'shoot 最多射几箭, 默认 5' }), pickup: bool({ doc: 'shoot 后是否捡回箭, 默认 true' }) },
    doc: '弓箭自动瞄准: 弹道+移动预判, 隔墙/会误伤时不射, 贴脸自动近战',
    make: (bot, p) => new ShootAction(bot, p.entity_id, p.shots, { pickup: p.pickup !== false }),
  },

  // ---- 容器 ----
  chest_take: { ...chest('take'), doc: '按物品名取, count 缺省 = 全部; 带坐标则走过去→开箱→取→关箱, 不带则用当前打开的容器' },
  chest_put: { ...chest('put'), doc: '同上, 存入; 结果给实际数量, 满了会说明' },
  open_container: {
    group: '容器',
    params: XYZ,
    doc: '箱子上方被完整方块挡住/有猫会直接说明',
    make: (bot, p) => {
      const blk = containerBlocked(bot, p.x, p.y, p.z)
      if (blk) throw new Error(blk)
      return new ReachThen(bot, 'open_container', { x: p.x, y: p.y, z: p.z }, () => new OpenContainerAction(bot, p.x, p.y, p.z), bot.world.getBlock(p.x, p.y, p.z)?.name ?? '容器')
    },
  },
  close_window: { group: '容器', side: true, make: bot => new CloseWindowAction(bot) },

  // ---- 死亡 ----
  respawn: { group: '死亡', doc: '仅 autoRespawn=false 时需要', make: bot => bot.makeRespawn() },

  // ---- 旧动作 / 内部动作 (不出现在枚举和描述里) ----
  mount: { group: '交互', hidden: true, params: { entity_id: int(REQ), item: str() }, make: (bot, p) => new InteractEntityAction(bot, p.entity_id, p.item) },
  craft_planks: {
    group: '建造/合成',
    hidden: true,
    make: (bot) => { // 兼容旧动作: 用背包里第一种原木合成木板
      const log = bot.inventory.find(s => s.name.endsWith('_log') || s.name.endsWith('_stem'))[0]
      return new CraftAction(bot, log ? log.item.name.replace(/_(log|stem)$/, '_planks') : 'oak_planks', 4)
    },
  },
  script: {
    group: '脚本',
    hidden: true,
    params: { code: P('any'), args: P('any'), timeout_ms: P('any') },
    make: (bot, p) => new ScriptAction(bot, String(p.code ?? ''), { timeoutMs: p.timeout_ms, args: p.args }),
  },
}

// ---------- 用法 / 校验 ----------

const paramsOf = (s: ActionSpec) => Object.entries(s.params ?? {})

/** 动作用法, 如 `move_to{x,z,y?,tolerance?,max_dist?}` */
export function signature (type: string): string {
  const ps = paramsOf(ACTIONS[type]).filter(([, p]) => !p.hidden).map(([k, p]) => p.req ? k : `${k}?`)
  return ps.length ? `${type}{${ps.join(',')}}` : type
}
const usage = (type: string) => `用法: ${signature(type)}`

const snake = (k: string) => k.replace(/[A-Z]/g, c => '_' + c.toLowerCase())

function editDistance (a: string, b: string): number {
  const d = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array<number>(b.length).fill(0)])
  for (let j = 1; j <= b.length; j++) d[0][j] = j
  for (let i = 1; i <= a.length; i++) for (let j = 1; j <= b.length; j++) d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1))
  return d[a.length][b.length]
}
/** 最像的候选 (差太多就不猜) */
function nearest (word: string, cands: string[]): string | undefined {
  let best: string | undefined, bd = Infinity
  for (const c of cands) { const d = editDistance(word, c); if (d < bd) { bd = d; best = c } }
  return bd <= Math.max(2, Math.floor(word.length / 3)) ? best : undefined
}

const show = (v: unknown) => { const t = JSON.stringify(v) ?? String(v); return t.length > 40 ? t.slice(0, 40) + '…' : t }

/** 校验并归一化参数: 返回规格里声明的参数 (已转型/补缺省/截断) 和没认出来的参数名 */
function normalize (type: string, spec: ActionSpec, raw: Record<string, any>): { p: Record<string, any>, ignored: string[] } {
  const specs: Record<string, ParamSpec> = { ...(spec.params ?? {}), ...ROUTE_PARAMS }
  // 驼峰写法 (allowDig / entityId / maxDist, 脚本 API 的习惯) 当成对应的下划线参数
  const given: Record<string, any> = {}
  const ignored: string[] = []
  for (const [k, v] of Object.entries(raw ?? {})) {
    if (k === 'type' || v === undefined) continue
    const key = k in specs ? k : snake(k) in specs ? snake(k) : null
    if (key === null) ignored.push(k)
    else if (!(key in given) || key === k) given[key] = v
  }
  const p: Record<string, any> = {}
  for (const [k, s] of Object.entries(specs)) {
    let v = given[k]
    if (s.kind === 'str' && v === '' && !s.empty) v = undefined
    if (v == null) {
      if (s.req && !(s.unless && given[s.unless] != null)) throw new Error(`${type} 缺少参数 ${k}; ${usage(type)}`)
      if (s.def !== undefined) p[k] = s.def
      continue
    }
    const bad = (want: string) => new Error(`${type} 的参数 ${k} 应为${want}, 收到 ${show(v)}; ${usage(type)}`)
    switch (s.kind) {
      case 'num': case 'int': {
        let n = typeof v === 'string' && v.trim() === '' ? NaN : Number(v)
        if (typeof v === 'boolean' || !Number.isFinite(n)) throw bad('数字')
        if (s.kind === 'int') n = Math.floor(n)
        if (s.min != null) n = Math.max(s.min, n)
        if (s.max != null) n = Math.min(s.max, n)
        p[k] = n
        break
      }
      case 'str':
        if (typeof v !== 'string') throw bad('字符串')
        p[k] = v
        break
      case 'bool':
        if (v === true || v === 'true' || v === 1) p[k] = true
        else if (v === false || v === 'false' || v === 0) p[k] = false
        else throw bad(' true/false')
        break
      default: p[k] = v
    }
  }
  return { p, ignored }
}

/** 按类型构造动作 (不启动): 查表 → 校验 → 构造。没认出来的参数不拒绝, 记在 action.warning 里 */
export function buildAction (bot: BotAgent, type: string, params: any, ctx: { script?: boolean } = {}): Action {
  const spec = Object.hasOwn(ACTIONS, type) ? ACTIONS[type] : undefined
  if (!spec) {
    const guess = nearest(String(type), ACTION_TYPES)
    throw new Error(`未知动作类型: ${type}${guess ? ` (是不是 ${guess}?)` : ''}; 可用: ${ACTION_TYPES.join(' ')}`)
  }
  const { p, ignored } = normalize(type, spec, params ?? {})
  // 寻路改地形的权限: 默认只走现成的路; confirm:"<方案id>" 只批准该方案列出的改动 (比 allow_* 窄)
  const moveOpts = { allowDig: !!p.allow_dig, allowPlace: !!p.allow_place, approved: bot.approvalFor(p.confirm) }
  const a = spec.make(bot, p, { script: ctx.script, moveOpts })
  if (a instanceof Task) a.moveOpts = moveOpts
  if (ignored.length) {
    const names = Object.keys({ ...(spec.params ?? {}), ...ROUTE_PARAMS }).filter(k => !spec.params?.[k]?.hidden)
    a.warning = `没用上的参数: ${ignored.map(k => { const g = nearest(k, names); return g ? `${k} (是不是 ${g}?)` : k }).join(', ')}; ${usage(type)}`
  }
  return a
}

/** 不参与主动作互斥的动作 */
export const isSideAction = (type: string) => Object.hasOwn(ACTIONS, type) && !!ACTIONS[type].side

// ---------- 派生: act 工具的枚举 / schema / 描述 ----------

/** 对外公布的动作类型 (不含旧动作/内部动作) */
export const ACTION_TYPES = Object.keys(ACTIONS).filter(t => !ACTIONS[t].hidden)

const JSON_TYPE: Record<Kind, string | undefined> = { num: 'number', int: 'number', str: 'string', bool: 'boolean', any: undefined }

/** act 工具的参数 schema (各动作的参数按名字合并, 平铺) */
export function actSchemaProps (): Record<string, { type?: string, description?: string }> {
  const out: Record<string, { type?: string, description?: string }> = {}
  const add = (k: string, s: ParamSpec) => {
    if (s.hidden) return
    const t = JSON_TYPE[s.kind]
    const cur = out[k]
    if (cur && cur.type !== t) throw new Error(`动作规格表: 参数 ${k} 在不同动作里类型不一致`)
    const doc = [cur?.description, s.doc].filter((d, i, a) => d && a.indexOf(d) === i).join('; ')
    out[k] = { ...(t ? { type: t } : {}), ...(doc ? { description: doc } : {}) }
  }
  for (const t of ACTION_TYPES) for (const [k, s] of paramsOf(ACTIONS[t])) add(k, s)
  for (const [k, s] of Object.entries(ROUTE_PARAMS)) add(k, s)
  out.confirm = { type: 'string', description: ROUTE_PARAMS.confirm.doc }
  return out
}

/** 寻路走不通、结果里带 proposals 时附的说明 (细则不放进工具描述, 用到时才给) */
export const PROPOSAL_HINT = '你来决定: 不动 / 换目标 / 在原动作参数里加 confirm:"<方案id>" 重新下达 (只批准该方案列出的那几格, 推荐; 多个 id 用逗号) / 加 allow_dig:true 或 allow_place:true (整趟都允许, 范围大, 慎用)。方案保留 10 分钟; 标了 toward.waypoint 的方案只通往中途点, 走过去后可能还有新障碍; 开了权限也优先走现成的路, 结束时 route 列出实际挖掉/放置的方块'

/** act 工具描述里的动作清单: 每组一行, 每个动作 = 用法 + 一句说明 */
export function actionCatalog (): string {
  const groups = new Map<string, string[]>()
  for (const t of ACTION_TYPES) {
    const s = ACTIONS[t]
    const line = signature(t) + (s.doc ? ` (${s.doc})` : '')
    groups.set(s.group, [...(groups.get(s.group) ?? []), line])
  }
  return [...groups].map(([g, lines]) => `${g}: ${lines.join(' | ')}`).join('\n')
}
