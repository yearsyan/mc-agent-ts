/**
 * 多步任务 (AsyncAction): 合成 / 熔炼 / 采集 / 拾取 / 装备 / 进食 / 使用物品与方块 / 睡觉 / 实体交互 / 村民交易。
 * 需要工作台/熔炉时: 触及范围内有就用, 32 格内有就走过去, 背包里有就就地放一个。
 */
import type { BotAgent } from '../conn/bot.js'
import { AsyncAction } from './base.js'
import { MoveToAction, DigAction, PlaceAction, scaffoldSlots, toolCandidates, type MoveOptions } from './actions.js'
import { RouteLog, settleWithRoute, proposalCost, type RouteProposal, type Approval } from './route.js'
import { standableCell } from './astar.js'
import { holdSlot, holdItem, holdNothing, closeContainer, faceTowards, canReach, canSee, boxDist, eyeOf, REACH } from './hands.js'
import type { Action } from './base.js'
import { SLOT, PLAYER_STORAGE, SWAP_OFFHAND_BUTTON, containerSize, toWindowSlot } from '../conn/inventory.js'
import { mcData, itemName, itemId, foodScore, fuelTicks, blockProps, bestToolFor, harvestToolNames, isNaturalBlock } from '../game/knowledge.js'

const AIRISH = new Set(['air', 'cave_air', 'void_air'])
const BED_COLORS = ['white', 'orange', 'magenta', 'light_blue', 'yellow', 'lime', 'pink', 'gray', 'light_gray', 'cyan', 'purple', 'blue', 'brown', 'green', 'red', 'black']

// ---------- 共用: 接近方块 / 找或放工作方块 ----------

/**
 * 能站、且从那里够得着 (x,y,z) 的位置 (水平 ±4, 竖直按触及距离自然过滤: 目标下方最多约 6 格)。
 * 能看见目标 (视线不被挡) 的排前面, 其次离 bot 近的; 同一列只取目标下方 ≥2 格 (仰头挖, 不挖脚下)。
 * maxReach 比 REACH 小一点: 走到站位允许 ~0.4 的偏差。
 */
export function approachSpots (bot: BotAgent, x: number, y: number, z: number, maxReach = REACH - 0.4): { x: number, y: number, z: number, visible: boolean }[] {
  const out: { x: number, y: number, z: number, visible: boolean, d: number }[] = []
  for (let dx = -4; dx <= 4; dx++) for (let dz = -4; dz <= 4; dz++) for (let dy = -6; dy <= 2; dy++) {
    if (dx === 0 && dz === 0 && dy > -2) continue
    const sx = x + dx, sy = y + dy, sz = z + dz
    const eye = { x: sx + 0.5, y: sy + 1.62, z: sz + 0.5 }
    if (boxDist(eye, x, y, z) > maxReach) continue
    if (!standableCell(bot.world, sx, sy, sz)) continue
    out.push({ x: sx, y: sy, z: sz, visible: canSee(bot.world, eye, x, y, z), d: Math.hypot(sx + 0.5 - bot.pos.x, (sy - bot.pos.y) * 1.5, sz + 0.5 - bot.pos.z) })
  }
  return out.sort((a, b) => Number(b.visible) - Number(a.visible) || a.d - b.d).map(({ x, y, z, visible }) => ({ x, y, z, visible }))
}
export const approachSpot = (bot: BotAgent, x: number, y: number, z: number) => approachSpots(bot, x, y, z)[0] ?? null

/**
 * 够不着时的备选: 在目标旁边的一列垫方块上去 (如高处的树干)。
 * 返回站立格 (由 MoveTo 规划 pillar 上升), 需要背包里有足够的垫脚方块。
 */
export function pillarSpot (bot: BotAgent, x: number, y: number, z: number, have = scaffoldSlots(bot).reduce((n, h) => n + h.item.count, 0)): { x: number, y: number, z: number } | null {
  let best: { x: number, y: number, z: number } | null = null, bestD = Infinity
  // 旁边 4 列: 站到与目标同高附近; 目标自身这列 (如已挖空的树干): 站到目标下方 2 格仰头挖
  for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1], [0, 0]]) {
    const cx = x + dx, cz = z + dz, ty = dx === 0 && dz === 0 ? y - 2 : y - 1
    let gy: number | null = null
    for (let yy = ty; yy >= ty - 12; yy--) if (standableCell(bot.world, cx, yy, cz)) { gy = yy; break }
    if (gy === null || ty - gy > have) continue
    let clear = true // 上升路径 (gy..ty+1) 必须是空的
    for (let yy = gy; yy <= ty + 1 && clear; yy++) { const n = bot.world.getBlock(cx, yy, cz)?.name; clear = !!n && AIRISH.has(n) }
    if (!clear) continue
    const d = Math.hypot(cx - bot.pos.x, cz - bot.pos.z) + (ty - gy)
    if (d < bestD) { bestD = d; best = { x: cx, y: ty, z: cz } }
  }
  return best
}

/** 埋在地下的目标: 目标旁边 (同高) 的实心格, 让 MoveTo 挖过去站进去; 按离 bot 远近 */
function digInSpots (bot: BotAgent, x: number, y: number, z: number): { x: number, y: number, z: number }[] {
  return [[1, 0], [-1, 0], [0, 1], [0, -1]]
    .map(([dx, dz]) => ({ x: x + dx, y, z: z + dz }))
    .filter(c => {
      const below = bot.world.getBlock(c.x, c.y - 1, c.z)?.name
      return !!below && !AIRISH.has(below) && below !== 'lava' && below !== 'water'
    })
    .sort((a, b) => Math.hypot(a.x - bot.pos.x, a.y - bot.pos.y, a.z - bot.pos.z) - Math.hypot(b.x - bot.pos.x, b.y - bot.pos.y, b.z - bot.pos.z))
    .slice(0, 2)
}

/** 方块有没有暴露面 (6 个邻格里有非实心的) */
function exposed (bot: BotAgent, x: number, y: number, z: number) {
  return [[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1]].some(([dx, dy, dz]) => !bot.world.isSolid(x + dx, y + dy, z + dz))
}

/**
 * 走到能够着并看得见 (x,y,z) 的位置; 返回站位说明 ("" = 原地就行)。
 * - 当前位置够得着且看得见 → 不动
 * - 够得着但隔着方块 → 去附近看得见的站位; 附近没有就原地隔着操作 (服务器不校验视线), 结果里注明
 * - 够不着 → 只走现成的路试接近点 (看得见的优先); 获准改地形 (allow_* / confirm) 才垫高/挖进去;
 *   未获准又走不到时, 算出改动最少的挖/搭方案放进任务的 extra.proposals 并失败, 由 LLM 决定
 */
async function reachBlock (act: Task, bot: BotAgent, x: number, y: number, z: number, what: string, within?: (feet: { x: number, y: number, z: number }) => boolean): Promise<string> {
  // within: 额外的站位约束 (如床要求脚在床 3 格内), 按脚的位置判断
  const inRange = (p: { x: number, y: number, z: number }) => !within || within(p)
  const spotOk = (s: { x: number, y: number, z: number }) => inRange({ x: s.x + 0.5, y: s.y, z: s.z + 0.5 })
  const reached = () => canReach(bot, x, y, z) && inRange(bot.pos)
  const here = reached()
  if (here && canSee(bot.world, eyeOf(bot), x, y, z)) return ''
  const { allowDig, allowPlace, approved } = act.moveOpts
  const canDig = allowDig || !!approved?.dig.size, canPlace = allowPlace || !!approved?.place.size
  const all = approachSpots(bot, x, y, z).filter(spotOk)
  const approach = (here ? all.filter(s => s.visible) : all).slice(0, 3)
  let err = ''
  const at = (s: { x: number, y: number, z: number }, seen = canSee(bot.world, eyeOf(bot), x, y, z)) =>
    `站到 (${s.x},${s.y},${s.z}) 操作${seen ? '' : ' (看不到它, 隔着方块)'}`
  const tryAll = async (spots: { x: number, y: number, z: number }[], opts: MoveOptions) => {
    for (const spot of spots) {
      const mv = await act.subMove(spot, { tolerance: 0, ...opts })
      if (mv.status === 'done' && reached()) return at(spot)
      err = mv.status === 'done' ? '到了但还是够不着' : mv.detail
    }
    return null
  }
  // 第一轮: 只走现成的路 (有的接近点看似能站却到不了, 如树冠上)
  const r1 = await tryAll(approach, { allowDig: false, allowPlace: false })
  if (r1) return r1
  if (here) return '原地操作 (看不到它, 附近也没有看得见的站位, 隔着方块)'
  const pillar0 = pillarSpot(bot, x, y, z)
  const pillar = pillar0 && spotOk(pillar0) ? pillar0 : null
  const digIn = digInSpots(bot, x, y, z).filter(spotOk)
  // 第二轮: 已获准改地形 (整趟允许或按方案确认), 带权限再试 (接近点 → 垫高点 → 挖进去)
  if (canDig || canPlace) {
    const spots = [...approach, ...(canPlace && pillar ? [pillar] : []), ...(canDig ? digIn : [])]
    if (!spots.length) throw new Error(`${what} (${x},${y},${z}) 够不着: 周围没有能站/能垫高/能挖进去的位置${canPlace && !scaffoldSlots(bot).length ? ' (背包没有泥土/圆石, 垫不了)' : ''}`)
    const r2 = await tryAll(spots, {})
    if (r2) return r2
    throw new Error(`走到${what}失败: ${err}`)
  }
  // 未获准: 对垫高点/挖进点/最近接近点算方案, 取最好的
  const hypo = pillar ?? pillarSpot(bot, x, y, z, 64)
  const cands = [hypo && spotOk(hypo) ? hypo : null, digIn[0], approach[0]]
    .filter((c): c is { x: number, y: number, z: number } => !!c).slice(0, 2)
  let best: { mv: MoveToAction, props: RouteProposal[] } | null = null
  // 有推荐方案的优先, 其次改动最少
  const cost = (ps: RouteProposal[]) => Math.min(...ps.map(p => (p.recommended ? 0 : 1000) + proposalCost(p)))
  for (const spot of cands) {
    const mv = await act.subMove(spot, { tolerance: 0, allowDig: false, allowPlace: false, propose: true })
    if (mv.status === 'done' && reached()) return at(spot)
    const props = (mv.extra?.proposals as RouteProposal[] | undefined) ?? []
    if (props.length && (!best || cost(props) < cost(best.props))) best = { mv, props }
    else if (!best) err = mv.status === 'done' ? '到了但还是够不着' : mv.detail
  }
  if (best) {
    act.extra = { ...act.extra, proposals: best.props }
    throw new Error(`${what} (${x},${y},${z}) 只走现成的路够不着, 要改地形: ${best.mv.detail}`)
  }
  throw new Error(`走到${what}失败: ${err || '周围没有能站的位置'}`)
}

/** 带 subMove 的任务基类 */
export abstract class Task extends AsyncAction {
  /** 寻路能否改地形 (act 参数 allow_dig / allow_place / confirm 传入; 默认都不允许) */
  moveOpts: { allowDig?: boolean, allowPlace?: boolean, approved?: Approval } = {}
  /** 各段寻路实际改动的地形 (汇总) */
  readonly route = new RouteLog()
  private curMove: MoveToAction | null = null

  /** 走到 t; 默认继承任务的改地形权限, 不算方案 (要方案的调用方传 propose:true) */
  async subMove (t: { x: number, y?: number, z: number }, opts: MoveOptions = {}) {
    const mv = new MoveToAction(this.bot, t, { ...this.moveOpts, propose: false, ...opts })
    this.curMove = mv
    try {
      return await this.sub(mv)
    } finally {
      this.route.merge(mv.route)
      this.curMove = null
    }
  }

  // 结束时把寻路改动的地形写进 detail 和 extra.route (取消时子寻路可能还没汇总, 先并进来)
  private settle (detail: string) {
    if (this.curMove) this.route.merge(this.curMove.route)
    return settleWithRoute(this, this.route, detail)
  }
  finish (detail = '') { if (this.status === 'running') super.finish(this.settle(detail)) }
  fail (detail = '') { if (this.status === 'running') super.fail(this.settle(detail)) }
  cancel (reason = '') { if (this.status === 'running') super.cancel(this.settle(reason)) }

  /** 找到/走到/放置一个工作方块 (工作台/熔炉/附魔台/铁砧; 可给多个方块名, 放置用第一个背包里有的), 返回其坐标 */
  protected async ensureStation (blocks: string | string[], label: string): Promise<{ x: number, y: number, z: number }> {
    const bot = this.bot
    const names = Array.isArray(blocks) ? blocks : [blocks]
    const d = (b: { x: number, y: number, z: number }) => Math.hypot(b.x + 0.5 - bot.pos.x, b.y - bot.pos.y, b.z + 0.5 - bot.pos.z)
    const near = names.flatMap(n => bot.world.findBlock(n, Math.floor(bot.pos.x), Math.floor(bot.pos.z), 32, 5, Math.floor(bot.pos.y))).sort((a, b) => d(a) - d(b))
    const inReach = near.find(b => canReach(bot, b.x, b.y, b.z) && canSee(bot.world, eyeOf(bot), b.x, b.y, b.z))
    if (inReach) return inReach
    if (near.length) {
      const t = near[0]
      await reachBlock(this, bot, t.x, t.y, t.z, label)
      return t
    }
    const block = names.find(n => bot.inventory.count(n) > 0)
    if (!block) throw new Error(`需要${label}: 32 格内没有, 背包里也没有 ${names[0]}`)
    // 就地放一个: 选身边一个空格 (脚下实心, 不是自己站的格)
    const bx = Math.floor(bot.pos.x), by = Math.floor(bot.pos.y), bz = Math.floor(bot.pos.z)
    for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [-1, -1], [1, -1], [-1, 1]]) {
      const x = bx + dx, z = bz + dz
      const cell = bot.world.getBlock(x, by, z), below = bot.world.getBlock(x, by - 1, z)
      if (!cell || !below || !AIRISH.has(cell.name) || AIRISH.has(below.name) || below.name === 'water') continue
      const p = await this.sub(new PlaceAction(bot, x, by, z, 1, { item: block }))
      if (p.status === 'done') return { x, y: by, z }
    }
    throw new Error(`身边没有地方放${label}`)
  }

  /** 右键打开工作方块, 等窗口内容到达; 返回窗口 id */
  protected async openAt (x: number, y: number, z: number, minSlots: number, label: string): Promise<number> {
    const bot = this.bot
    closeContainer(bot)
    await holdNothing(this, bot)
    faceTowards(bot, x + 0.5, y + 0.5, z + 0.5)
    await this.sleep(60)
    bot.interactBlock(x, y, z)
    await this.until(() => bot.inventory.activeWindowId !== null, 3000, `${label}打开`)
    const wid = bot.inventory.activeWindowId!
    await this.until(() => (bot.inventory.windows.get(wid)?.slots.length ?? 0) >= minSlots, 2000, `${label}内容`)
    return wid
  }

  /** 窗口 wid 的某格 */
  protected winSlot (wid: number, slot: number) {
    return wid === 0 ? this.bot.inventory.slots[slot] : this.bot.inventory.windows.get(wid)?.slots[slot] ?? null
  }

  /**
   * 从背包取 n 个 name 放进窗口 wid 的 target 格 (左键拿整组 → 右键逐个放 → 左键放回剩余)。
   * toWin: 玩家槽 (9-44) → 窗口槽 的映射。
   */
  protected async putItems (wid: number, toWin: (s: number) => number, name: string, target: number, n: number, exclude: number[] = []) {
    const bot = this.bot
    let placed = 0
    while (placed < n) {
      const src = bot.inventory.find(s => s.name === name).find(h => !exclude.includes(h.slot))
      if (!src) throw new Error(`${name} 不够 (还差 ${n - placed})`)
      const c = src.item.count
      const k = Math.min(n - placed, c)
      const before = this.winSlot(wid, target)?.count ?? 0
      bot.clickSlot(wid, toWin(src.slot), 0, 0) // 拿起整组
      if (k === c) bot.clickSlot(wid, target, 0, 0) // 全放
      else {
        for (let i = 0; i < k; i++) bot.clickSlot(wid, target, 1, 0) // 右键放 1 个
        bot.clickSlot(wid, toWin(src.slot), 0, 0) // 剩余放回
      }
      await this.until(() => (this.winSlot(wid, target)?.count ?? 0) >= before + k, 2000, `${name} 放入`)
      placed += k
    }
  }

  /**
   * 把玩家槽 src (9-45) 里的 n 个放进窗口 wid 的 target 格 (n 缺省 = 整组)。
   * 用于必须指定"哪一件"的场合 (附魔/铁砧: 同名工具可能有好几把)。
   */
  protected async putFrom (wid: number, toWin: (s: number) => number, src: number, target: number, n?: number) {
    const bot = this.bot
    const it = bot.inventory.slots[src]
    if (!it) throw new Error(`槽位 ${src} 是空的`)
    const k = Math.min(n ?? it.count, it.count)
    const before = this.winSlot(wid, target)?.count ?? 0
    bot.clickSlot(wid, toWin(src), 0, 0) // 拿起整组
    if (k === it.count) bot.clickSlot(wid, target, 0, 0)
    else {
      for (let i = 0; i < k; i++) bot.clickSlot(wid, target, 1, 0) // 右键放 1 个
      bot.clickSlot(wid, toWin(src), 0, 0) // 剩余放回原格
    }
    await this.until(() => (this.winSlot(wid, target)?.count ?? 0) > before, 2000, `${it.name} 放入`)
    await this.sleep(150)
    if (bot.inventory.cursor) await this.stowCursor(wid, toWin) // 目标格放不下的 (如附魔台只收 1 个) 放回背包
  }

  /** 把光标上的物品放回背包 (同类可合并的堆优先, 否则空格) */
  protected async stowCursor (wid: number, toWin: (s: number) => number) {
    const bot = this.bot
    const cur = bot.inventory.cursor
    if (!cur) return
    const same = bot.inventory.find(s => s.name === cur.name && s.count < 64)[0]
    const empty = [...Array(PLAYER_STORAGE).keys()].map(i => SLOT.main + i).find(i => !bot.inventory.slots[i])
    const dst = same?.slot ?? empty
    if (dst === undefined) throw new Error('背包满了, 光标上的物品放不回去')
    const before = bot.inventory.slots[dst]?.count ?? 0
    bot.clickSlot(wid, toWin(dst), 0, 0)
    // 服务器状态与我们点击时声明的一致 (光标已空) 时不会再发光标更新, 所以看目标格有没有收到
    await this.until(() => bot.inventory.slots[dst]?.name === cur.name && bot.inventory.slots[dst]!.count > before, 1500, '光标物品放回')
    bot.inventory.cursor = null
  }
}

// ---------- 合成 ----------

interface Recipe { w: number, h: number, cells: (number | null)[], resultId: number, resultCount: number, needs: Map<number, number> }

function parseRecipe (r: any): Recipe | null {
  const pick = (v: any): number | null => Array.isArray(v) ? (v[0] ?? null) : (v ?? null)
  const needs = new Map<number, number>()
  let w: number, h: number, cells: (number | null)[]
  if (r.inShape) {
    h = r.inShape.length; w = Math.max(...r.inShape.map((row: any[]) => row.length))
    cells = []
    for (const row of r.inShape) for (let c = 0; c < w; c++) cells.push(pick(row[c]))
  } else if (r.ingredients) {
    cells = r.ingredients.map(pick)
    const n = cells.length
    w = n <= 1 ? 1 : n <= 4 ? 2 : 3; h = Math.ceil(n / w)
  } else return null
  for (const id of cells) if (id !== null) needs.set(id, (needs.get(id) ?? 0) + 1)
  return { w, h, cells, resultId: r.result.id, resultCount: r.result.count ?? 1, needs }
}

export class CraftAction extends Task {
  private wid: number | null = null
  constructor (bot: BotAgent, private item: string, private count = 1) { super(bot, 'craft') }

  protected async run () {
    const bot = this.bot
    const id = itemId(this.item)
    if (id === undefined) throw new Error(`未知物品 ${this.item}`)
    const recipes: Recipe[] = (mcData.recipes[id] ?? []).map(parseRecipe).filter(Boolean)
    if (!recipes.length) throw new Error(`${this.item} 没有工作台配方 (可能要熔炉/切石机/锻造台, 或是天然物品)`)
    const have = (iid: number) => bot.inventory.count(itemName(iid))
    // 选材料够的配方; 都不够时报缺什么 (按缺得最少的配方)
    let chosen: Recipe | null = null, batches = 0
    const shortfalls: { n: number, text: string }[] = []
    for (const r of recipes) {
      const b = Math.ceil(this.count / r.resultCount)
      const missing = [...r.needs].filter(([iid, n]) => have(iid) < n * b).map(([iid, n]) => ({ name: itemName(iid), n: n * b - have(iid) }))
      if (!missing.length) { if (!chosen || (r.w <= 2 && r.h <= 2 && !(chosen.w <= 2 && chosen.h <= 2))) { chosen = r; batches = b } continue }
      shortfalls.push({ n: missing.reduce((s, m) => s + m.n, 0), text: missing.map(m => `${m.name}×${m.n}`).join(', ') })
    }
    if (!chosen) {
      // 列出缺得最少的几种配方 (同一物品常有多种材料变体, 如圆石/深板岩圆石)
      shortfalls.sort((a, b) => a.n - b.n)
      const opts = [...new Set(shortfalls.map(s => s.text))].slice(0, 3)
      throw new Error(`材料不足, 还缺: ${opts.join(' 或 ')}`)
    }
    const r = chosen
    const small = r.w <= 2 && r.h <= 2

    let wid = 0, gridW = 2
    let toWin = (s: number) => s
    if (!small) {
      const t = await this.ensureStation('crafting_table', '工作台')
      wid = this.wid = await this.openAt(t.x, t.y, t.z, 46, '工作台')
      gridW = 3
      toWin = (s: number) => toWindowSlot(s, 10) // 工作台窗口: 0 产物, 1-9 网格, 之后是玩家物品
    } else closeContainer(bot)

    const resultName = itemName(r.resultId)
    const before = bot.inventory.count(resultName)
    let left = batches
    while (left > 0) {
      this.check()
      const n = Math.min(left, 16)
      // 网格槽位 → 物品; 无序配方按顺序填
      const cells: { slot: number, name: string }[] = []
      for (let i = 0; i < r.cells.length; i++) {
        const iid = r.cells[i]
        if (iid === null) continue
        const row = Math.floor(i / r.w), col = i % r.w
        cells.push({ slot: 1 + row * gridW + col, name: itemName(iid) })
      }
      for (const c of cells) await this.putItems(wid, toWin, c.name, c.slot, n)
      await this.until(() => this.winSlot(wid, 0)?.name === resultName, 2000, '合成产物出现')
      const got = bot.inventory.count(resultName)
      bot.clickSlot(wid, 0, 0, 1) // shift 点产物: 网格里有几份就合成几份, 直接进背包
      await this.until(() => bot.inventory.count(resultName) >= got + n * r.resultCount, 3000, '产物进入背包')
      left -= n
    }
    return `合成了 ${resultName} ×${bot.inventory.count(resultName) - before}${small ? ' (背包 2×2)' : ' (工作台)'}`
  }

  protected cleanup () {
    if (this.wid !== null) this.bot.closeWindow(this.wid)
    else try { this.bot.closeWindow(0) } catch {} // 关背包: 网格残留物品退回背包
  }
}

// ---------- 熔炼 ----------

export class SmeltAction extends Task {
  private wid: number | null = null
  constructor (bot: BotAgent, private input: string, private count = 1, private fuel?: string) { super(bot, 'smelt') }

  protected async run () {
    const bot = this.bot
    if (bot.inventory.count(this.input) < this.count) throw new Error(`${this.input} 不够 (有 ${bot.inventory.count(this.input)}, 要 ${this.count})`)
    // 燃料: 指定的, 或自动挑 (煤优先, 不用要熔炼的那种东西)
    const fuels = Object.keys(bot.inventory.summary()).filter(n => fuelTicks(n) > 0 && n !== this.input && (!this.fuel || n === this.fuel))
      .sort((a, b) => fuelTicks(b) - fuelTicks(a))
    if (!fuels.length) throw new Error(this.fuel ? `背包里没有燃料 ${this.fuel}` : '背包里没有燃料 (煤/木炭/木板/原木/木棍)')
    const fuel = fuels.find(f => /coal|charcoal/.test(f)) ?? fuels[0]
    const fuelN = Math.min(bot.inventory.count(fuel), Math.ceil(this.count * 200 / fuelTicks(fuel)))

    const t = await this.ensureStation('furnace', '熔炉')
    const wid = this.wid = await this.openAt(t.x, t.y, t.z, 39, '熔炉')
    const toWin = (s: number) => toWindowSlot(s, 3) // 熔炉窗口: 0 原料, 1 燃料, 2 产物, 之后是玩家物品
    const slot = (i: number) => this.winSlot(wid, i)
    const taken: Record<string, number> = {}
    const takeOutput = async () => {
      const out = slot(2)
      if (!out) return
      const before = bot.inventory.count(out.name)
      bot.clickSlot(wid, 2, 0, 1)
      await this.until(() => !slot(2) || bot.inventory.count(out.name) > before, 1500, '取出产物')
      taken[out.name] = (taken[out.name] ?? 0) + bot.inventory.count(out.name) - before
    }
    await takeOutput() // 先清掉上次留下的产物
    if (slot(0) && slot(0)!.name !== this.input) throw new Error(`熔炉原料格已有别的东西 ${slot(0)!.name}`)
    await this.putItems(wid, toWin, this.input, 0, this.count)
    if (!slot(1) || slot(1)!.name === fuel) await this.putItems(wid, toWin, fuel, 1, fuelN)

    const deadline = Date.now() + this.count * 10_000 + 20_000
    let got = 0
    while (got < this.count) {
      if (Date.now() > deadline) break
      await this.sleep(1000)
      if (slot(2)) { await takeOutput(); got = Object.values(taken).reduce((a, b) => a + b, 0) }
      if (!slot(0) && !slot(2) && got > 0) break
    }
    const desc = Object.entries(taken).map(([n, c]) => `${n}×${c}`).join(', ')
    if (!got) throw new Error('等待超时, 没有熔炼出东西 (燃料不够或不是可熔炼物品?)')
    return `熔炼完成: ${desc} (燃料 ${fuel}×${fuelN})`
  }

  protected cleanup () { if (this.wid !== null) this.bot.closeWindow(this.wid) }
}

// ---------- 拾取掉落物 ----------

/** 走不到的掉落物说明 (pickup_items / collect 共用) */
function unreachableText (items: { name: string, x: number, y: number, z: number }[]): string {
  const shown = items.slice(0, 4).map(i => `${i.name} @ (${i.x},${i.y},${i.z})`).join(', ')
  return `${items.length} 个掉落物走不到、没捡起来: ${shown}${items.length > 4 ? ' …' : ''} (掉在矮洞里或被方块挡着; 加 allow_dig:true 重新下达可以挖开去捡)`
}

export class PickupItemsAction extends Task {
  constructor (bot: BotAgent, private radius = 8, private center?: { x: number, y: number, z: number }, private maxMs = 30_000) { super(bot, 'pickup_items') }

  /** 范围内走不到、没捡起来的掉落物 (结束时还在的) */
  unreachable: { name: string, x: number, y: number, z: number }[] = []
  /** 背包满了没捡的掉落物个数 */
  noRoom = 0

  protected async run () {
    const bot = this.bot
    const c = () => this.center ?? bot.pos
    const skip = new Set<number>()
    const noRoom = new Set<number>() // 背包满了装不下的
    const misses = new Map<number, number>() // 刚掉落的物品还在弹跳, 允许按最新位置重试几次
    const miss = (id: number) => { const n = (misses.get(id) ?? 0) + 1; misses.set(id, n); if (n >= 3) skip.add(id) }
    const t0 = Date.now(), picked0 = bot.pickedUp
    for (;;) {
      if (Date.now() - t0 > this.maxMs) break
      const items = [...bot.world.entities.values()]
        // 掉落物 + 自己射出、插在地上的箭
        .filter(e => (e.type === 'item' || (/^(arrow|spectral_arrow)$/.test(e.type) && e.ownerId === bot.entityId && e.meta.in_ground)) && !skip.has(e.id) && !noRoom.has(e.id) && Math.hypot(e.x - c().x, e.z - c().z) <= this.radius && Math.abs(e.y - c().y) <= 6)
        .sort((a, b) => Math.hypot(a.x - bot.pos.x, a.z - bot.pos.z) - Math.hypot(b.x - bot.pos.x, b.z - bot.pos.z))
      if (!items.length) break
      const e = items[0]
      const itemName = e.type === 'item' ? e.item : 'arrow'
      if (bot.inventory.emptySlots() === 0 && !bot.inventory.find(s => s.name === itemName && s.count < 64).length) { noRoom.add(e.id); continue }
      // 还在半空往下掉 (如高处挖下来的原木): 等它落地再走, 免得朝空中走失败几次就放弃
      if (!standableCell(bot.world, Math.floor(e.x), Math.floor(e.y + 0.2), Math.floor(e.z)) && Date.now() - t0 < 3000) { await this.sleep(150); continue }
      // 就在脚边 (常见: 挖了自己脚下那一列, 人还搭在坑沿上, 掉落物在正下方): 寻路的起点和终点是同一列, 规划不出来, 直接朝它走两步
      if (Math.hypot(e.x - bot.pos.x, e.z - bot.pos.z) < 1.3 && e.y < bot.pos.y + 0.5 && e.y > bot.pos.y - 3) {
        const ctl = bot.physics.control
        const t1 = Date.now()
        try {
          while (bot.world.entities.has(e.id) && Date.now() - t1 < 1200) {
            const cur = bot.world.entities.get(e.id)!
            if (Math.hypot(cur.x - bot.pos.x, cur.z - bot.pos.z) < 0.15) break
            faceTowards(bot, cur.x, bot.pos.y + bot.eyeHeight, cur.z)
            ctl.forward = true
            await this.sleep(50)
          }
        } finally { ctl.forward = false }
        const t2 = Date.now()
        while (bot.world.entities.has(e.id) && Date.now() - t2 < 500) await this.sleep(100)
        if (!bot.world.entities.has(e.id)) continue
      }
      const mv = await this.subMove({ x: e.x, y: Math.floor(e.y + 0.2), z: e.z }, { tolerance: 0, timeoutMs: 15_000 })
      if (mv.status !== 'done') { miss(e.id); continue }
      // 走到了: 等一下拾取; 还在就记一次未命中
      const t1 = Date.now()
      while (bot.world.entities.has(e.id) && Date.now() - t1 < 800) await this.sleep(100)
      if (bot.world.entities.has(e.id)) miss(e.id)
    }
    const n = bot.pickedUp - picked0
    // 试过但走不到的 (掉进矮洞/被方块挡住的坑里): 如实说出来, 不要报成"附近没有"
    for (const id of skip) {
      const e = bot.world.entities.get(id)
      if (e) this.unreachable.push({ name: e.type === 'item' ? (e.item ?? 'item') : 'arrow', x: Math.floor(e.x), y: Math.floor(e.y + 0.2), z: Math.floor(e.z) })
    }
    const notes = [
      ...(this.unreachable.length ? [unreachableText(this.unreachable)] : []),
      ...(noRoom.size ? [`背包满了, ${noRoom.size} 个掉落物装不下`] : []),
    ]
    this.noRoom = noRoom.size
    return n ? `捡起 ${n} 个物品${notes.length ? '; 另有 ' + notes.join('; ') : ''}` : notes.join('; ') || '附近没有可捡的掉落物'
  }
}

// ---------- 采集 ----------

export class CollectAction extends Task {
  constructor (bot: BotAgent, private block: string, private count = 1, private radius = 32) { super(bot, 'collect') }

  protected async run () {
    const bot = this.bot
    if (!mcData.blocksByName[this.block]) throw new Error(`未知方块 ${this.block}`)
    // 先看工具: 挖了也不掉落 (如空手挖石头/矿) 就别去挖, 直接说需要什么
    if (!bestToolFor(this.block, toolCandidates(bot)).harvest) {
      const need = harvestToolNames(this.block)
      const have = toolCandidates(bot).map(t => t.name)
      throw new Error(`采 ${this.block} 至少要 ${need[0] ?? '合适的工具'}${need.length > 1 ? ` (或 ${need.slice(1, 4).join('/')})` : ''} 才会掉落, 背包里没有${have.length ? ` (现有工具: ${[...new Set(have)].join(', ')})` : ''}`)
    }
    const before = bot.inventory.summary()
    const failed = new Set<string>()
    const lost: { name: string, x: number, y: number, z: number }[] = []
    let mined = 0, lastErr = '', noRoom = 0
    type P = { x: number, y: number, z: number }
    // 挖掉以后那一格走得出来: 四周有同层或高一层的落脚点 (否则是个两格深的坑, 下去就跳不出来)
    const exitable = (h: P) => [[1, 0], [-1, 0], [0, 1], [0, -1]].some(([dx, dz]) => standableCell(bot.world, h.x + dx, h.y, h.z + dz) || standableCell(bot.world, h.x + dx, h.y + 1, h.z + dz))
    // 挖掉以后人走得进去捡、也走得出来: 上面两格是空的 (不是埋在别的方块下面), 下面有地面。埋着的方块挖出来是个矮洞, 掉落物拿不到
    const retrievable = (h: P) => !bot.world.isSolid(h.x, h.y + 1, h.z) && !bot.world.isSolid(h.x, h.y + 2, h.z) && bot.world.isSolid(h.x, h.y - 1, h.z) && exitable(h)
    // 目标只被正上方一块自然方块盖着 (如草方块下面的泥土), 且那块挖得快 (≤3s): 先把它挖开, 掉落物就不会封在洞里。
    // 只限这一种情况: 人造方块、盖了两层以上、挖得慢的都不动, 照旧如实报告掉落物拿不到
    const coverOf = (h: P): string | null => {
      if (!bot.world.isSolid(h.x, h.y + 1, h.z) || bot.world.isSolid(h.x, h.y + 2, h.z) || !bot.world.isSolid(h.x, h.y - 1, h.z)) return null
      const name = bot.world.getBlock(h.x, h.y + 1, h.z)?.name
      if (!name || !isNaturalBlock(name)) return null
      return bestToolFor(name, toolCandidates(bot)).ticks / 20 <= 3 ? name : null
    }
    let opened = 0, pillared = 0
    const cellOf = () => ({ x: Math.floor(bot.pos.x), y: Math.floor(bot.pos.y + 0.01), z: Math.floor(bot.pos.z) })
    const home = cellOf() // 开工时站的位置
    /** 回到 to 那一层: 目标取那一层上还站得住的格 (to 本身可能就是被挖掉的那一列); 只走现成的路回不去, 才在脚下垫方块爬出来 */
    const climbBack = async (to: P) => {
      const spots: (P & { d: number })[] = []
      for (let dx = -2; dx <= 2; dx++) for (let dz = -2; dz <= 2; dz++) {
        if (standableCell(bot.world, to.x + dx, to.y, to.z + dz)) spots.push({ x: to.x + dx, y: to.y, z: to.z + dz, d: Math.hypot(to.x + dx + 0.5 - bot.pos.x, to.z + dz + 0.5 - bot.pos.z) })
      }
      const spot = spots.sort((a, b) => a.d - b.d)[0]
      if (!spot) return
      await this.subMove(spot, { tolerance: 0, timeoutMs: 10_000 })
      if (bot.pos.y >= to.y - 1.2) return
      const n0 = this.route.placed.length
      await this.subMove(spot, { tolerance: 0, allowPlace: true, timeoutMs: 15_000 })
      pillared += this.route.placed.length - n0
    }
    while (mined < this.count) {
      this.check()
      const hits = bot.world.findBlock(this.block, Math.floor(bot.pos.x), Math.floor(bot.pos.z), this.radius, 48, Math.floor(bot.pos.y))
        .filter(h => !failed.has(`${h.x},${h.y},${h.z}`))
        // 自己垫脚放的方块不算 (不然刚垫上爬出坑, 转头又把它挖掉掉回去)
        .filter(h => !this.route.placed.some(e => e.pos[0] === h.x && e.pos[1] === h.y && e.pos[2] === h.z))
      if (!hits.length) break
      // 优先已经够得着的, 其次有暴露面的 (不用挖进去), 最后最近的; 每一档里先挑挖完能走进去捡掉落物的
      // 再其次是挖开上方一块自然方块就能捡的 (coverOf); 都不是的 (深埋/坑底) 排最后
      const near = (h: P) => canReach(bot, h.x, h.y, h.z) && canSee(bot.world, eyeOf(bot), h.x, h.y, h.z)
      const open = (h: P) => exposed(bot, h.x, h.y, h.z)
      // 自己正踩着的那几列先不挖: 挖空了人可能还搭在坑沿上没掉下去, 掉落物在正下方反而走不过去
      const underFeet = (h: P) => h.y < bot.pos.y && Math.abs(h.x + 0.5 - bot.pos.x) < 0.8 && Math.abs(h.z + 0.5 - bot.pos.z) < 0.8
      const t = hits.find(h => near(h) && retrievable(h)) ?? hits.find(h => open(h) && retrievable(h)) ??
        hits.find(h => near(h) && !underFeet(h) && coverOf(h)) ?? hits.find(h => Math.abs(h.y - bot.pos.y) <= 6 && !underFeet(h) && coverOf(h)) ??
        hits.find(near) ?? hits.find(open) ?? hits[0]
      const k = `${t.x},${t.y},${t.z}`
      // 动手前站的位置 (挖的可能就是自己脚下那一列, 挖完人已经掉下去了)
      const back = cellOf()
      try {
        const cover = retrievable(t) ? null : coverOf(t)
        if (cover) {
          await reachBlock(this, bot, t.x, t.y + 1, t.z, cover)
          await this.must(new DigAction(bot, t.x, t.y + 1, t.z), `挖开上方的 ${cover}`)
          this.route.add('dug', cover, t.x, t.y + 1, t.z)
          opened++
        }
        await reachBlock(this, bot, t.x, t.y, t.z, this.block)
        await this.must(new DigAction(bot, t.x, t.y, t.z), '挖掘')
      } catch (e: any) {
        if (this.status !== 'running') throw e
        failed.add(k); lastErr = e.message
        if (failed.size > 8 + this.count) break
        continue
      }
      mined++
      await this.sleep(600) // 等掉落物生成并落地
      const pick = await this.sub(new PickupItemsAction(bot, 4, { x: t.x + 0.5, y: t.y, z: t.z + 0.5 }, 8000))
      noRoom = Math.max(noRoom, pick.noRoom)
      for (const u of pick.unreachable) if (!lost.some(l => l.x === u.x && l.y === u.y && l.z === u.z && l.name === u.name)) lost.push(u)
      // 下去捡完发现在一个两格深的坑里跳不出来 (平地上挖开草方块再挖泥土就是这样): 走回刚才那一层, 走不了就在脚下垫一块爬出来。
      // 每个目标挖完都保证人在坑外, 不把自己困住
      if (bot.pos.y < back.y - 1.2) await climbBack(back)
    }
    // 收工前再查一次: 连着挖几块, 人可能一格一格陷进自己挖的坑里 (每次只低一格, 上面那条查不出来)。
    // 比开工时低了一格多、又没走远, 就回到开工那一层 (走得回去就走, 走不回去垫一块)
    if (bot.pos.y < home.y - 1.2 && Math.hypot(bot.pos.x - home.x, bot.pos.z - home.z) <= 16) await climbBack(home)
    const after = bot.inventory.summary()
    const gained = Object.entries(after).map(([n, c]) => [n, c - (before[n] ?? 0)] as const).filter(([, d]) => d > 0).map(([n, d]) => `${n}+${d}`)
    if (!mined) throw new Error(`没采到 ${this.block}${lastErr ? `: ${lastErr}` : ` (${this.radius} 格内没找到)`}`)
    return `挖了 ${mined}/${this.count} 个 ${this.block}; 背包新增: ${gained.join(', ') || '无'}${opened ? `; 目标埋在自然方块下面, 先挖开了上方 ${opened} 块好捡掉落物${pillared ? `, 捡完垫了 ${pillared} 块爬出坑` : ''}` : ''}${lost.length ? `; ${unreachableText(lost)}${this.block === 'dirt' ? '。地表的 grass_block 挖了也掉 dirt, 而且掉在露天好捡: 可以改成 collect grass_block' : ''}` : ''}${noRoom ? `; 背包满了, ${noRoom} 个掉落物装不下` : ''}${!gained.length && !lost.length && !noRoom ? ' (没看到掉落物: 可能掉到够不着的地方了)' : ''}${mined < this.count ? `; 没挖够的原因: ${lastErr || `${this.radius} 格内没有更多了`}` : ''}`
  }
}

// ---------- 装备 / 进食 / 使用物品 ----------

const ARMOR_SLOT: [RegExp, number][] = [[/_helmet$|^carved_pumpkin$|_skull$|_head$/, SLOT.armor], [/_chestplate$|^elytra$/, SLOT.armor + 1], [/_leggings$/, SLOT.armor + 2], [/_boots$/, SLOT.armor + 3]]

export class EquipAction extends Task {
  constructor (bot: BotAgent, private item: string) { super(bot, 'equip') }
  protected async run () {
    const bot = this.bot
    const hit = bot.inventory.find(s => s.name === this.item)[0]
    if (!hit) throw new Error(`背包里没有 ${this.item}`)
    const armor = ARMOR_SLOT.find(([re]) => re.test(this.item))
    closeContainer(bot)
    if (armor) {
      if (bot.inventory.slots[armor[1]]) bot.clickSlot(0, armor[1], 0, 1) // 先把旧的 shift 回背包
      await this.sleep(150)
      bot.clickSlot(0, hit.slot, 0, 1) // shift 点击盔甲: 自动穿到对应部位
      await this.until(() => bot.inventory.slots[armor[1]]?.name === this.item, 2000, '穿上')
      return `已穿上 ${this.item}`
    }
    if (this.item === 'shield' || this.item === 'totem_of_undying') {
      bot.clickSlot(0, hit.slot, SWAP_OFFHAND_BUTTON, 2) // 与副手交换
      await this.until(() => bot.inventory.offhand()?.name === this.item, 2000, '放到副手')
      return `已把 ${this.item} 放到副手`
    }
    await holdSlot(this, bot, hit.slot)
    return `手持 ${this.item} (快捷栏 ${bot.inventory.heldSlot})`
  }
}

/** 挑最好的食物槽位 (desperate 时允许腐肉等) */
export function bestFood (bot: BotAgent, desperate = false) {
  return bot.inventory.find(s => foodScore(s.name, desperate) > 0)
    .sort((a, b) => foodScore(b.item.name, desperate) - foodScore(a.item.name, desperate))[0] ?? null
}

/** 吃一个食物 (反射层也用这个) */
export async function eatOnce (act: AsyncAction, bot: BotAgent, item?: string): Promise<string> {
  const hit = item ? bot.inventory.find(s => s.name === item)[0] : bestFood(bot, bot.food <= 6)
  if (!hit) throw new Error(item ? `背包里没有 ${item}` : '背包里没有能吃的')
  if (bot.food >= 20 && !/golden_apple|chorus/.test(hit.item.name)) throw new Error('不饿 (饱食度 20), 吃不下')
  const owner = `eat#${act.id}`
  await act.until(() => bot.tryLockHand(owner), 8000, '手空闲')
  try {
    const prev = bot.inventory.heldSlot
    await holdSlot(act, bot, hit.slot)
    const food0 = bot.food
    bot.usingHand = 'main_hand'
    bot.useItem()
    // 吃东西 32 tick; 服务器在使用结束时自动生效, 期间不能切换手持
    await act.until(() => bot.food > food0, 3000, '进食生效')
    await act.sleep(100)
    if (bot.inventory.heldSlot !== prev) bot.selectSlot(prev)
    return `吃了 ${hit.item.name} (饱食 ${food0}→${bot.food})`
  } finally {
    if (bot.usingHand === 'main_hand') bot.usingHand = null
    bot.releaseHand(owner)
  }
}

export class EatAction extends Task {
  constructor (bot: BotAgent, private item?: string) { super(bot, 'eat') }
  protected async run () { return eatOnce(this, this.bot, this.item) }
}

export class UseItemAction extends Task {
  constructor (bot: BotAgent, private item?: string, private holdMs = 0) { super(bot, 'use_item') }
  protected async run () {
    const bot = this.bot
    if (this.item) await holdItem(this, bot, this.item)
    const held = bot.inventory.held()
    if (!held) throw new Error('手里没东西')
    bot.useItem()
    if (this.holdMs > 0) {
      await this.sleep(Math.min(this.holdMs, 10_000))
      bot.releaseUseItem()
    } else await this.sleep(200)
    return `使用了 ${held.name}${this.holdMs ? ` (按住 ${this.holdMs}ms)` : ''}`
  }
}

// ---------- 方块交互 / 睡觉 ----------

export class UseBlockAction extends Task {
  constructor (bot: BotAgent, private x: number, private y: number, private z: number, private item?: string) { super(bot, 'use_block') }
  protected async run () {
    const { bot, x, y, z } = this
    const b0 = bot.world.getBlock(x, y, z)
    if (!b0) throw new Error(`(${x},${y},${z}) 未加载`)
    if (b0.name.endsWith('_bed')) bedSafe(bot)
    await reachBlock(this, bot, x, y, z, b0.name)
    if (this.item) await holdItem(this, bot, this.item); else await holdNothing(this, bot)
    faceTowards(bot, x + 0.5, y + 0.5, z + 0.5)
    await this.sleep(60)
    const win0 = bot.inventory.activeWindowId
    bot.interactBlock(x, y, z)
    await this.sleep(400)
    const b1 = bot.world.getBlock(x, y, z)
    if (bot.inventory.activeWindowId !== null && bot.inventory.activeWindowId !== win0) return `打开了 ${b0.name} 的界面 (窗口 ${bot.inventory.activeWindowId}, 用 get_container 查看, 用完 close_window)`
    if (b1 && b1.stateId !== b0.stateId) {
      const p0 = blockProps(b0.stateId), p1 = blockProps(b1.stateId)
      const diff = Object.keys(p1).filter(k => p0[k] !== p1[k]).map(k => `${k}: ${p0[k]}→${p1[k]}`)
      return `${b0.name}${b1.name !== b0.name ? ` → ${b1.name}` : ''} ${diff.join(', ')}`.trim()
    }
    return `右键了 ${b0.name} (方块状态没变)`
  }
}

/** 下界/末地右键床会爆炸: 直接拒绝 */
function bedSafe (bot: BotAgent) {
  if (!bot.dimInfo.bedWorks) throw new Error(`在 ${bot.dimension.replace(/^minecraft:/, '')} 用床会爆炸, 不睡 (只有主世界能睡)`)
}

export class SleepAction extends Task {
  constructor (bot: BotAgent, private at?: { x: number, y: number, z: number }) { super(bot, 'sleep') }
  protected async run () {
    const bot = this.bot
    bedSafe(bot)
    let bed = this.at
    if (!bed) {
      const all = BED_COLORS.flatMap(c => bot.world.findBlock(`${c}_bed`, Math.floor(bot.pos.x), Math.floor(bot.pos.z), 24, 2, Math.floor(bot.pos.y)))
      all.sort((a, b) => Math.hypot(a.x - bot.pos.x, a.y - bot.pos.y, a.z - bot.pos.z) - Math.hypot(b.x - bot.pos.x, b.y - bot.pos.y, b.z - bot.pos.z))
      bed = all[0]
      if (!bed) throw new Error('24 格内没有床')
    }
    // 原版: 脚离床 (底面中心) 水平 ≤3、竖直 ≤2 才能睡, 比触及范围严
    const b = bed
    await reachBlock(this, bot, b.x, b.y, b.z, '床', p => Math.abs(p.x - (b.x + 0.5)) <= 2.8 && Math.abs(p.z - (b.z + 0.5)) <= 2.8 && Math.abs(p.y - b.y) <= 1.8)
    await holdNothing(this, bot)
    const chatSeq = bot.chat.at(-1)?.seq ?? 0
    faceTowards(bot, bed.x + 0.5, bed.y + 0.3, bed.z + 0.5)
    await this.sleep(60)
    bot.interactBlock(bed.x, bed.y, bed.z)
    const t0 = Date.now()
    while (Date.now() - t0 < 2500) {
      if (bot.sleeping) return `已在 (${bed.x},${bed.y},${bed.z}) 躺下, 天亮会自动醒 (wake 可提前起床)`
      const msg = bot.readChat(chatSeq).find(m => /bed|床|sleep|睡/.test(m.text))
      if (msg) throw new Error(`睡不了: ${msg.text}`)
      await this.sleep(100)
    }
    throw new Error('右键床后没有躺下 (可能不是夜晚或附近有怪)')
  }
}

// ---------- 实体交互 / 骑乘 / 交易 ----------

/** 走到实体旁 (3 格内) */
async function nearEntity (act: Task, bot: BotAgent, id: number) {
  const e = bot.world.entities.get(id)
  if (!e) throw new Error(`实体 ${id} 不存在`)
  if (Math.hypot(e.x - bot.pos.x, e.y - bot.pos.y, e.z - bot.pos.z) <= 3) return e
  const mv = await act.subMove({ x: e.x, y: Math.floor(e.y), z: e.z }, { tolerance: 1, timeoutMs: 30_000 })
  const e2 = bot.world.entities.get(id)
  if (!e2) throw new Error(`实体 ${id} 消失了`)
  if (Math.hypot(e2.x - bot.pos.x, e2.y - bot.pos.y, e2.z - bot.pos.z) > 3.5) throw new Error(`靠近实体失败: ${mv.detail || '距离仍然太远'}`)
  return e2
}

export class InteractEntityAction extends Task {
  constructor (bot: BotAgent, private entityId: number, private item?: string) { super(bot, 'interact_entity') }
  protected async run () {
    const bot = this.bot
    const e = await nearEntity(this, bot, this.entityId)
    if (this.item) await holdItem(this, bot, this.item); else await holdNothing(this, bot)
    const held0 = bot.inventory.held()
    const n0 = held0?.count ?? 0
    const status0 = bot.entityStatus.get(this.entityId)
    faceTowards(bot, e.x, e.y + 0.8, e.z)
    await this.sleep(60)
    bot.interactEntity(this.entityId)
    await this.sleep(500)
    const parts: string[] = [`右键了 ${e.type}#${e.id}`]
    if (bot.vehicleId === this.entityId) parts.push('已骑上 (dismount 下来)')
    if (bot.inventory.activeWindowId !== null) parts.push(`打开了界面 (窗口 ${bot.inventory.activeWindowId})`)
    const st = bot.entityStatus.get(this.entityId)
    if (st && st !== status0 && st.status === 18) parts.push('进入繁殖状态 (爱心)')
    const held1 = bot.inventory.held()
    if (held0 && (held1?.name !== held0.name || (held1?.count ?? 0) < n0)) parts.push(`消耗了 ${held0.name}`)
    return parts.join(', ')
  }
}

export class DismountAction extends Task {
  constructor (bot: BotAgent) { super(bot, 'dismount') }
  protected async run () {
    const bot = this.bot
    if (bot.vehicleId === null) return '本来就没骑着东西'
    bot.setSneakInput(true)
    await this.until(() => bot.vehicleId === null, 2000, '下坐骑')
    bot.setSneakInput(false)
    return '已下来'
  }
}

export class WakeAction extends Task {
  constructor (bot: BotAgent) { super(bot, 'wake') }
  protected async run () {
    const bot = this.bot
    if (!bot.sleeping) return '没在睡觉'
    bot.stopSleeping()
    await this.until(() => !bot.sleeping, 2000, '起床')
    return '已起床'
  }
}

export class TradeAction extends Task {
  private wid: number | null = null
  constructor (bot: BotAgent, private entityId: number, private index?: number, private times = 1) { super(bot, 'trade') }

  protected async run () {
    const bot = this.bot
    const e = await nearEntity(this, bot, this.entityId)
    closeContainer(bot)
    await holdNothing(this, bot)
    bot.trades = null
    faceTowards(bot, e.x, e.y + 1.4, e.z)
    await this.sleep(60)
    bot.interactEntity(this.entityId)
    await this.until(() => bot.inventory.activeWindowId !== null && !!bot.trades, 3000, '交易界面')
    const wid = this.wid = bot.inventory.activeWindowId!
    const offers = bot.trades!.map((t: any, i: number) => ({
      index: i,
      buy: [t.inputItem1, t.inputItem2].filter(Boolean).map((x: any) => `${itemName(x.itemId)}×${x.itemCount}`),
      sell: t.outputItem?.itemId ? `${itemName(t.outputItem.itemId)}×${t.outputItem.itemCount}` : '?',
      uses: `${t.nbTradeUses}/${t.maximumNbTradeUses}`,
      disabled: !!t.tradeDisabled,
    }))
    if (this.index === undefined) return `交易列表: ${JSON.stringify(offers)}`
    const o = offers[this.index]
    if (!o) throw new Error(`没有第 ${this.index} 项交易 (共 ${offers.length} 项)`)
    if (o.disabled) throw new Error(`第 ${this.index} 项交易已售罄`)
    const toWin = (s: number) => toWindowSlot(s, 3) // 交易窗口: 0/1 付款, 2 产物, 之后是玩家物品
    let done = 0
    for (; done < this.times; done++) {
      bot.selectTrade(this.index) // 服务器自动把付款物品从背包填进 0/1 格
      try { await this.until(() => !!this.winSlot(wid, 2), 1200, '交易产物') } catch { break }
      bot.clickSlot(wid, 2, 0, 0) // 左键取 (shift 会一直交易到材料用完)
      await this.until(() => !!bot.inventory.cursor, 1500, '取到产物')
      await this.stowCursor(wid, toWin)
    }
    if (!done) throw new Error(`没能完成交易 (${o.buy.join(' + ')} → ${o.sell}), 材料不够?`)
    return `交易 ${done} 次: ${o.buy.join(' + ')} → ${o.sell}`
  }

  protected cleanup () {
    if (this.wid !== null) this.bot.closeWindow(this.wid)
  }
}

// ---------- 先走近再操作 ----------

/**
 * dig / place / open_container: 先走到够得着且看得见目标的位置 (reachBlock), 再执行原动作。
 * 动作类型名保持原样 (日志/脚本统计不变)。
 */
export class ReachThen extends Task {
  constructor (bot: BotAgent, type: string, private at: { x: number, y: number, z: number }, private inner: () => Action, private what: string) { super(bot, type) }
  protected async run () {
    const { x, y, z } = this.at
    const where = await reachBlock(this, this.bot, x, y, z, this.what)
    const a = await this.sub(this.inner())
    if (a.status !== 'done') throw new Error(`${a.detail}${where ? ` (${where})` : ''}`)
    return `${a.detail}${where ? ` (${where})` : ''}`
  }
}

// ---------- 容器存取 (按物品名) ----------

/** 箱盖上方允许的方块: 原版只有"完整的导电方块"才会挡住箱盖 (玻璃/树叶/台阶/楼梯/另一个箱子等不挡) */
const LID_OK = /(glass|leaves|_slab$|_stairs$|_fence|_wall$|_pane$|chest$|_carpet$|_sign$|torch|lantern|_button$|pressure_plate|^ice$|^frosted_ice$|_trapdoor$|^snow$|^scaffolding$|^hopper$)/

/**
 * 箱子类 (chest / trapped_chest / ender_chest) 打不开的原因: 上方是完整实心方块, 或有猫坐在上面。null = 没问题。
 * 其他容器 (木桶/漏斗/潜影盒…) 不检查。
 */
export function containerBlocked (bot: BotAgent, x: number, y: number, z: number): string | null {
  const b = bot.world.getBlock(x, y, z)
  if (!b || !/(^|_)chest$/.test(b.name)) return null
  const above = bot.world.getBlock(x, y + 1, z)
  if (above && bot.world.isSolid(x, y + 1, z) && !LID_OK.test(above.name)) {
    return `${b.name} (${x},${y},${z}) 上方是 ${above.name}, 箱盖打不开 (上方要空着, 或是玻璃/树叶/台阶这类非完整方块)`
  }
  const cat = [...bot.world.entities.values()].find(e => e.type === 'cat' && Math.floor(e.x) === x && Math.floor(e.y + 0.1) === y + 1 && Math.floor(e.z) === z)
  if (cat) return `${b.name} (${x},${y},${z}) 上面坐着猫 #${cat.id}, 箱盖打不开`
  return null
}

/**
 * chest_take / chest_put 按物品名存取: {item, count?, x?,y?,z?}
 * - 给了坐标: 走过去 (reachBlock) → 打开 → 存取 → 关上; 没给: 用当前打开的容器 (open_container 之后)
 * - count 缺省 = 全部; 整组用 shift 点击, 零头用"拿起整组 → 右键逐个放 → 放回剩余"
 * - 每一步核对数量变化, 背包满/箱子满时停下并说明
 */
export class ChestTransferAction extends Task {
  private openedHere: number | null = null
  constructor (bot: BotAgent, private dir: 'take' | 'put', private item: string, private count?: number, private at?: { x: number, y: number, z: number }) {
    super(bot, `chest_${dir}`)
  }

  protected async run () {
    const bot = this.bot
    if (!mcData.itemsByName[this.item]) throw new Error(`未知物品 ${this.item}`)
    let where = '', label = '容器'
    if (this.at) {
      const { x, y, z } = this.at
      const b = bot.world.getBlock(x, y, z)
      if (!b) throw new Error(`(${x},${y},${z}) 未加载`)
      label = b.name
      const blocked = containerBlocked(bot, x, y, z)
      if (blocked) throw new Error(blocked)
      const o = bot.openedContainer
      const already = bot.inventory.activeWindowId !== null && o?.windowId === bot.inventory.activeWindowId && o.x === x && o.y === y && o.z === z
      if (!already) {
        where = await reachBlock(this, bot, x, y, z, b.name)
        this.openedHere = await this.openAt(x, y, z, 37, b.name)
        bot.openedContainer = { windowId: this.openedHere, block: b.name, x, y, z }
      }
    } else if (bot.openedContainer?.windowId === bot.inventory.activeWindowId) label = bot.openedContainer!.block
    const wid = bot.inventory.activeWindowId
    if (wid === null) throw new Error('没有打开的容器 (给 x,y,z 会自动走过去打开)')
    const w = bot.inventory.windows.get(wid)
    const size = containerSize(w?.slots.length ?? 0)
    if (!w || size <= 0) throw new Error('当前窗口不是容器')

    // 窗口坐标: 0..size-1 容器, 之后 PLAYER_STORAGE 格是玩家背包+快捷栏
    const take = this.dir === 'take'
    const mine = [size, size + PLAYER_STORAGE]
    const src = take ? [0, size] : mine
    const dst = take ? mine : [0, size]
    const name = this.item
    const sum = ([a, b]: number[]) => { let n = 0; for (let i = a; i < b; i++) if (w.slots[i]?.name === name) n += w.slots[i]!.count; return n }
    const maxStack = mcData.itemsByName[name]?.stackSize ?? 64
    const want = this.count ?? Infinity
    let moved = 0, stop = ''
    while (moved < want) {
      this.check()
      const need = want - moved
      let s = -1
      for (let i = src[0]; i < src[1]; i++) if (w.slots[i]?.name === name) { s = i; break }
      if (s < 0) break
      const sc = w.slots[s]!.count
      const before = sum(dst)
      if (sc <= need) {
        bot.clickSlot(wid, s, 0, 1) // shift: 整组移过去 (目标区自动合并/找空位)
      } else {
        // 零头: 目标区找同类有空间的, 否则空格
        let d = -1
        for (let i = dst[0]; i < dst[1]; i++) { const t = w.slots[i]; if (t?.name === name && t.count + need <= maxStack) { d = i; break } }
        if (d < 0) for (let i = dst[0]; i < dst[1]; i++) if (!w.slots[i]) { d = i; break }
        if (d < 0) { stop = take ? '背包满了' : `${label}满了`; break }
        bot.clickSlot(wid, s, 0, 0) // 拿起整组
        for (let k = 0; k < need; k++) bot.clickSlot(wid, d, 1, 0) // 右键放 1 个
        bot.clickSlot(wid, s, 0, 0) // 剩余放回
      }
      try {
        await this.until(() => sum(dst) > before, 1500, '物品转移')
        await this.sleep(100) // 等同批次的槽位更新到齐
      } catch { stop = take ? '背包满了' : `${label}满了`; break }
      moved += sum(dst) - before
    }
    const leftIn = sum([0, size]), inInv = bot.inventory.count(name)
    this.extra = { ...this.extra, item: name, moved, in_container: leftIn, in_inventory: inInv }
    const tail = `${where ? ` (${where})` : ''}`
    if (!moved) {
      const why = stop || (take ? `${label}里没有 ${name}` : `背包里没有 ${name}`)
      throw new Error(`${take ? '没拿到' : '没放进去'} ${name}: ${why}${tail}`)
    }
    const short = Number.isFinite(want) && moved < want ? `, 只${take ? '拿到' : '放了'} ${moved}/${want}${stop ? ` (${stop})` : ` (${take ? label + '里' : '背包里'}没有更多了)`}` : (stop ? ` (${stop})` : '')
    return `${take ? `从 ${label} 拿了` : `往 ${label} 放了`} ${name}×${moved}${short}; ${label}里还有 ${leftIn}, 背包里有 ${inInv}${tail}`
  }

  protected cleanup () {
    if (this.openedHere !== null) { this.bot.closeWindow(this.openedHere); this.openedHere = null }
  }
}
