/**
 * 多步任务 (AsyncAction): 合成 / 熔炼 / 采集 / 拾取 / 装备 / 进食 / 使用物品与方块 / 睡觉 / 实体交互 / 村民交易。
 * 需要工作台/熔炉时: 触及范围内有就用, 32 格内有就走过去, 背包里有就就地放一个。
 */
import type { BotAgent } from '../conn/bot.js'
import { AsyncAction } from './base.js'
import { MoveToAction, DigAction, PlaceAction, scaffoldSlots } from './actions.js'
import { standableCell } from './astar.js'
import { holdSlot, holdItem, holdNothing, closeContainer, faceTowards, reachTo } from './hands.js'
import { mcData, itemName, itemId, foodScore, fuelTicks, blockProps } from '../game/knowledge.js'

const AIRISH = new Set(['air', 'cave_air', 'void_air'])
const BED_COLORS = ['white', 'orange', 'magenta', 'light_blue', 'yellow', 'lime', 'pink', 'gray', 'light_gray', 'cyan', 'purple', 'blue', 'brown', 'green', 'red', 'black']

// ---------- 共用: 接近方块 / 找或放工作方块 ----------

/** 能站、且从那里够得着 (x,y,z) 的位置, 按离 bot 远近排序; 同一列只取目标下方 ≥2 格 (仰头挖, 不挖脚下) */
export function approachSpots (bot: BotAgent, x: number, y: number, z: number, maxReach = 4.2): { x: number, y: number, z: number }[] {
  const out: { x: number, y: number, z: number, d: number }[] = []
  for (let dx = -3; dx <= 3; dx++) for (let dz = -3; dz <= 3; dz++) for (let dy = -4; dy <= 1; dy++) {
    if (dx === 0 && dz === 0 && dy > -2) continue
    const sx = x + dx, sy = y + dy, sz = z + dz
    const reach = Math.hypot(x - sx, y + 0.5 - (sy + 1.62), z - sz)
    if (reach > maxReach) continue
    if (!standableCell(bot.world, sx, sy, sz)) continue
    out.push({ x: sx, y: sy, z: sz, d: Math.hypot(sx + 0.5 - bot.pos.x, (sy - bot.pos.y) * 1.5, sz + 0.5 - bot.pos.z) })
  }
  return out.sort((a, b) => a.d - b.d).map(({ x, y, z }) => ({ x, y, z }))
}
export const approachSpot = (bot: BotAgent, x: number, y: number, z: number) => approachSpots(bot, x, y, z)[0] ?? null

/**
 * 够不着时的备选: 在目标旁边的一列垫方块上去 (如高处的树干)。
 * 返回站立格 (由 MoveTo 规划 pillar 上升), 需要背包里有足够的垫脚方块。
 */
export function pillarSpot (bot: BotAgent, x: number, y: number, z: number): { x: number, y: number, z: number } | null {
  const have = scaffoldSlots(bot).reduce((n, h) => n + h.item.count, 0)
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

/** 走到能够着 (x,y,z) 的位置; 已够着则不动; 太高时在旁边垫方块上去; 埋着的挖进去 */
async function reachBlock (act: AsyncAction & { subMove: (t: any, o?: any) => Promise<MoveToAction> }, bot: BotAgent, x: number, y: number, z: number, what: string) {
  if (reachTo(bot, x, y, z) <= 4.3) return
  // 依次试最近的几个接近点 (有的看似能站却到不了, 如树冠上), 都不行再垫方块上去, 最后挖进去 (埋在地下的矿)
  const spots = approachSpots(bot, x, y, z).slice(0, 3)
  const pillar = pillarSpot(bot, x, y, z)
  if (pillar) spots.push(pillar)
  spots.push(...digInSpots(bot, x, y, z))
  if (!spots.length) throw new Error(`${what} (${x},${y},${z}) 够不着: 周围没有能站的位置${scaffoldSlots(bot).length ? '' : ' (背包有泥土/圆石时可垫高)'}`)
  let err = ''
  for (const spot of spots) {
    const mv = await act.subMove(spot, { tolerance: 0 })
    if (mv.status === 'done' && reachTo(bot, x, y, z) <= 4.6) return
    err = mv.status === 'done' ? '到了但还是够不着' : mv.detail
  }
  throw new Error(`走到${what}失败: ${err}`)
}

/** 带 subMove 的任务基类 */
abstract class Task extends AsyncAction {
  async subMove (t: { x: number, y?: number, z: number }, opts: { tolerance?: number, timeoutMs?: number } = {}) {
    return this.sub(new MoveToAction(this.bot, t, opts))
  }

  /** 找到/走到/放置一个工作方块 (工作台/熔炉), 返回其坐标 */
  protected async ensureStation (block: string, label: string): Promise<{ x: number, y: number, z: number }> {
    const bot = this.bot
    const near = bot.world.findBlock(block, Math.floor(bot.pos.x), Math.floor(bot.pos.z), 32, 5, Math.floor(bot.pos.y))
    const inReach = near.find(b => reachTo(bot, b.x, b.y, b.z) <= 4.4)
    if (inReach) return inReach
    if (near.length) {
      const t = near[0]
      await reachBlock(this, bot, t.x, t.y, t.z, label)
      return t
    }
    if (!bot.inventory.count(block)) throw new Error(`需要${label}: 32 格内没有, 背包里也没有 ${block}`)
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

  /** 把光标上的物品放回背包 (同类可合并的堆优先, 否则空格) */
  protected async stowCursor (wid: number, toWin: (s: number) => number) {
    const bot = this.bot
    const cur = bot.inventory.cursor
    if (!cur) return
    const same = bot.inventory.find(s => s.name === cur.name && s.count < 64)[0]
    const empty = [...Array(36).keys()].map(i => 9 + i).find(i => !bot.inventory.slots[i])
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
      toWin = (s: number) => s + 1 // 工作台窗口: 0 产物, 1-9 网格, 10-36 背包, 37-45 快捷栏
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
    else try { this.bot.client.write('close_window', { windowId: 0 }) } catch {} // 关背包: 网格残留物品退回背包
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
    const toWin = (s: number) => s - 6 // 熔炉窗口: 0 原料, 1 燃料, 2 产物, 3-29 背包, 30-38 快捷栏
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

export class PickupItemsAction extends Task {
  constructor (bot: BotAgent, private radius = 8, private center?: { x: number, y: number, z: number }, private maxMs = 30_000) { super(bot, 'pickup_items') }

  protected async run () {
    const bot = this.bot
    const c = () => this.center ?? bot.pos
    const skip = new Set<number>()
    const misses = new Map<number, number>() // 刚掉落的物品还在弹跳, 允许按最新位置重试几次
    const miss = (id: number) => { const n = (misses.get(id) ?? 0) + 1; misses.set(id, n); if (n >= 3) skip.add(id) }
    const t0 = Date.now(), picked0 = bot.pickedUp
    for (;;) {
      if (Date.now() - t0 > this.maxMs) break
      const items = [...bot.world.entities.values()]
        .filter(e => e.type === 'item' && !skip.has(e.id) && Math.hypot(e.x - c().x, e.z - c().z) <= this.radius && Math.abs(e.y - c().y) <= 6)
        .sort((a, b) => Math.hypot(a.x - bot.pos.x, a.z - bot.pos.z) - Math.hypot(b.x - bot.pos.x, b.z - bot.pos.z))
      if (!items.length) break
      const e = items[0]
      if (bot.inventory.emptySlots() === 0 && !bot.inventory.find(s => s.name === e.item && s.count < 64).length) { skip.add(e.id); continue }
      const mv = await this.subMove({ x: e.x, y: Math.floor(e.y + 0.2), z: e.z }, { tolerance: 0, timeoutMs: 15_000 })
      if (mv.status !== 'done') { miss(e.id); continue }
      // 走到了: 等一下拾取; 还在就记一次未命中
      const t1 = Date.now()
      while (bot.world.entities.has(e.id) && Date.now() - t1 < 800) await this.sleep(100)
      if (bot.world.entities.has(e.id)) miss(e.id)
    }
    const n = bot.pickedUp - picked0
    return n ? `捡起 ${n} 个物品` : '附近没有可捡的掉落物'
  }
}

// ---------- 采集 ----------

export class CollectAction extends Task {
  constructor (bot: BotAgent, private block: string, private count = 1, private radius = 32) { super(bot, 'collect') }

  protected async run () {
    const bot = this.bot
    if (!mcData.blocksByName[this.block]) throw new Error(`未知方块 ${this.block}`)
    const before = bot.inventory.summary()
    const failed = new Set<string>()
    let mined = 0, lastErr = ''
    while (mined < this.count) {
      this.check()
      const hits = bot.world.findBlock(this.block, Math.floor(bot.pos.x), Math.floor(bot.pos.z), this.radius, 48, Math.floor(bot.pos.y))
        .filter(h => !failed.has(`${h.x},${h.y},${h.z}`))
      if (!hits.length) break
      // 优先已经够得着的, 其次有暴露面的 (不用挖进去), 最后最近的
      const t = hits.find(h => reachTo(bot, h.x, h.y, h.z) <= 4.3) ?? hits.find(h => exposed(bot, h.x, h.y, h.z)) ?? hits[0]
      const k = `${t.x},${t.y},${t.z}`
      try {
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
      await this.sub(new PickupItemsAction(bot, 4, { x: t.x + 0.5, y: t.y, z: t.z + 0.5 }, 8000))
    }
    const after = bot.inventory.summary()
    const gained = Object.entries(after).map(([n, c]) => [n, c - (before[n] ?? 0)] as const).filter(([, d]) => d > 0).map(([n, d]) => `${n}+${d}`)
    if (!mined) throw new Error(`没采到 ${this.block}${lastErr ? `: ${lastErr}` : ` (${this.radius} 格内没找到)`}`)
    return `挖了 ${mined}/${this.count} 个 ${this.block}; 背包新增: ${gained.join(', ') || '无 (可能工具不对)'}${mined < this.count ? `; 没挖够的原因: ${lastErr || `${this.radius} 格内没有更多了`}` : ''}`
  }
}

// ---------- 装备 / 进食 / 使用物品 ----------

const ARMOR_SLOT: [RegExp, number][] = [[/_helmet$|^carved_pumpkin$|_skull$|_head$/, 5], [/_chestplate$|^elytra$/, 6], [/_leggings$/, 7], [/_boots$/, 8]]

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
      bot.clickSlot(0, hit.slot, 40, 2) // 与副手交换
      await this.until(() => bot.inventory.slots[45]?.name === this.item, 2000, '放到副手')
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
    bot.useItem()
    // 吃东西 32 tick; 服务器在使用结束时自动生效, 期间不能切换手持
    await act.until(() => bot.food > food0, 3000, '进食生效')
    await act.sleep(100)
    if (bot.inventory.heldSlot !== prev) bot.selectSlot(prev)
    return `吃了 ${hit.item.name} (饱食 ${food0}→${bot.food})`
  } finally {
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
      bot.client.write('block_dig', { status: 6, location: { x: 0, y: 0, z: 0 }, face: 0, sequence: 0 }) // 26.3: 6 = RELEASE_USE_ITEM
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

export class SleepAction extends Task {
  constructor (bot: BotAgent, private at?: { x: number, y: number, z: number }) { super(bot, 'sleep') }
  protected async run () {
    const bot = this.bot
    let bed = this.at
    if (!bed) {
      const all = BED_COLORS.flatMap(c => bot.world.findBlock(`${c}_bed`, Math.floor(bot.pos.x), Math.floor(bot.pos.z), 24, 2, Math.floor(bot.pos.y)))
      all.sort((a, b) => Math.hypot(a.x - bot.pos.x, a.y - bot.pos.y, a.z - bot.pos.z) - Math.hypot(b.x - bot.pos.x, b.y - bot.pos.y, b.z - bot.pos.z))
      bed = all[0]
      if (!bed) throw new Error('24 格内没有床')
    }
    await reachBlock(this, bot, bed.x, bed.y, bed.z, '床')
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
    bot.client.write('player_input', { inputs: { shift: true } })
    await this.until(() => bot.vehicleId === null, 2000, '下坐骑')
    bot.client.write('player_input', { inputs: {} })
    return '已下来'
  }
}

export class WakeAction extends Task {
  constructor (bot: BotAgent) { super(bot, 'wake') }
  protected async run () {
    const bot = this.bot
    if (!bot.sleeping) return '没在睡觉'
    bot.client.write('entity_action', { entityId: bot.entityId, actionId: 'stop_sleeping', jumpBoost: 0 })
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
    const toWin = (s: number) => s - 6 // 交易窗口: 0/1 付款, 2 产物, 3-29 背包, 30-38 快捷栏
    let done = 0
    for (; done < this.times; done++) {
      bot.client.write('select_trade', { slot: this.index }) // 服务器自动把付款物品从背包填进 0/1 格
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
