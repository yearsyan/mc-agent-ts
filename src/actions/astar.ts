/**
 * A* 寻路: 在客户端世界模型上找可行走路径。
 * 支持: 平走/斜走、跳 1 格、下落 ≤4 格、平向挖穿、楼梯式上挖(2格)、浅水涉行(深1格)。
 */
import type { World } from '../world/world.js'

export interface PathNode { x: number, y: number, z: number, dig?: 'flat' | 'up' }

const DANGER = new Set(['lava', 'flowing_lava', 'fire', 'soul_fire', 'campfire', 'magma_block', 'cactus', 'sweet_berry_bush', 'powder_snow', 'cobweb'])
const PASSABLE = new Set(['air', 'cave_air', 'void_air', 'snow', 'short_grass', 'tall_grass', 'fern', 'large_fern', 'dead_bush', 'dandelion', 'poppy', 'oxeye_daisy', 'cornflower', 'azure_bluet', 'torch', 'soul_torch', 'rail'])

const MAX_EXPANSIONS = 12000
const MAX_DROP = 4

export function findPath (world: World, from: PathNode, to: PathNode, opts: { allowDeepWater?: boolean } = {}): PathNode[] | null {
  const passable = (x: number, y: number, z: number) => {
    const b = world.getBlock(x, y, z)
    if (!b) return false
    if (DANGER.has(b.name)) return false
    return PASSABLE.has(b.name) || isNonSolidDecor(b.name)
  }

  const solidish = (x: number, y: number, z: number) => {
    const b = world.getBlock(x, y, z)
    if (!b) return false
    if (DANGER.has(b.name)) return false
    return !PASSABLE.has(b.name) && !isNonSolidDecor(b.name)
  }

  /** 该格可作为落脚点 (站立层) */
  const standable = (x: number, y: number, z: number) => {
    if (!passable(x, y, z) || !passable(x, y + 1, z)) return false
    const below = world.getBlock(x, y - 1, z)
    if (!below || DANGER.has(below.name)) return false
    // 浅水可站 (水下是实心), 深水不可
    if (below.name === 'water') {
      const below2 = world.getBlock(x, y - 2, z)
      return !!below2 && below2.name !== 'water' && !DANGER.has(below2.name)
    }
    return true
  }

  const key = (n: PathNode) => `${n.x},${n.y},${n.z}`
  const h = (n: PathNode) => Math.hypot(n.x - to.x, n.y - to.y, n.z - to.z)

  const open: { n: PathNode, f: number }[] = [{ n: from, f: h(from) }]
  const cameFrom = new Map<string, PathNode>()
  const gScore = new Map<string, number>([[key(from), 0]])
  const closed = new Set<string>()
  let expansions = 0
  let cur!: PathNode
  let ck = ''

  while (open.length > 0 && expansions < MAX_EXPANSIONS) {
    expansions++
    open.sort((a, b) => a.f - b.f)
    cur = open.shift()!.n
    ck = key(cur)
    if (closed.has(ck)) continue
    closed.add(ck)
    if (Math.abs(cur.x - to.x) <= 1 && Math.abs(cur.z - to.z) <= 1 && Math.abs(cur.y - to.y) <= 1) {
      const path: PathNode[] = [cur]
      let k = ck
      while (cameFrom.has(k)) {
        const prev = cameFrom.get(k)!
        path.unshift(prev)
        k = key(prev)
      }
      return path
    }

    for (const [dx, dz, cost] of neighbors8()) {
      const nx = cur.x + dx, nz = cur.z + dz

      // 1) 平走 / 跳1格上
      for (const dy of [0, 1]) {
        const ny = cur.y + dy
        if (standable(nx, ny, nz) && (dy === 0 || passable(cur.x, cur.y + 2, cur.z))) {
          push({ x: nx, y: ny, z: nz }, cost + (dy === 1 ? 0.5 : 0))
        }
      }

      // 可清除格: 实心或雪层 (雪有碰撞)
      const clearable = (y: number) => {
        const b = world.getBlock(nx, y, nz)
        return !!b && (b.name === 'snow' || (b.name !== 'air' && solidish(nx, y, nz)))
      }
      const airy = (y: number) => passable(nx, y, nz)

      // 2) 平向挖穿 (feet+head 需清除, 上方空, 下方实心)
      if ((clearable(cur.y) || solidish(nx, cur.y, nz)) && (clearable(cur.y + 1) || solidish(nx, cur.y + 1, nz)) && airy(cur.y + 2) && (solidish(nx, cur.y - 1, nz))) {
        push({ x: nx, y: cur.y, z: nz, dig: 'flat' }, cost + 4)
      }

      // 3) 楼梯式上挖: 站上层 cur.y+1, 挖 (nx,y+1)+(nx,y+2)
      if ((clearable(cur.y + 1) || solidish(nx, cur.y + 1, nz)) && (clearable(cur.y + 2) || solidish(nx, cur.y + 2, nz)) && airy(cur.y + 3) && solidish(nx, cur.y, nz)) {
        push({ x: nx, y: cur.y + 1, z: nz, dig: 'up' }, cost + 5)
      }

      // 4) 下落
      for (let drop = 1; drop <= MAX_DROP; drop++) {
        const ny = cur.y - drop
        if (!passable(nx, ny + 1, nz)) break // 途中受阻
        if (standable(nx, ny, nz)) {
          push({ x: nx, y: ny, z: nz }, cost + drop * 0.4)
          break
        }
      }

      // 5) 浅水涉行: feet 水, head 空, 水下实心 (深1)
      const feetB = world.getBlock(nx, cur.y, nz)
      if (feetB?.name === 'water' && passable(nx, cur.y + 1, nz)) {
        const under = world.getBlock(nx, cur.y - 1, nz)
        if (under && under.name !== 'water' && !DANGER.has(under.name)) {
          push({ x: nx, y: cur.y, z: nz }, cost + 3)
        } else if (opts.allowDeepWater) {
          push({ x: nx, y: cur.y, z: nz }, cost + 6)
        }
      }
    }
  }
  return null

  function push (next: PathNode, g: number) {
    const nk = key(next)
    const base = gScore.get(ck) ?? Infinity
    if (g + base < (gScore.get(nk) ?? Infinity)) {
      gScore.set(nk, g + base)
      cameFrom.set(nk, cur)
      open.push({ n: next, f: g + base + h(next) })
    }
  }
}

function isNonSolidDecor (name: string) {
  return name.endsWith('_sapling') || name.includes('torch') || name.endsWith('_carpet') ||
    name.startsWith('potted_') || name.endsWith('_sign') || name.includes('button') ||
    name.includes('pressure_plate') || name === 'lily_pad' || name.endsWith('_tulip') ||
    name.includes('mushroom') || name.includes('redstone_wire')
}

function * neighbors8 (): Generator<[number, number, number]> {
  yield [1, 0, 1]; yield [-1, 0, 1]; yield [0, 1, 1]; yield [0, -1, 1]
  yield [1, 1, 1.45]; yield [1, -1, 1.45]; yield [-1, 1, 1.45]; yield [-1, -1, 1.45]
}
