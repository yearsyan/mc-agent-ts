/**
 * 基础动作: 移动 / 挖掘 / 放置 / 攻击 / 容器 / 简单动作。
 * act() -> actionId; 状态机式动作每 tick 由 BotAgent 驱动 step(), 多步动作用 AsyncAction.run()。
 */
import type { BotAgent } from '../conn/bot.js'
import { findPath, placementsIn, isOpenable, isDiggable, MAX_WATER_DROP, type PathNode } from './astar.js'
import { RouteLog, settleWithRoute, proposalText, judgeProposal, posKey, type RouteProposal, type DigStep, type Pos3, type Approval } from './route.js'
import { Action, AsyncAction } from './base.js'
import { SLOT, LAST_STORAGE, PLAYER_STORAGE, hotbarSlot, containerSize, toWindowSlot } from '../conn/inventory.js'
import { fluidHeight } from '../physics/runner.js'
import { holdSlot, holdItem, holdNothing, prepareHeld, placeBlockAt, faceTowards, reachTo, closeContainer, canReach, boxDist, eyeOf, REACH } from './hands.js'
import { bestToolFor, toolKind, weaponScore, blockProps, blockInfo, SCAFFOLD_BLOCKS, isWatery, isNaturalBlock } from '../game/knowledge.js'

export { Action, AsyncAction } from './base.js'
export type { ActionStatus } from './base.js'

const AIRISH = new Set(['air', 'cave_air', 'void_air'])
const isSoft = (name: string) => ['snow', 'short_grass', 'tall_grass', 'fern', 'torch'].includes(name)
/** 挡路、需要挖掉的方块 */
const blocksWay = (name: string) => !AIRISH.has(name) && !isSoft(name) && name !== 'water'

/** 背包里的垫脚方块 (按 SCAFFOLD_BLOCKS 优先级) */
export function scaffoldSlots (bot: BotAgent) {
  const hits = bot.inventory.find(s => SCAFFOLD_BLOCKS.includes(s.name))
  hits.sort((a, b) => SCAFFOLD_BLOCKS.indexOf(a.item.name) - SCAFFOLD_BLOCKS.indexOf(b.item.name))
  return hits
}
const scaffoldCount = (bot: BotAgent) => scaffoldSlots(bot).reduce((n, h) => n + h.item.count, 0)

/**
 * 挖穿航点要挖掉的格 (handleDig 与方案描述共用, 保证方案里列的就是实际会挖的)。
 * optional = 楼梯式上挖最上面那格 (只为起跳留头顶空间, 挖不动/未获批就不挖)。
 */
function digTargets (bot: BotAgent, wp: PathNode, allowed?: (x: number, y: number, z: number) => boolean): { y: number, name: string, optional: boolean }[] {
  const ys = wp.dig === 'up' ? [wp.y, wp.y + 1, wp.y + 2] : wp.dig === 'down' ? [wp.y] : [wp.y, wp.y + 1]
  const out: { y: number, name: string, optional: boolean }[] = []
  for (const y of ys) {
    const b = bot.world.getBlock(wp.x, y, wp.z)
    if (!b || !blocksWay(b.name)) continue
    const optional = y === wp.y + 2
    if (optional && (!isDiggable(b.name) || (allowed && !allowed(wp.x, y, wp.z)))) continue
    out.push({ y, name: b.name, optional })
  }
  return out
}

// ---------- 挖掘代价 (按背包工具) ----------

/** 走一格约 0.23s: 挖掘秒数 × 4.3 折算成"走几格" */
const WALK_PER_S = 4.3
/** 人造方块 (木板/砖/玻璃…) 额外代价: 能绕就绕, 实在要挖方案里会标"不推荐" */
const ARTIFICIAL_PENALTY = 40

/** 用背包里最合适的工具挖这种方块: 工具/耗时/是否自然方块 */
function digInfo (name: string, tools: { slot: number, name: string }[]): Omit<DigStep, 'block' | 'pos'> {
  const t = bestToolFor(name, tools)
  return {
    tool: t.name,
    secs: Number.isFinite(t.ticks) ? +(t.ticks / 20 + 0.15).toFixed(2) : Infinity, // +0.15: 转身/发包
    natural: isNaturalBlock(name),
    ...(t.harvest ? {} : { noDrop: true as const }),
  }
}

/** 给 A* 的挖掘代价函数 (按当前背包工具, 每次规划生成一次) */
function makeDigCost (bot: BotAgent) {
  const tools = toolCandidates(bot)
  return (name: string) => {
    const d = digInfo(name, tools)
    if (!Number.isFinite(d.secs)) return null
    return d.secs * WALK_PER_S + (d.natural ? 0 : ARTIFICIAL_PENALTY)
  }
}

/** 把一条改地形的路径整理成给 LLM 确认的方案 (带工具/耗时/推荐) */
function describeRoute (bot: BotAgent, path: PathNode[], option: RouteProposal['option']): RouteProposal {
  const tools = toolCandidates(bot)
  const dig: DigStep[] = []
  for (const n of path) if (n.dig) for (const c of digTargets(bot, n)) dig.push({ block: c.name, pos: [n.x, c.y, n.z], ...digInfo(c.name, tools) })
  const place = path.filter(n => n.place).map(n => ({ pos: [n.x, n.y - 1, n.z] as Pos3, how: n.place! }))
  // 按 placeScaffold 的用法 (按优先级一组组用完) 估算消耗
  const uses: Record<string, number> = {}
  let left = place.length
  for (const s of scaffoldSlots(bot)) {
    if (!left) break
    const k = Math.min(left, s.item.count)
    uses[s.item.name] = (uses[s.item.name] ?? 0) + k
    left -= k
  }
  return judgeProposal({
    option,
    allow: { ...(option !== 'place' ? { allow_dig: true as const } : {}), ...(option !== 'dig' ? { allow_place: true as const } : {}) },
    steps: path.length - 1, dig,
    ...(dig.length ? { dig_s: +dig.reduce((t, d) => t + d.secs, 0).toFixed(1) } : {}),
    place,
    ...(place.length ? { uses } : {}),
    ...(left ? { shortage: left } : {}),
  })
}

/** 一次搜索的权限: 能否挖, 最多放几块, 落地水高度 (缺省 = 本次规划按背包算的), 是否限于已批准的格 */
interface Perm { dig: boolean, place: number, water?: number, restrict?: boolean }

/** move_to / go_home 单次最多走多少格 (实际路程): 走太久 agent 感知不到途中情况, 到了先停下汇报 */
export const MAX_MOVE_DIST = 128
/** 算"搭方块"方案时假设的方块数 (背包不够也给出方案并注明缺多少) */
const PROPOSAL_SCAFFOLD = 64

/** 背包里所有工具 (挖掘选工具用) */
export const toolCandidates = (bot: BotAgent) => bot.inventory.find(s => !!toolKind(s.name)).map(h => ({ slot: h.slot, name: h.item.name }))

// ---------- 移动 ----------

export interface MoveOptions {
  /** 到达容差 (格); 0 = 必须站到目标格 */
  tolerance?: number
  timeoutMs?: number
  /** 允许挖穿方块 (默认 false: 只走现成的路, 走不通时给出方案由调用方确认) */
  allowDig?: boolean
  /** 允许垫方块/搭桥 (默认 false; 开了也要背包有泥土/圆石等才生效) */
  allowPlace?: boolean
  /** 走不通时计算挖/搭方案放进 extra.proposals (默认 true; 反射逃跑等用不上的关掉省算力) */
  propose?: boolean
  /** 按方案确认 (confirm): 只允许挖/放方案里列出的格 (allowDig/allowPlace 是整趟都允许) */
  approved?: Approval
  /** 单次最多走多少格 (实际路程); 到了就在安全落脚点停下, extra.arrived=false。不给 = 不限 */
  maxDistance?: number
}

/** 单段规划的最远水平距离; 更远的目标分段前进 (每段重新规划, 区块会随移动加载) */
const SEGMENT = 64

export class MoveToAction extends Action {
  private path: PathNode[] | null = null
  private wpIdx = 0
  private lastProgressAt = 0
  private lastWpProgressAt = 0
  private lastDist = Infinity
  private lastJumpAt = 0
  private replans = 0
  private strafeUntil = 0
  private strafeDir = 1
  private startedAt = 0
  private readonly deadline: number
  /** 当前段是中途点 (目标太远或未加载) */
  private segmenting = false
  private segments = 0
  /** 实际走过的水平路程 (单次上限用) */
  private traveled = 0
  private lastPos: { x: number, z: number } | null = null
  /** 按方案确认时: 只能挖/放这些格 (整趟允许或没批准时为 undefined) */
  private readonly digAllowed?: (x: number, y: number, z: number) => boolean
  private readonly placeAllowed?: (x: number, y: number, z: number) => boolean
  private tol: number
  // 挖掘子状态
  private digY: number | null = null
  private digSentAt = 0
  private digStopSent = false
  private digEstMs = 0
  private digTries = 0
  private digName = ''
  // 放置子状态
  private placeSentAt = 0
  private placeTries = 0
  private pillarBaseY: number | null = null
  // 开门
  private doorToggledAt = new Map<string, number>()
  private handOwner: string
  /** 规划中: 第一次搜索同步做, 其余每 tick 一次 (多候选/多档权限/算方案时不长时间阻塞事件循环) */
  private planner: Generator<void, void, void> | null = null
  /** 实际改动的地形 */
  readonly route = new RouteLog()
  /** 本次规划的挖掘代价函数 / 允许的落地水高度 (随背包变化, 每次规划重算) */
  private digCost: (name: string) => number | null = () => 2
  private waterDropMax = 0
  /** 落地水执行状态 (key = 航点坐标) */
  private wd: { key: string, phase: 'prep' | 'fall' | 'pickup' | 'done', pouredAt: number, landedAt: number, tries: number, lastTry: number } | null = null

  constructor (private bot: BotAgent, private target: { x: number, y?: number, z: number }, private opts: MoveOptions = {}) {
    super('move_to')
    this.tol = opts.tolerance ?? 1
    const dist = Math.hypot(target.x - bot.pos.x, target.z - bot.pos.z)
    this.deadline = Date.now() + (opts.timeoutMs ?? Math.max(90_000, dist * 1500))
    this.handOwner = `move#${this.id}`
    const ap = opts.approved
    if (ap && !opts.allowDig) this.digAllowed = (x, y, z) => ap.dig.has(posKey(x, y, z))
    if (ap && !opts.allowPlace) this.placeAllowed = (x, y, z) => ap.place.has(posKey(x, y, z))
  }

  private standableAt (x: number, y: number, z: number) {
    const w = this.bot.world
    const feet = w.getBlock(x, y, z), head = w.getBlock(x, y + 1, z), below = w.getBlock(x, y - 1, z)
    if (!feet || !head || !below) return false
    const ok = (n: string) => AIRISH.has(n) || isSoft(n) || isOpenable(n)
    // 脚可以在水里 (水面游泳), 头必须在空气里, 否则会把目标定到海底
    return (ok(feet.name) || isWatery(feet.name)) && ok(head.name) && !AIRISH.has(below.name) && below.name !== 'lava'
  }

  /** 目标列自适应: 指定高度不可站时上下扫 ±8 */
  private adaptY (x: number, y: number, z: number) {
    if (this.standableAt(x, y, z)) return y
    for (let dy = 1; dy <= 8; dy++) {
      if (this.standableAt(x, y + dy, z)) return y + dy
      if (this.standableAt(x, y - dy, z)) return y - dy
    }
    return y
  }

  /** 开始 (重新) 规划; 结果异步落到 this.path, 或 fail */
  private plan () {
    this.path = null
    this.planner = this.planSteps()
    this.advancePlanner()
  }

  private advancePlanner () {
    if (this.planner && this.planner.next().done) this.planner = null
  }

  /** 一次 A* 搜索; 带放置时方块不够或没搜到, 允许挖则不放方块再试一次 */
  private search (from: PathNode, t: { to: PathNode, tol: number, maxExp?: number }, perm: Perm): PathNode[] | null {
    const run = (place: number) => findPath(this.bot.world, from, t.to, { scaffold: place, allowDig: perm.dig, tolerance: t.tol, maxExpansions: t.maxExp, digCost: this.digCost, waterDrop: perm.water ?? this.waterDropMax,
      ...(perm.restrict ? { digAllowed: this.digAllowed, placeAllowed: this.placeAllowed } : {}) })
    let p = run(perm.place)
    if (perm.place > 0 && (!p || placementsIn(p) > perm.place)) p = perm.dig ? run(0) : null
    return p
  }

  /**
   * 规划流程 (每个 yield = 让出到下一 tick):
   * 1. 只走现成的路 (开门/爬梯/游泳, 不挖不放) 试所有候选目标
   * 2. 调用方开了 allowDig/allowPlace 才带上改地形的权限再试
   * 3. 都不行: 算出挖/搭方案 (不执行) 放进 extra.proposals, 失败返回给 LLM 决定
   */
  private * planSteps (): Generator<void, void, void> {
    const bot = this.bot, w = bot.world
    const from = { x: Math.floor(bot.pos.x), y: Math.floor(bot.pos.y), z: Math.floor(bot.pos.z) }
    const tx = Math.floor(this.target.x), tz = Math.floor(this.target.z)
    const dist = Math.hypot(tx - from.x, tz - from.z)
    const targetLoaded = !!w.getChunk(tx >> 4, tz >> 4)
    const targets: { to: PathNode, tol: number, maxExp?: number }[] = []
    this.segmenting = dist > SEGMENT || !targetLoaded
    if (this.segmenting) {
      // 朝目标方向取已加载的中途点: 先直线, 不通再偏一点角度/缩短距离; 优先落在陆地上 (海面中途点很难规划)
      const base = Math.atan2(tz - from.z, tx - from.x)
      const cands: { p: PathNode, land: boolean, rank: number }[] = []
      for (const d of [SEGMENT, 40, 24]) {
        for (const da of [0, 0.5, -0.5, 1.0, -1.0]) {
          const dd = Math.min(d, dist)
          const sx = Math.floor(from.x + Math.cos(base + da) * dd), sz = Math.floor(from.z + Math.sin(base + da) * dd)
          if (!w.getChunk(sx >> 4, sz >> 4)) continue
          const top = w.groundY(sx, sz, from.y) // 下界: 自己高度附近的地面, 不是顶棚上面
          if (top < w.min_y) continue
          const land = w.getBlock(sx, top, sz)?.name !== 'water'
          cands.push({ p: { x: sx, y: this.adaptY(sx, top + 1, sz), z: sz }, land, rank: -dd + Math.abs(da) * 20 })
        }
      }
      cands.sort((a, b) => (a.land === b.land ? a.rank - b.rank : a.land ? -1 : 1))
      if (!cands.length) { this.fail(`目标 (${tx},${tz}) 方向上没有已加载的区块`); return }
      for (const c of cands.slice(0, 6)) targets.push({ to: c.p, tol: 3, maxExp: 20000 })
    } else {
      const ty = Math.floor(this.target.y ?? bot.pos.y)
      // 精确目标 (tolerance 0 且给了 y) 不做高度自适应: 调用方选的点可能是要垫方块上去的空中位置
      targets.push({ to: { x: tx, y: this.tol === 0 && this.target.y !== undefined ? ty : this.adaptY(tx, ty, tz), z: tz }, tol: this.tol })
    }

    const have = scaffoldCount(bot)
    const allowDig = !!this.opts.allowDig
    this.digCost = makeDigCost(bot)
    // 有水桶且水不会蒸发 (不在下界): 允许 5..32 格的下落, 落地前倒水缓冲, 落地后收回 (不算改地形, 不用 allow 开关)
    this.waterDropMax = bot.inventory.count('water_bucket') > 0 && !bot.dimInfo.waterEvaporates ? MAX_WATER_DROP : 0
    const ap = this.opts.approved
    const tiers: Perm[] = [{ dig: false, place: 0 }]
    // 整趟允许 (allow_*) 的权限; 方案算重复时只看它
    const broad: Perm | null = allowDig || (this.opts.allowPlace && have > 0) ? { dig: allowDig, place: this.opts.allowPlace ? have : 0 } : null
    // 实际搜索用的: 整趟允许 ∪ 已批准的格
    const apPlace = ap ? Math.min(have, ap.place.size) : 0
    const granted: Perm | null = broad || (ap && (ap.dig.size || apPlace))
      ? { dig: allowDig || !!ap?.dig.size, place: this.opts.allowPlace ? have : apPlace, restrict: !!ap }
      : null
    if (granted) tiers.push(granted)
    let first = true
    for (const tier of tiers) {
      for (const t of targets) {
        if (!first) yield
        first = false
        const p = this.search(from, t, tier)
        if (p && p.length) { this.usePath(p); return }
      }
    }

    const t0 = targets[0].to
    const allowed = [allowDig && '挖掘', this.opts.allowPlace && (have > 0 ? '搭方块' : '搭方块 (但背包没有垫脚方块)'),
      ap && `方案 ${ap.ids.join('/')} 列出的改动${ap.place.size > have ? ` (但垫脚方块只有 ${have} 个, 方案要 ${ap.place.size} 个)` : ''}`].filter(Boolean).join('/')
    // 分段时方案只通往中途点: 说清楚, 免得 agent 以为是最终目标
    const remain = Math.round(Math.hypot(tx - t0.x, tz - t0.z))
    const where = this.segmenting
      ? `${from.x},${from.y},${from.z} -> 中途点 ${t0.x},${t0.y},${t0.z} (最终目标 ${tx},${tz} 太远/未加载, 分段走; 中途点离最终目标还有 ${remain} 格, 已试多个方向)`
      : `${from.x},${from.y},${from.z} -> ${t0.x},${t0.y},${t0.z}`
    const head = `无可行路径 ${where}${allowed ? ` (已允许${allowed})` : ' (只走现成的路, 不挖不搭)'}`
    if (this.opts.propose === false) { this.fail(head); return }

    // 算方案 (只针对首选目标): 已获准且试过的权限不再重复算
    const H = Math.max(have, PROPOSAL_SCAFFOLD)
    const covered = (m: Perm) => !!broad && (broad.dig || !m.dig) && broad.place >= m.place
    const proposals: RouteProposal[] = []
    const modes: [RouteProposal['option'], Perm][] = [['dig', { dig: true, place: 0 }], ['place', { dig: false, place: H }]]
    for (const [option, m] of modes) {
      if (covered(m)) continue
      yield
      const p = this.search(from, targets[0], m)
      if (p && p.length) proposals.push(describeRoute(bot, p, option))
    }
    // 单独挖/单独搭都不行才算两者结合
    if (!proposals.length && !covered({ dig: true, place: H })) {
      yield
      const p = this.search(from, targets[0], { dig: true, place: H })
      if (p && p.length) proposals.push(describeRoute(bot, p, 'dig+place'))
    }
    // 没水桶时: 看看有水桶能不能直接跳下去 (高处下不来的常见情况), 有的话提示
    let waterHint = ''
    if (!this.waterDropMax && !bot.dimInfo.waterEvaporates) {
      yield
      const p = this.search(from, targets[0], { dig: false, place: 0, water: MAX_WATER_DROP })
      const n = p?.filter(x => x.waterDrop).length ?? 0
      if (n) waterHint = `\n另: 背包有水桶 (water_bucket) 的话不用改地形, 直接从高处跳下 (${n} 处, 落地前倒水缓冲、落地后收回)`
    }
    // 推荐的排前面 (同样推荐时挖优先: 自然方块 + 有合适工具时挖比搭快, 也不用消耗方块)
    proposals.sort((a, b) => Number(b.recommended) - Number(a.recommended))
    // 编号 + 注明通往哪里, 存到 bot 上供 confirm 引用
    proposals.forEach((p, i) => { p.id = `p${this.id}-${i + 1}`; p.toward = { x: t0.x, y: t0.y, z: t0.z, ...(this.segmenting ? { waypoint: true as const } : {}) } })
    bot.rememberProposals(proposals)
    this.extra = { ...this.extra, proposals }
    this.fail(proposals.length
      ? `${head}。可选方案 (也可以换目标或不动)${this.segmenting ? '; 方案只通往中途点, 走过去后可能还有新的障碍' : ''}:\n${proposals.map(proposalText).join('\n')}${waterHint}`
      : `${head}。挖/搭方案也找不到 (可能被岩浆/水/不可挖方块隔开, 或目标太远/悬空)${waterHint}`)
  }

  private usePath (path: PathNode[]) {
    this.path = path
    this.wpIdx = Math.min(1, path.length - 1)
    this.digY = null
    this.placeSentAt = 0
    this.pillarBaseY = null
  }

  start () {
    this.startedAt = this.lastProgressAt = this.lastWpProgressAt = Date.now()
    this.plan()
  }

  step (nowMs: number) {
    if (this.planner) { this.halt(); this.advancePlanner(); return }
    if (!this.path) return
    const bot = this.bot
    if (this.lastPos) { const d = Math.hypot(bot.pos.x - this.lastPos.x, bot.pos.z - this.lastPos.z); if (d < 8) this.traveled += d } // 更大的跳变是传送
    this.lastPos = { x: bot.pos.x, z: bot.pos.z }
    if (nowMs > this.deadline) { this.stopMoving(); return this.fail('超时') }
    if (nowMs - this.lastProgressAt > 18000) { this.stopMoving(); return this.fail('超时: 18 秒无进展') }

    const wp = this.path[this.wpIdx]
    const dx = wp.x + 0.5 - bot.pos.x
    const dz = wp.z + 0.5 - bot.pos.z
    const distWp = Math.hypot(dx, dz)
    const c = bot.physics.control
    const inWater = bot.physics.inWater

    // ---- 门: 目标格的门关着就先打开 ----
    if (wp.door && this.openDoorIfClosed(wp, nowMs)) { this.halt(); return }

    // ---- 挖穿航点 ----
    if (wp.dig && this.handleDig(wp, nowMs)) return

    // ---- 高处跳下: 落地前倒水缓冲, 落地后收回 ----
    if (wp.waterDrop && this.handleWaterDrop(wp, nowMs)) return

    // ---- 搭桥: 走上去前先在脚下放方块 ----
    if (wp.place === 'bridge' && this.handleBridge(wp, nowMs)) return

    // ---- 垫方块上升 ----
    if (wp.place === 'pillar') { this.handlePillar(wp, nowMs); return }

    // ---- 到达判定 ----
    const finalWp = this.wpIdx >= this.path.length - 1
    const dyWp = wp.y - bot.pos.y
    // 游泳姿态时身体在水面下 ~0.2-0.6 格, 竖直判定放宽
    const vertOk = bot.swimming ? Math.abs(dyWp) < 1.2 : wp.climb || wp.swim ? Math.abs(dyWp) < 0.45 : dyWp < 0.6
    const arriveR = finalWp ? (this.tol === 0 && !this.segmenting ? 0.4 : 2.0) : (wp.climb ? 0.6 : 1.6)
    if (distWp < arriveR && vertOk && !(finalWp && this.tol === 0 && !bot.onGround && !inWater && !wp.climb)) {
      if (finalWp) {
        if (this.segmenting) {
          if (this.reachedCap()) return
          this.segments++; this.lastProgressAt = nowMs; this.plan(); return
        }
        this.stopMoving()
        return this.finish(`到达 ${wp.x},${wp.y},${wp.z}${this.segments ? ` (分 ${this.segments + 1} 段)` : ''}`)
      }
      if (this.reachedCap()) return
      this.wpIdx++
      this.lastWpProgressAt = nowMs
      return
    }
    // 航点跳跃: 下一航点已比当前近则跳过 (特殊航点不跳)
    if (!finalWp && !wp.climb && !wp.swim) {
      const nxt = this.path[this.wpIdx + 1]
      if (!nxt.place && !nxt.dig && !nxt.door && !nxt.climb && !nxt.waterDrop) {
        const dNext = Math.hypot(nxt.x + 0.5 - bot.pos.x, nxt.z + 0.5 - bot.pos.z)
        if (dNext < distWp - 0.3 && Math.abs(nxt.y - bot.pos.y) < 1.2) { this.wpIdx++; this.lastWpProgressAt = nowMs; return }
      }
    }

    // ---- 总体进展 ----
    const distFinal = Math.hypot(this.target.x - bot.pos.x, (this.target.y ?? bot.pos.y) - bot.pos.y, this.target.z - bot.pos.z)
    if (distFinal < this.lastDist - 0.4) { this.lastDist = distFinal; this.lastProgressAt = nowMs }

    // ---- 朝向 + 控制量 ----
    const targetYaw = Math.atan2(-dx, dz) * 180 / Math.PI
    bot.yaw = lerpAngle(bot.yaw, targetYaw, 0.35)
    bot.pitch = 0
    c.forward = distWp > (wp.climb ? 0.15 : 0.25)
    c.back = false
    c.sneak = false
    c.sprint = !finalWp && distWp > 6 && !inWater
    // 冲刺游泳: 前方连续深水航点够长才用 (进入要先下沉到眼睛没水, 短距离不划算); 快到岸时退出, 普通游上岸
    const swimRun = this.swimRunAhead()
    const sprintSwim = inWater && bot.food > 6 && (bot.swimming ? swimRun >= 3 : swimRun >= 6 && wp.swim)
    if (wp.climb) {
      c.jump = wp.y > bot.pos.y - 0.05 // 梯子上按跳 = 向上爬
      c.sprint = false
    } else if (sprintSwim) {
      c.sprint = true
      if (bot.swimming) this.holdSwimDepth()
      else { c.jump = false; c.sneak = true } // 按 shift 下潜, 眼睛没入水中后进入游泳姿态
    } else if (inWater) {
      c.jump = true // 水里按住跳保持浮在水面 / 上岸
    } else {
      c.jump = wp.y > Math.floor(bot.pos.y) && bot.onGround
      if (!c.jump) c.jump = this.stuckAgainstWall() && bot.onGround && nowMs - this.lastJumpAt > 700
    }
    if (c.jump && bot.onGround) this.lastJumpAt = nowMs

    // ---- 卡住恢复: 侧移 ----
    if (nowMs - this.lastWpProgressAt > 2200 && nowMs - this.lastJumpAt > 900 && bot.onGround && !wp.climb) {
      if (this.strafeUntil < nowMs) { this.strafeUntil = nowMs + 700; this.strafeDir *= -1 }
    }
    const strafing = nowMs < this.strafeUntil
    c.left = strafing && this.strafeDir > 0
    c.right = strafing && this.strafeDir < 0

    // ---- 重规划 ----
    if (nowMs - this.lastWpProgressAt > 5000) {
      if (++this.replans > 5) { this.stopMoving(); return this.fail(`重规划 5 次仍卡在 (${wp.x},${wp.y},${wp.z})`) }
      this.lastWpProgressAt = nowMs
      this.plan()
    }
  }

  /**
   * 单次路程到上限: 在安全落脚点 (地上, 不在水里/梯子上) 停下, 汇报离目标还有多远, 由 agent 看过情况再继续。
   * 返回 true = 已结束。
   */
  private reachedCap (): boolean {
    const max = this.opts.maxDistance
    if (!max || this.traveled < max) return false
    const bot = this.bot
    if (!bot.onGround || bot.physics.inWater || bot.swimming) return false
    const rem = Math.round(Math.hypot(this.target.x - bot.pos.x, this.target.z - bot.pos.z))
    this.stopMoving()
    this.extra = { ...this.extra, arrived: false, traveled: Math.round(this.traveled), remaining: rem }
    this.finish(`未到终点: 本次已走 ${Math.round(this.traveled)} 格 (单次上限 ${max} 格), 停在 ${Math.floor(bot.pos.x)},${Math.floor(bot.pos.y)},${Math.floor(bot.pos.z)}, 离目标 (${Math.floor(this.target.x)},${Math.floor(this.target.z)}) 还有 ${rem} 格。先 get_scene / get_view 看看周围, 再 move_to 继续`)
    return true
  }

  /** 门/栅栏门关着: 停下, 右键打开; 返回 true 表示本 tick 在处理门 */
  private openDoorIfClosed (wp: PathNode, nowMs: number): boolean {
    const w = this.bot.world
    for (const y of [wp.y, wp.y + 1]) {
      const b = w.getBlock(wp.x, y, wp.z)
      if (!b || !isOpenable(b.name)) continue
      if (blockProps(b.stateId).open === 'true') return false
      const k = `${wp.x},${y},${wp.z}`
      if (reachTo(this.bot, wp.x, y, wp.z) > 4) return false // 先走近
      if (nowMs - (this.doorToggledAt.get(k) ?? 0) > 1200) {
        this.doorToggledAt.set(k, nowMs)
        faceTowards(this.bot, wp.x + 0.5, y + 0.5, wp.z + 0.5)
        this.bot.interactBlock(wp.x, y, wp.z)
        this.lastProgressAt = nowMs
      }
      return true
    }
    return false
  }

  /** 挖穿航点; 返回 true 表示本 tick 在挖 (不走) */
  private handleDig (wp: PathNode, nowMs: number): boolean {
    const bot = this.bot
    if (this.digY === null) {
      const cells = digTargets(bot, wp, this.digAllowed)
      // 按方案确认时: 必须挖的格没获批 (地形变了/路径变了) → 不挖, 重新规划
      const bad = this.digAllowed && cells.find(c => !c.optional && !this.digAllowed!(wp.x, c.y, wp.z))
      if (bad) { this.halt(); this.plan(); return true }
      const next = cells[0]
      if (!next) { bot.releaseHand(this.handOwner); return false } // 已挖好, 正常走过去
      this.digY = next.y; this.digName = next.name; this.digSentAt = 0; this.digTries = 0
    }
    const b = bot.world.getBlock(wp.x, this.digY, wp.z)
    if (!b || !blocksWay(b.name)) {
      if (b) this.route.add('dug', this.digName, wp.x, this.digY, wp.z)
      this.digY = null
      this.lastProgressAt = nowMs
      return true // 这格挖完了, 下个 tick 处理下一格
    }
    this.halt()
    if (!this.digSentAt) {
      if (!bot.tryLockHand(this.handOwner)) return true // 手被占用 (如在吃东西)
      const tool = bestToolFor(b.name, toolCandidates(bot))
      if (tool.slot !== null && !prepareHeld(bot, tool.slot)) return true // 工具换到快捷栏中, 下 tick 再挖
      this.digEstMs = Math.min(60_000, tool.ticks * 50 + 150)
      this.digSentAt = nowMs
      this.digStopSent = false
      faceTowards(bot, wp.x + 0.5, this.digY + 0.5, wp.z + 0.5)
      bot.digStart(wp.x, this.digY, wp.z, this.digFace(wp))
      this.lastProgressAt = nowMs
    }
    if (!this.digStopSent && nowMs - this.digSentAt >= this.digEstMs) {
      this.digStopSent = true
      bot.digFinish(wp.x, this.digY, wp.z, this.digFace(wp))
    }
    if (nowMs - this.digSentAt > this.digEstMs + 4000) {
      // 服务器没破坏: 重来一次 (重发 START 会重置进度, 所以只在超时后)
      if (++this.digTries > 2) { this.stopMoving(); this.fail(`挖不动 ${b.name} (${wp.x},${this.digY},${wp.z})`); return true }
      this.digSentAt = 0
    }
    if (nowMs % 300 < 50) bot.swing()
    this.lastProgressAt = Math.max(this.lastProgressAt, nowMs - 15000)
    return true
  }

  /**
   * 落地水 (wp = 落地格, 比当前低 5..32 格; 返回 true = 本 tick 由这里控制):
   * prep 锁手、换上水桶 → fall 走下边缘, 眼睛够得着落地格顶面 (≤4.3) 时对准倒水 (本地世界先放上水, 物理按水里算)
   * → pickup 落地后低头用空桶收回 (水还没来得及流开), 收不回就记进 route。
   * 发 use_item 时服务器按上一个位置包 (= 当前 bot.pos) + 包里的朝向做射线, 所以用当前位置判断够不够得着。
   */
  private handleWaterDrop (wp: PathNode, nowMs: number): boolean {
    const bot = this.bot, c = bot.physics.control
    const key = `${wp.x},${wp.y},${wp.z}`
    if (this.wd?.key !== key) this.wd = { key, phase: 'prep', pouredAt: 0, landedAt: 0, tries: 0, lastTry: 0 }
    const wd = this.wd
    if (wd.phase === 'done') return false
    const target = { x: wp.x + 0.5, y: wp.y, z: wp.z + 0.5 } // 地面方块顶面中心
    const eyeY = bot.pos.y + bot.eyeHeight
    const landed = (bot.onGround || bot.physics.inWater) && bot.pos.y < wp.y + 0.6
    c.sprint = false; c.sneak = false; c.jump = false; c.left = false; c.right = false

    if (wd.phase === 'prep') {
      this.halt()
      if (!bot.tryLockHand(this.handOwner)) return true // 手被占用 (吃东西), 等
      const slot = bot.inventory.find(s => s.name === 'water_bucket')[0]?.slot
      if (slot === undefined) { this.fail('没有水桶了, 跳不下去 (超过 4 格会摔伤)'); return true }
      if (!prepareHeld(bot, slot)) return true
      wd.phase = 'fall'
      this.lastProgressAt = nowMs
    }

    if (wd.phase === 'fall') {
      if (landed) {
        if (!wd.pouredAt) console.warn(`[${bot.name}] 落地水没来得及倒 @ ${key}`)
        wd.phase = wd.pouredAt ? 'pickup' : 'done'
        wd.landedAt = nowMs
        if (wd.phase === 'done') { bot.releaseHand(this.handOwner); return false }
      } else {
        // 水平对准落地列 (走下边缘), 掉下去后停止前进防止撞墙
        const dx = target.x - bot.pos.x, dz = target.z - bot.pos.z
        const dh = Math.hypot(dx, dz)
        c.forward = dh > 0.25
        if (c.forward) bot.yaw = Math.atan2(-dx, dz) * 180 / Math.PI
        const reach = Math.hypot(dx, eyeY - target.y, dz)
        if (!wd.pouredAt && !bot.onGround && bot.pos.y > wp.y + 0.5 && reach <= 4.3) {
          faceTowards(bot, target.x, target.y, target.z)
          if (bot.inventory.held()?.name === 'water_bucket') {
            bot.useItem('main_hand')
            wd.pouredAt = nowMs
            // 本地先放上水源, 物理模拟按水里减速 (服务器的方块更新稍后到, 以它为准)
            const water = blockInfo('water')
            if (water) bot.world.setBlock({ location: { x: wp.x, y: wp.y, z: wp.z }, stateId: water.defaultState ?? water.minStateId })
          }
        }
        this.lastProgressAt = nowMs
        return true
      }
    }

    if (wd.phase === 'pickup') {
      this.halt()
      c.jump = false
      const b = bot.world.getBlock(wp.x, wp.y, wp.z)
      const isSource = b?.name === 'water' && blockProps(b.stateId).level === '0'
      if (!isSource && bot.inventory.held()?.name === 'water_bucket') {
        this.route.waterDrop(wp.x, wp.y, wp.z, true)
        wd.phase = 'done'; bot.releaseHand(this.handOwner); return false
      }
      if (nowMs - wd.landedAt < 100) return true // 等落稳
      if (nowMs - wd.lastTry > 250) {
        if (++wd.tries > 8) {
          // 收不回 (被冲走/服务器拒绝): 水留在原地, 记进 route 让 LLM 知道
          this.route.waterDrop(wp.x, wp.y, wp.z, !isSource)
          wd.phase = 'done'; bot.releaseHand(this.handOwner); return false
        }
        wd.lastTry = nowMs
        const slot = bot.inventory.find(s => s.name === 'bucket')[0]?.slot
        if (slot !== undefined && prepareHeld(bot, slot) && isSource) {
          faceTowards(bot, wp.x + 0.5, wp.y + 0.5, wp.z + 0.5)
          bot.useItem('main_hand')
        }
      }
      this.lastProgressAt = nowMs
      return true
    }
    return false
  }

  /** 搭桥: 目标格下方没支撑就放一块; 返回 true 表示本 tick 在放 */
  private handleBridge (wp: PathNode, nowMs: number): boolean {
    const bot = this.bot
    const support = bot.world.getBlock(wp.x, wp.y - 1, wp.z)
    if (support && !AIRISH.has(support.name) && support.name !== 'water' && !isSoft(support.name)) {
      if (this.placeSentAt) this.route.add('placed', support.name, wp.x, wp.y - 1, wp.z) // 是自己放的 (不是原本就有)
      this.placeSentAt = 0; this.placeTries = 0; return false
    }
    this.halt()
    this.bot.physics.control.sneak = true // 边缘下蹲, 防止掉下去
    return this.placeScaffold(wp.x, wp.y - 1, wp.z, nowMs)
  }

  /** 垫方块上升: 跳起, 升过一格后在原脚下放方块 */
  private handlePillar (wp: PathNode, nowMs: number) {
    const bot = this.bot, c = bot.physics.control
    const baseY = wp.y - 1
    const placed = bot.world.getBlock(wp.x, baseY, wp.z)
    const solid = placed && !AIRISH.has(placed.name) && !isSoft(placed.name)
    if (solid && this.placeSentAt) { this.route.add('placed', placed.name, wp.x, baseY, wp.z); this.placeSentAt = 0; this.placeTries = 0 }
    c.forward = c.left = c.right = c.sprint = false
    if (solid && bot.onGround && bot.pos.y >= wp.y - 0.1) {
      // 已站上新方块
      this.placeSentAt = 0
      this.placeTries = 0
      this.lastWpProgressAt = this.lastProgressAt = nowMs
      if (this.wpIdx < this.path!.length - 1) { this.wpIdx++; return }
      if (this.segmenting) { this.segments++; this.plan(); return }
      this.stopMoving()
      return this.finish(`到达 ${wp.x},${wp.y},${wp.z} (垫高上来)`)
    }
    // 先站到这一列正中 (前一航点按 1.6 格宽松判定, 可能还离得远), 对正了再起跳
    const dx = wp.x + 0.5 - bot.pos.x, dz = wp.z + 0.5 - bot.pos.z
    if (!solid && Math.hypot(dx, dz) > 0.3 && bot.pos.y < baseY + 0.5) {
      bot.yaw = Math.atan2(-dx, dz) * 180 / Math.PI
      bot.pitch = 0
      c.forward = true
      c.sneak = Math.hypot(dx, dz) < 1 // 快到时下蹲慢走, 防冲过头掉下去
      c.jump = false
      if (bot.onGround && nowMs - this.lastJumpAt > 700 && this.stuckAgainstWall()) { c.jump = true; this.lastJumpAt = nowMs }
      return
    }
    c.sneak = false
    bot.pitch = 90
    if (!solid) {
      if (bot.onGround && bot.pos.y < baseY + 0.5) { c.jump = true; this.lastJumpAt = nowMs } else c.jump = false
      if (bot.pos.y >= baseY + 1.0) this.placeScaffold(wp.x, baseY, wp.z, nowMs)
    } else c.jump = false
  }

  /** 在 (x,y,z) 放垫脚方块; 返回 true 表示还在处理 */
  private placeScaffold (x: number, y: number, z: number, nowMs: number): boolean {
    const bot = this.bot
    const blocks = scaffoldSlots(bot)
    if (!blocks.length) { this.stopMoving(); this.fail('没有可用于垫脚/搭桥的方块了'); return true }
    if (!prepareHeld(bot, blocks[0].slot)) return true
    if (nowMs - this.placeSentAt > 600) {
      if (++this.placeTries > 12) { this.stopMoving(); this.fail(`放置方块失败 (${x},${y},${z})`); return true }
      this.placeSentAt = nowMs
      faceTowards(bot, x + 0.5, y + 0.5, z + 0.5)
      placeBlockAt(bot, x, y, z)
      this.lastProgressAt = nowMs
    }
    return true
  }

  private digFace (wp: PathNode): number {
    if (wp.dig === 'down') return 1 // 挖脚下: 点顶面
    const dx = wp.x + 0.5 - this.bot.pos.x
    const dz = wp.z + 0.5 - this.bot.pos.z
    return Math.abs(dx) > Math.abs(dz) ? (dx > 0 ? 4 : 5) : (dz > 0 ? 2 : 3)
  }

  private stuckAgainstWall (): boolean {
    const yawRad = this.bot.yaw * Math.PI / 180
    const fx = Math.floor(this.bot.pos.x - Math.sin(yawRad))
    const fz = Math.floor(this.bot.pos.z + Math.cos(yawRad))
    const fy = Math.floor(this.bot.pos.y)
    return this.bot.world.isSolid(fx, fy, fz) || this.bot.world.isSolid(fx, fy + 1, fz)
  }

  /** 从当前航点起连续深水 (游泳) 航点数 */
  private swimRunAhead () {
    let n = 0
    for (let i = this.wpIdx; i < (this.path?.length ?? 0) && this.path![i].swim; i++) n++
    return n
  }

  /**
   * 游泳姿态下保持在水面: 身体顶部露出、眼睛 (眼高 0.4) 刚好在水面上能换气。
   * 高了低头下潜 (视线 y 分量决定竖直速度), 低了按跳上浮。
   */
  private holdSwimDepth () {
    const bot = this.bot, c = bot.physics.control
    const x = Math.floor(bot.pos.x), z = Math.floor(bot.pos.z)
    let by = Math.floor(bot.pos.y)
    for (let i = 0; i < 4 && fluidHeight(bot.world, x, by + 1, z) > 0; i++) by++
    const f = fluidHeight(bot.world, x, by, z)
    if (!f) { c.jump = false; bot.pitch = 0; return }
    // 目标: 箱底在水面下 0.15 (眼睛 = 箱底 +0.4 露出水面可换气; 箱底低于水面才算在水里, 否则会退出游泳姿态)
    // 不操作时竖直速度每 tick 约衰减到 0.75 倍, 还会再漂 ≈3.2·vy; 按预测的停稳位置决定上浮/下潜, 避免冲出水面来回振荡
    const pred = bot.pos.y - (by + f - 0.15) + bot.physics.velocity.y * 3.2
    c.sneak = false
    if (pred < -0.05) { bot.pitch = 0; c.jump = true } else if (pred > 0.05) { bot.pitch = Math.min(25, 4 + pred * 40); c.jump = false } else { bot.pitch = 0; c.jump = false }
  }

  /** 原地停住 (不结束动作) */
  private halt () {
    const c = this.bot.physics.control
    c.forward = c.back = c.left = c.right = c.sprint = false
    c.jump = this.bot.physics.inWater
  }

  private stopMoving () {
    const c = this.bot.physics.control
    c.forward = c.back = c.left = c.right = c.jump = c.sprint = c.sneak = false
    this.bot.releaseHand(this.handOwner)
  }

  // 结束时把实际改动的地形写进 detail 和 extra.route
  cancel (reason = '') {
    if (this.status !== 'running') return
    super.cancel(settleWithRoute(this, this.route, reason))
    this.stopMoving()
  }

  finish (detail = '') { if (this.status !== 'running') return; this.bot.releaseHand(this.handOwner); super.finish(settleWithRoute(this, this.route, detail)) }
  fail (detail = '') { if (this.status !== 'running') return; this.stopMoving(); super.fail(settleWithRoute(this, this.route, detail)) }
}

function lerpAngle (a: number, b: number, t: number) {
  const d = ((b - a + 540) % 360) - 180
  return a + d * t
}

// ---------- 挖掘 ----------

export class DigAction extends AsyncAction {
  private owner = `dig#${this.id}`
  constructor (bot: BotAgent, private x: number, private y: number, private z: number) { super(bot, 'dig') }

  /** 选一个暴露的面 (法线朝向 agent 且相邻格是空气), 否则顶面 */
  private pickFace (): number {
    const { x, y, z } = this
    const dx = x + 0.5 - this.bot.pos.x, dy = y + 0.5 - (this.bot.pos.y + 1.62), dz = z + 0.5 - this.bot.pos.z
    const air = (ax: number, ay: number, az: number) => { const b = this.bot.world.getBlock(ax, ay, az); return !b || AIRISH.has(b.name) || isSoft(b.name) }
    // face: 0=-y 1=+y 2=-z 3=+z 4=-x 5=+x
    const cands: [number, number, number, number, number][] = [
      [dx > 0 ? 4 : 5, Math.abs(dx), dx > 0 ? -1 : 1, 0, 0],
      [dz > 0 ? 2 : 3, Math.abs(dz), 0, 0, dz > 0 ? -1 : 1],
      [dy > 0 ? 0 : 1, Math.abs(dy), 0, dy > 0 ? -1 : 1, 0],
    ]
    cands.sort((a, b) => b[1] - a[1])
    for (const [f, , ox, oy, oz] of cands) if (air(x + ox, y + oy, z + oz)) return f
    return 1
  }

  protected async run () {
    const { x, y, z, bot } = this
    const b = bot.world.getBlock(x, y, z)
    if (!b || AIRISH.has(b.name)) throw new Error(`(${x},${y},${z}) 没有可挖方块`)
    if (b.name === 'water' || b.name === 'lava') throw new Error(`(${x},${y},${z}) 是 ${b.name}, 挖不了`)
    // 挖穿进岩浆是最常见的死法: 旁边/上方有岩浆就不挖
    const lavaSide = [[1, 0, 0], [-1, 0, 0], [0, 0, 1], [0, 0, -1], [0, 1, 0]].find(([ox, oy, oz]) => bot.world.getBlock(x + ox, y + oy, z + oz)?.name === 'lava')
    if (lavaSide) throw new Error(`(${x},${y},${z}) 旁边有岩浆 (${x + lavaSide[0]},${y + lavaSide[1]},${z + lavaSide[2]}), 挖开会流出来, 不挖`)
    if (!canReach(bot, x, y, z)) throw new Error(`距离 ${boxDist(eyeOf(bot), x, y, z).toFixed(1)} 超出触及范围 ${REACH}`)
    await this.until(() => bot.tryLockHand(this.owner), 5000, '手空闲')
    const tool = bestToolFor(b.name, toolCandidates(bot))
    if (!Number.isFinite(tool.ticks)) throw new Error(`${b.name} 不可破坏`)
    if (tool.slot !== null) await holdSlot(this, bot, tool.slot)
    const estMs = tool.ticks * 50 + 150
    faceTowards(bot, x + 0.5, y + 0.5, z + 0.5)
    await this.sleep(60) // 朝向随下一 tick 发出
    const face = this.pickFace()
    const t0 = Date.now()
    bot.digStart(x, y, z, face)
    let stopSent = false, lastSwing = 0
    for (;;) {
      const now = Date.now()
      const cur = bot.world.getBlock(x, y, z)
      if (!cur || cur.name !== b.name) {
        const how = tool.name ? `用 ${tool.name}` : '空手'
        return `已挖掉 ${b.name} (${x},${y},${z}) ${how}, ${((now - t0) / 1000).toFixed(1)}s${tool.harvest ? '' : ' (工具不对, 不会掉落)'}`
      }
      if (now - lastSwing > 300) { lastSwing = now; bot.swing() }
      // 不重发 START (会重置服务器进度)
      if (!stopSent && now - t0 >= estMs) { stopSent = true; bot.digFinish(x, y, z, face) }
      if (now - t0 > estMs + 5000) throw new Error(`方块未变化 (预计 ${(estMs / 1000).toFixed(1)}s)`)
      await this.sleep(50)
    }
  }

  protected cleanup () { this.bot.releaseHand(this.owner) }
}

// ---------- 放置 ----------

export class PlaceAction extends AsyncAction {
  constructor (bot: BotAgent, private x: number, private y: number, private z: number, private face: number, private opts: { hotbar?: number, item?: string } = {}) { super(bot, 'place') }

  protected async run () {
    const { x, y, z, bot } = this
    const b = bot.world.getBlock(x, y, z)
    if (b && !AIRISH.has(b.name) && !isSoft(b.name) && b.name !== 'water') throw new Error(`(${x},${y},${z}) 已有方块 ${b.name}`)
    if (!canReach(bot, x, y, z)) throw new Error(`距离 ${boxDist(eyeOf(bot), x, y, z).toFixed(1)} 超出触及范围 ${REACH}`)
    if (this.opts.item) await holdItem(this, bot, this.opts.item)
    else if (this.opts.hotbar !== undefined) await holdSlot(this, bot, hotbarSlot(this.opts.hotbar))
    const held = bot.inventory.held()
    if (!held) throw new Error('手里没有东西可放')
    faceTowards(bot, x + 0.5, y + 0.5, z + 0.5)
    await this.sleep(60)
    placeBlockAt(bot, x, y, z, this.face)
    await this.until(() => { const n = bot.world.getBlock(x, y, z); return !!n && !AIRISH.has(n.name) && n.name !== 'water' }, 1500, `${held.name} 放置生效`)
    return `已在 (${x},${y},${z}) 放置 ${bot.world.getBlock(x, y, z)!.name}`
  }
}

// ---------- 攻击 ----------

// ---------- 库存 / 容器 ----------

export class SelectSlotAction extends Action {
  constructor (private bot: BotAgent, private slot: number) { super('select_slot') }
  start () {
    if (this.slot < 0 || this.slot > 8) return this.fail('slot 须为 0-8 (快捷栏)')
    this.bot.selectSlot(this.slot) // held_item_slot 取快捷栏下标 0-8 (不是窗口槽位 36-44)
    this.finish(`已选中快捷栏 ${this.slot}`)
  }
  step () {}
}

export class OpenContainerAction extends AsyncAction {
  constructor (bot: BotAgent, private x: number, private y: number, private z: number) { super(bot, 'open_container') }
  protected async run () {
    const { bot, x, y, z } = this
    if (!canReach(bot, x, y, z)) throw new Error(`距离 ${boxDist(eyeOf(bot), x, y, z).toFixed(1)} 超出触及范围 ${REACH}`)
    closeContainer(bot)
    await holdNothing(this, bot) // 防止把手里的方块放上去
    faceTowards(bot, x + 0.5, y + 0.5, z + 0.5)
    await this.sleep(60)
    bot.interactBlock(x, y, z)
    await this.until(() => bot.inventory.activeWindowId !== null, 3000, '容器打开')
    const w = bot.inventory.windows.get(bot.inventory.activeWindowId!)
    await this.until(() => (w?.slots.length ?? 0) > 0, 1500, '容器内容')
    bot.openedContainer = { windowId: bot.inventory.activeWindowId!, block: bot.world.getBlock(x, y, z)?.name ?? '容器', x, y, z }
    return `容器已打开 (窗口${bot.inventory.activeWindowId}, ${w?.slots.length ?? 0} 槽)`
  }
}

export class ChestOpAction extends Action {
  /** mode: take(从活动窗口拿) | put(放入活动窗口) */
  private phase: string
  constructor (private bot: BotAgent, initial: 'take' | 'put' | 'deposit', private slot: number) {
    super(`chest_${initial}`)
    this.phase = initial
  }
  private clickedAt = 0
  start () {
    const wid = this.bot.inventory.activeWindowId
    if (wid === null) return this.fail('没有打开的容器')
  }
  step (nowMs: number) {
    if (this.clickedAt && nowMs - this.clickedAt < 600) return
    const wid = this.bot.inventory.activeWindowId
    if (wid === null) return this.fail('容器已被关闭')
    const w = this.bot.inventory.windows.get(wid)
    const size = containerSize(w?.slots.length ?? 27 + PLAYER_STORAGE) // 容器自身格数 (单箱 27, 大箱 54)
    // 窗口布局: 0..size-1 容器, size..size+26 背包, size+27..size+35 快捷栏
    if (this.phase === 'take') {
      if (this.slot < 0 || this.slot >= size) return this.fail(`take 槽位须为 0-${size - 1} (容器区), 收到 ${this.slot}`)
      if (!w?.slots[this.slot]) return this.fail(`容器槽位 ${this.slot} 是空的`)
      this.bot.clickSlot(wid, this.slot, 0, 1) // shift 点击: 直接进背包
      this.clickedAt = nowMs
      this.phase = 'done'
      return
    }
    if (this.phase === 'put') {
      // slot = 玩家背包槽(9-44) → 窗口坐标 size + (slot - 9)
      if (this.slot < SLOT.main || this.slot > LAST_STORAGE) return this.fail(`put 槽位须为 ${SLOT.main}-${LAST_STORAGE} (玩家物品)`)
      if (!this.bot.inventory.slots[this.slot]) return this.fail(`背包槽位 ${this.slot} 是空的`)
      this.bot.clickSlot(wid, toWindowSlot(this.slot, size), 0, 1) // shift 点击: 直接进容器
      this.clickedAt = nowMs
      this.phase = 'done'
      return
    }
    if (this.phase === 'done') return this.finish('操作完成')
  }
}

export class DropItemAction extends Action {
  constructor (private bot: BotAgent, private slot: number, private all: boolean) { super('drop_item') }
  start () {
    if (!this.bot.inventory.slots[this.slot]) return this.fail(`槽位 ${this.slot} 为空`)
    closeContainer(this.bot)
    this.bot.clickSlot(0, this.slot, this.all ? 1 : 0, 4) // mode 4 = drop
    this.finish(`已丢弃槽位 ${this.slot}${this.all ? ' 整组' : ' 单个'}`)
  }
  step () {}
}

export class CloseWindowAction extends Action {
  constructor (private bot: BotAgent) { super('close_window') }
  start () {
    const wid = this.bot.inventory.activeWindowId
    if (wid === null) return this.finish('本就没有打开的窗口')
    this.bot.closeWindow(wid)
    this.finish(`已关闭窗口 ${wid}`)
  }
  step () {}
}

// ---------- 简单动作 ----------

export class JumpAction extends Action {
  constructor (private bot: BotAgent) { super('jump') }
  start () { this.bot.physics.control.jump = true }
  step () { this.bot.physics.control.jump = false; this.finish('跳') }
}

export class StopAction extends Action {
  constructor (private bot: BotAgent) { super('stop') }
  start () {
    const c = this.bot.physics.control
    c.forward = c.back = c.left = c.right = c.jump = c.sprint = c.sneak = false
    this.bot.cancelActions('被 stop 停止')
    this.finish('已停止所有动作')
  }
  step () {}
}
