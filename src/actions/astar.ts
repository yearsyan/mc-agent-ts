/**
 * A* 寻路: 在客户端世界模型上找可行走路径。
 * 移动方式: 平走/斜走、跳 1 格、下落 ≤4 格、平向挖穿、楼梯式上挖、浅水涉行/游泳、
 * 穿过木门/栅栏门 (执行时自动开门)、爬梯子/藤蔓、垫方块上升 (pillar)、搭桥 (bridge)。
 */
import type { World } from '../world/world.js'
import { blockInfo, isWatery } from '../game/knowledge.js'

export interface PathNode {
  x: number, y: number, z: number
  /** 挖穿: flat = 平向挖前方 2 格, up = 楼梯式上挖, down = 挖脚下落下去 */
  dig?: 'flat' | 'up' | 'down'
  /** 需要放方块: pillar = 跳起垫脚下, bridge = 在目标格下方放支撑 */
  place?: 'pillar' | 'bridge'
  /** 梯子/藤蔓上的竖直移动 */
  climb?: boolean
  /** 目标格有门/栅栏门 (执行时若关着就打开) */
  door?: boolean
  /** 目标格在水里 (游泳) */
  swim?: boolean
}

export interface PathOptions {
  /** 允许深水游泳 (默认 true) */
  allowSwim?: boolean
  /** 可用于垫脚/搭桥的方块数; 0 = 不放方块 */
  scaffold?: number
  /** 允许挖掘 (默认 true) */
  allowDig?: boolean
  /** 到达容差: |dx|,|dz| ≤ tol 且 |dy| ≤ max(tol,1); 0 = 必须正好到目标格 */
  tolerance?: number
  maxExpansions?: number
  /** 单次搜索的时间上限 (ms); 超时按无路处理, 避免长时间阻塞事件循环 (所有 bot 的 tick 都在同一线程) */
  timeBudgetMs?: number
}

const DANGER = new Set(['lava', 'fire', 'soul_fire', 'campfire', 'soul_campfire', 'magma_block', 'cactus', 'sweet_berry_bush', 'powder_snow', 'cobweb', 'wither_rose', 'pointed_dripstone'])
const PASSABLE = new Set(['air', 'cave_air', 'void_air', 'snow', 'short_grass', 'tall_grass', 'fern', 'large_fern', 'dead_bush', 'dandelion', 'poppy', 'oxeye_daisy', 'cornflower', 'azure_bluet', 'torch', 'soul_torch', 'wall_torch', 'rail', 'powered_rail', 'detector_rail', 'activator_rail', 'lever', 'tripwire', 'string', 'seagrass', 'tall_seagrass', 'sugar_cane', 'kelp', 'kelp_plant', 'light'])
const CLIMBABLE = new Set(['ladder', 'vine', 'cave_vines', 'cave_vines_plant', 'weeping_vines', 'weeping_vines_plant', 'twisting_vines', 'twisting_vines_plant'])
const FLUID = new Set(['water', 'lava', 'bubble_column'])
/** 不可挖: 功能方块/玩家建筑件 (避免拆家) */
const NO_DIG = /(chest|barrel|shulker_box|furnace|smoker|crafting_table|_bed$|door|fence|_wall$|anvil|enchanting_table|beacon|spawner|bedrock|end_portal|obsidian|ladder|_sign$|glass|lectern|bell|brewing_stand|hopper|dispenser|dropper|jukebox|note_block|lodestone|respawn_anchor)/

const MAX_DROP = 4

export const isClimbable = (name: string) => CLIMBABLE.has(name)
/** 能开的门: 木门/栅栏门 (铁门需要红石, 视为墙) */
export const isOpenable = (name: string) => (name.endsWith('_door') || name.endsWith('_fence_gate')) && !name.startsWith('iron_')
/** 顶面高于 1 格, 不能站上去/跳上去 */
const isTall = (name: string) => name.endsWith('_fence') || name.endsWith('_wall') || name.endsWith('_fence_gate')

function isNonSolidDecor (name: string) {
  return name.endsWith('_sapling') || name.includes('torch') || name.endsWith('_carpet') ||
    name.startsWith('potted_') || name.endsWith('_sign') || name.includes('button') ||
    name.includes('pressure_plate') || name === 'lily_pad' || name.endsWith('_tulip') ||
    name.includes('mushroom') || name.includes('redstone_wire') || name.endsWith('_flower') || name.endsWith('_roots')
}

export function isDiggable (name: string): boolean {
  if (NO_DIG.test(name) || FLUID.has(name)) return false
  const h = blockInfo(name)?.hardness
  return typeof h === 'number' && h >= 0 && h <= 10
}

/** 小顶堆 */
class Heap<T> {
  private a: { k: number, v: T }[] = []
  get size () { return this.a.length }
  push (k: number, v: T) {
    const a = this.a; a.push({ k, v })
    let i = a.length - 1
    while (i > 0) { const p = (i - 1) >> 1; if (a[p].k <= a[i].k) break; [a[p], a[i]] = [a[i], a[p]]; i = p }
  }
  pop (): T {
    const a = this.a; const top = a[0]; const last = a.pop()!
    if (a.length) {
      a[0] = last
      let i = 0
      for (;;) {
        const l = 2 * i + 1, r = l + 1; let m = i
        if (l < a.length && a[l].k < a[m].k) m = l
        if (r < a.length && a[r].k < a[m].k) m = r
        if (m === i) break
        ;[a[m], a[i]] = [a[i], a[m]]; i = m
      }
    }
    return top.v
  }
}

export function findPath (world: World, from: PathNode, to: PathNode, opts: PathOptions = {}): PathNode[] | null {
  const allowSwim = opts.allowSwim ?? true
  const allowDig = opts.allowDig ?? true
  const scaffold = opts.scaffold ?? 0
  const tol = opts.tolerance ?? 1
  const maxExp = opts.maxExpansions ?? 20000
  const deadline = performance.now() + (opts.timeBudgetMs ?? 150)

  // 坐标打包成数字做键 (比 "x,y,z" 字符串快得多)
  const pack = (x: number, y: number, z: number) => ((x + 32768) * 65536 + (z + 32768)) * 512 + (y + 64)
  // 单次搜索内缓存方块名 (每次扩展要查几十个格, 重复率很高)
  const cache = new Map<number, string | null>()
  const name = (x: number, y: number, z: number) => {
    const k = pack(x, y, z)
    let v = cache.get(k)
    if (v === undefined) { v = world.getBlock(x, y, z)?.name ?? null; cache.set(k, v) }
    return v
  }
  /** 人可以占据 (含门、梯子) */
  const passable = (x: number, y: number, z: number) => {
    const n = name(x, y, z)
    if (!n || DANGER.has(n)) return false
    return PASSABLE.has(n) || CLIMBABLE.has(n) || isOpenable(n) || isNonSolidDecor(n)
  }
  /** 斜走切角检查用: 门是薄板, 不允许斜穿 */
  const openAir = (x: number, y: number, z: number) => { const n = name(x, y, z); return !!n && passable(x, y, z) && !isOpenable(n) }
  const solidish = (x: number, y: number, z: number) => {
    const n = name(x, y, z)
    if (!n || DANGER.has(n) || FLUID.has(n)) return false
    return !passable(x, y, z)
  }
  const lavaNear = (x: number, y: number, z: number) => name(x + 1, y, z) === 'lava' || name(x - 1, y, z) === 'lava' || name(x, y, z + 1) === 'lava' || name(x, y, z - 1) === 'lava' || name(x, y + 1, z) === 'lava'
  const clearable = (x: number, y: number, z: number) => {
    const n = name(x, y, z)
    return allowDig && !!n && (n === 'snow' || (solidish(x, y, z) && isDiggable(n) && !lavaNear(x, y, z)))
  }
  const isWater = (x: number, y: number, z: number) => isWatery(name(x, y, z))
  const climbable = (x: number, y: number, z: number) => { const n = name(x, y, z); return !!n && CLIMBABLE.has(n) }
  const hasDoor = (x: number, y: number, z: number) => { const a = name(x, y, z), b = name(x, y + 1, z); return (!!a && isOpenable(a)) || (!!b && isOpenable(b)) }

  /** 可作为落脚点 */
  const standable = (x: number, y: number, z: number) => {
    if (!passable(x, y, z) || !passable(x, y + 1, z)) return false
    if (climbable(x, y, z)) return true
    const below = name(x, y - 1, z)
    if (!below || DANGER.has(below)) return false
    if (below === 'water') { // 浅水可站 (水下是实心), 深水不可
      const below2 = name(x, y - 2, z)
      return !!below2 && below2 !== 'water' && !DANGER.has(below2) && !FLUID.has(below2)
    }
    return solidish(x, y - 1, z) && !isTall(below) // 脚下必须实心, 否则路径会悬空
  }

  const key = (n: PathNode) => pack(n.x, n.y, n.z)
  // 加权启发 (×1.5): 游泳/挖掘代价远高于 1/格, 纯欧氏距离会让搜索扩展过多; 换来稍次优但快得多的路径
  const h = (n: PathNode) => 1.5 * Math.hypot(n.x - to.x, (n.y - to.y) * 1.2, n.z - to.z)
  const isGoal = (n: PathNode) => tol === 0
    ? n.x === to.x && n.y === to.y && n.z === to.z
    : Math.abs(n.x - to.x) <= tol && Math.abs(n.z - to.z) <= tol && Math.abs(n.y - to.y) <= Math.max(1, tol)

  const open = new Heap<{ n: PathNode, g: number }>()
  open.push(h(from), { n: from, g: 0 })
  const cameFrom = new Map<number, PathNode>()
  const gScore = new Map<number, number>([[key(from), 0]])
  const closed = new Set<number>()
  let expansions = 0
  let cur!: PathNode
  let curG = 0

  while (open.size > 0 && expansions < maxExp) {
    const top = open.pop()
    cur = top.n; curG = top.g
    const ck = key(cur)
    if (closed.has(ck)) continue
    closed.add(ck)
    if ((++expansions & 255) === 0 && performance.now() > deadline) return null
    if (isGoal(cur)) {
      const path: PathNode[] = [cur]
      let k = ck
      while (cameFrom.has(k)) { const prev = cameFrom.get(k)!; path.unshift(prev); k = key(prev) }
      return path
    }

    const curInWater = isWater(cur.x, cur.y, cur.z)
    const curOnLadder = climbable(cur.x, cur.y, cur.z)

    // 竖直: 梯子/藤蔓上下
    if (curOnLadder && passable(cur.x, cur.y + 1, cur.z) && passable(cur.x, cur.y + 2, cur.z)) push({ x: cur.x, y: cur.y + 1, z: cur.z, climb: true }, 1.5)
    if (climbable(cur.x, cur.y - 1, cur.z)) push({ x: cur.x, y: cur.y - 1, z: cur.z, climb: true }, 1.2)
    // 竖直: 挖脚下下去 (下方 2 格须实心可落脚, 且不是岩浆)
    if (!curInWater && !curOnLadder && clearable(cur.x, cur.y - 1, cur.z) && solidish(cur.x, cur.y - 2, cur.z) && name(cur.x, cur.y - 2, cur.z) !== 'lava') {
      push({ x: cur.x, y: cur.y - 1, z: cur.z, dig: 'down' }, 5)
    }
    // 竖直: 水里上浮
    if (curInWater && allowSwim && (isWater(cur.x, cur.y + 1, cur.z) || passable(cur.x, cur.y + 1, cur.z)) && (isWater(cur.x, cur.y + 2, cur.z) || passable(cur.x, cur.y + 2, cur.z))) {
      push({ x: cur.x, y: cur.y + 1, z: cur.z, swim: isWater(cur.x, cur.y + 1, cur.z) }, 2)
    }
    // 竖直: 垫方块上升 (脚下实心, 头顶 2 格空); 当前节点本身是 pillar 时脚下就是刚放的方块 (世界模型里还没有)
    // 只在目标更高时考虑 (否则到处都能往上垫, 搜索空间爆炸)
    if (scaffold > 0 && to.y > cur.y && !curInWater && !curOnLadder && (solidish(cur.x, cur.y - 1, cur.z) || cur.place === 'pillar') && passable(cur.x, cur.y + 2, cur.z) && openAir(cur.x, cur.y + 2, cur.z)) {
      push({ x: cur.x, y: cur.y + 1, z: cur.z, place: 'pillar' }, 6)
    }

    for (const [dx, dz, cost] of NEIGHBORS) {
      const nx = cur.x + dx, nz = cur.z + dz
      const diagonal = dx !== 0 && dz !== 0
      // 斜走不能切角: 两个正交邻格在 [y, y+h) 高度内都须可通过 (门不算)
      const cornersClear = (y: number, hgt: number) => {
        if (!diagonal) return true
        for (let yy = y; yy < y + hgt; yy++) if (!openAir(cur.x + dx, yy, cur.z) || !openAir(cur.x, yy, cur.z + dz)) return false
        return true
      }
      const door = hasDoor(nx, cur.y, nz)
      if (diagonal && (door || hasDoor(cur.x, cur.y, cur.z))) continue

      // 1) 平走 / 跳 1 格
      for (const dy of [0, 1]) {
        const ny = cur.y + dy
        if (dy === 1 && !passable(cur.x, cur.y + 2, cur.z) && !isWater(cur.x, cur.y + 2, cur.z)) continue
        if (standable(nx, ny, nz) && cornersClear(cur.y, 2 + dy)) {
          push({ x: nx, y: ny, z: nz, ...(hasDoor(nx, ny, nz) ? { door: true } : {}) }, cost + (dy === 1 ? 0.5 : 0) + (door ? 1 : 0))
        }
      }

      // 2) 平向挖穿 (feet+head 需清除, 上方空, 下方实心); 只挖正交方向
      if (!diagonal && (clearable(nx, cur.y, nz) || passable(nx, cur.y, nz)) && (clearable(nx, cur.y + 1, nz) || passable(nx, cur.y + 1, nz)) &&
        (clearable(nx, cur.y, nz) || clearable(nx, cur.y + 1, nz)) && solidish(nx, cur.y - 1, nz)) {
        push({ x: nx, y: cur.y, z: nz, dig: 'flat' }, cost + 4)
      }

      // 3) 楼梯式上挖: 站上层 cur.y+1, 挖 (nx,y+1)+(nx,y+2)
      if (!diagonal && !curInWater && (clearable(nx, cur.y + 1, nz) || passable(nx, cur.y + 1, nz)) && (clearable(nx, cur.y + 2, nz) || passable(nx, cur.y + 2, nz)) &&
        (clearable(nx, cur.y + 1, nz) || clearable(nx, cur.y + 2, nz)) && solidish(nx, cur.y, nz) && passable(cur.x, cur.y + 2, cur.z)) {
        push({ x: nx, y: cur.y + 1, z: nz, dig: 'up' }, cost + 5)
      }

      // 4) 下落
      let landed = false
      for (let drop = 1; drop <= MAX_DROP && cornersClear(cur.y, 2); drop++) {
        const ny = cur.y - drop
        if (!passable(nx, ny + 1, nz) && !isWater(nx, ny + 1, nz)) break // 途中受阻
        if (standable(nx, ny, nz)) { push({ x: nx, y: ny, z: nz }, cost + drop * 0.4); landed = true; break }
        if (allowSwim && isWater(nx, ny, nz) && !isWater(nx, ny + 1, nz)) { push({ x: nx, y: ny, z: nz, swim: true }, cost + 1.5); landed = true; break }
      }

      // 5) 水面移动: feet 水, head 空 (浅水涉行便宜, 深水游泳贵)
      if (!diagonal && isWater(nx, cur.y, nz) && passable(nx, cur.y + 1, nz)) {
        const under = name(nx, cur.y - 1, nz)
        // 游泳约为步行速度的一半: 代价 ≈ 2/格
        if (under && under !== 'water' && !DANGER.has(under)) push({ x: nx, y: cur.y, z: nz }, cost + 1)
        else if (allowSwim) push({ x: nx, y: cur.y, z: nz, swim: true }, cost + 1)
      }

      // 6) 搭桥: 正交方向前方脚下是空的 (且不是能落脚的浅坑)
      if (scaffold > 0 && !diagonal && !landed && !curInWater && passable(nx, cur.y, nz) && passable(nx, cur.y + 1, nz) &&
        !door && passable(nx, cur.y - 1, nz) && !isWater(nx, cur.y - 1, nz) && !standable(nx, cur.y, nz)) {
        push({ x: nx, y: cur.y, z: nz, place: 'bridge' }, cost + 5)
      }
    }
  }
  return null

  function push (next: PathNode, stepCost: number) {
    const nk = key(next)
    const g = curG + stepCost
    if (g < (gScore.get(nk) ?? Infinity)) {
      gScore.set(nk, g)
      cameFrom.set(nk, cur)
      open.push(g + h(next), { n: next, g })
    }
  }
}

/** 路径中需要放置的方块数 */
export const placementsIn = (path: PathNode[]) => path.filter(n => n.place).length

const NEIGHBORS: [number, number, number][] = [
  [1, 0, 1], [-1, 0, 1], [0, 1, 1], [0, -1, 1],
  [1, 1, 1.45], [1, -1, 1.45], [-1, 1, 1.45], [-1, -1, 1.45],
]

/** 单格可站立 (供选接近点/逃跑点用; 与 A* 内部规则一致的简化版) */
export function standableCell (world: World, x: number, y: number, z: number): boolean {
  const n = (yy: number) => world.getBlock(x, yy, z)?.name ?? null
  const feet = n(y), head = n(y + 1), below = n(y - 1)
  if (!feet || !head || !below) return false
  const free = (b: string) => PASSABLE.has(b) || isNonSolidDecor(b) || isOpenable(b)
  if (!free(feet) || !free(head) || DANGER.has(below) || FLUID.has(below)) return false
  return !PASSABLE.has(below) && !isNonSolidDecor(below) && !isTall(below) && !isOpenable(below)
}
