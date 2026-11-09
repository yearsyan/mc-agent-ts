/**
 * World: 客户端侧世界模型。
 * - chunk 缓存 (prismarine-chunk) + 增量方块更新
 * - 实体追踪 (spawn/move/teleport/destroy, 26.3 entityDelta 格式)
 * - 方块查询 / 最高方块 / 附近实体
 */
import { createRequire } from 'node:module'

const require2 = createRequire(import.meta.url)
const mcData: any = require2('minecraft-data')('26.3')
const Chunk: any = require2('prismarine-chunk')('26.3')

export interface TrackedEntity {
  id: number
  type: string
  x: number
  y: number
  z: number
  firstSeen: number
  lastUpdate: number
  /** 掉落物实体的物品 (entity_metadata 下发) */
  item?: string
  itemCount?: number
  /** 由位置更新估算的速度 (格/tick, 指数平滑); 长时间没更新视为静止, 用 entityVelocity() 读 */
  vx: number
  vy: number
  vz: number
  /** 服务器下发的速度 (spawn_entity / entity_velocity, 格/tick) 及时间; 弹射物主要靠它 */
  sv?: { x: number, y: number, z: number, at: number }
  /** 弹射物的发射者 (spawn_entity.objectData) */
  ownerId?: number
  /** 实体元数据 (按 minecraft-data metadataKeys 命名, 如 living_entity_flags / swell_dir / in_ground) */
  meta: Record<string, any>
}

/** 实体当前速度 (格/tick): 位置更新 300ms 内用估算值, 否则视为静止 (服务器只在移动时发更新) */
export function entityVelocity (e: TrackedEntity, now = Date.now()) {
  if (now - e.lastUpdate > 300) return { x: 0, y: 0, z: 0 }
  return { x: e.vx, y: e.vy, z: e.vz }
}

const AIR = new Set(['air', 'cave_air', 'void_air'])

// stateId -> 方块名 查表 (避免 chunk.getBlock 每次构造 prismarine-block 对象, 那是热路径的主要开销)
const NAME_BY_STATE: string[] = []
for (const b of mcData.blocksArray as any[]) {
  for (let s = b.minStateId; s <= b.maxStateId; s++) NAME_BY_STATE[s] = b.name
}
const AIR_STATES = new Set<number>()
for (const n of AIR) {
  const b = mcData.blocksByName[n]
  if (b) for (let s = b.minStateId; s <= b.maxStateId; s++) AIR_STATES.add(s)
}
export const blockName = (stateId: number) => NAME_BY_STATE[stateId] ?? `unknown_${stateId}`

/** section 内可能出现的 stateId; null = 直接调色板 (无法预判, 需逐格扫描) */
function sectionStates (section: any): number[] | null {
  const data = section?.data
  if (!data) return [0]
  if (Array.isArray(data.palette)) return data.palette // Indirect (可能含已不存在的旧条目, 仅作过滤)
  if (typeof data.value === 'number') return [data.value] // SingleValue
  return null // Direct
}
const NON_SOLID = new Set([
  ...AIR, 'water', 'lava', 'snow', 'short_grass', 'tall_grass', 'fern', 'large_fern', 'dead_bush',
  'structure_void', 'light', 'bubble_column',
])

export class World {
  /** 当前维度的高度范围 (主世界 -64..320, 下界/末地 0..256; 由 resetDimension 按 dimension_type 设置) */
  min_y = -64
  world_height = 384
  /** 当前维度有基岩顶棚 (下界): 顶视最高方块是顶棚, 找地面要从自己高度附近找 */
  hasCeiling = false
  private chunks = new Map<string, any>()
  entities = new Map<number, TrackedEntity>()
  fabricRegistries = new Map<string, Set<string>>()
  private entityNameById: Map<number, string> = buildEntityNameIndex()

  /** 进入 (新) 维度: 清空区块与实体 (服务器不会为旧维度发卸载包), 换成新维度的高度 */
  resetDimension (minY: number, height: number, hasCeiling: boolean) {
    this.chunks.clear()
    this.entities.clear()
    this.lastCx = NaN; this.lastChunk = null
    this.min_y = minY
    this.world_height = height
    this.hasCeiling = hasCeiling
  }

  // ---------- chunk ----------

  loadChunk (p: any) {
    try {
      const chunk = new Chunk({ minY: this.min_y, worldHeight: this.world_height })
      chunk.load(p.chunkData)
      this.chunks.set(ck(p.x, p.z), chunk)
      this.lastCx = NaN; this.lastChunk = null
    } catch (e: any) {
      console.warn(`[world] chunk ${p.x},${p.z} 解析失败: ${e.message}`)
    }
  }

  unloadChunk (x: number, z: number) {
    this.chunks.delete(ck(x, z))
    this.lastCx = NaN; this.lastChunk = null
  }

  getChunk (cx: number, cz: number) {
    return this.chunks.get(ck(cx, cz))
  }

  get chunkCount () { return this.chunks.size }

  getBlock (x: number, y: number, z: number): { name: string, stateId: number } | null {
    if (y < this.min_y || y >= this.min_y + this.world_height) return null
    const cx = Math.floor(x) >> 4
    const cz = Math.floor(z) >> 4
    const chunk = this.chunks.get(ck(cx, cz))
    if (!chunk) return null
    try {
      const stateId = chunk.getBlockStateId({ x: Math.floor(x) & 15, y: Math.floor(y), z: Math.floor(z) & 15 })
      return { name: blockName(stateId), stateId }
    } catch {
      return null
    }
  }

  private lastCx = NaN
  private lastCz = NaN
  private lastChunk: any = null
  /** 热路径 (渲染): 只取 stateId, 不分配对象; 未加载返回 -1 */
  stateAt (x: number, y: number, z: number): number {
    if (y < this.min_y || y >= this.min_y + this.world_height) return -1
    const cx = x >> 4, cz = z >> 4
    let chunk = this.lastChunk
    if (cx !== this.lastCx || cz !== this.lastCz) { chunk = this.chunks.get(ck(cx, cz)); this.lastCx = cx; this.lastCz = cz; this.lastChunk = chunk }
    if (!chunk) return -1
    try { return chunk.getBlockStateId({ x: x & 15, y, z: z & 15 }) } catch { return -1 }
  }

  isAir (name: string) { return AIR.has(name) }

  isSolid (x: number, y: number, z: number): boolean {
    const b = this.getBlock(x, y, z)
    if (!b) return false
    if (AIR.has(b.name)) return false
    if (NON_SOLID.has(b.name)) return false
    if (b.name.endsWith('_sapling') || b.name.includes('torch') || b.name.endsWith('_carpet') || b.name.startsWith('potted_')) return false
    return true
  }

  /** 顶视: 某列最高非空气方块 */
  highestBlockY (x: number, z: number): number {
    const cx = Math.floor(x) >> 4
    const cz = Math.floor(z) >> 4
    const chunk = this.chunks.get(ck(cx, cz))
    if (!chunk) return this.min_y - 1
    const lx = Math.floor(x) & 15
    const lz = Math.floor(z) & 15
    const sections: any[] = chunk.sections ?? []
    for (let si = sections.length - 1; si >= 0; si--) {
      const states = sectionStates(sections[si])
      if (states && states.every(s => AIR_STATES.has(s))) continue // 整段空气, 跳过
      const data = sections[si].data
      for (let ly = 15; ly >= 0; ly--) {
        if (!AIR_STATES.has(data.get((ly << 8) | (lz << 4) | lx))) return this.min_y + si * 16 + ly
      }
    }
    return this.min_y - 1
  }

  /**
   * 某列的地面高度 (返回地面方块的 y, 站立格 = +1)。
   * 无顶棚维度 = 最高方块; 有顶棚 (下界) 时取 nearY 附近 (±16) 能站的格, 免得选到 y=128 的顶棚上面。
   * 有顶棚又找不到时返回 min_y-1 (调用方按"没有"处理)。
   */
  groundY (x: number, z: number, nearY: number): number {
    if (!this.hasCeiling) return this.highestBlockY(x, z)
    const free = (y: number) => { const n = this.getBlock(x, y, z)?.name; return !!n && !this.isSolid(x, y, z) && n !== 'lava' && !n.includes('fire') }
    const ny = Math.floor(nearY)
    for (let d = 0; d <= 16; d++) {
      for (const y of d ? [ny + d, ny - d] : [ny]) {
        if (!this.isSolid(x, y - 1, z) || !free(y) || !free(y + 1)) continue
        return y - 1
      }
    }
    return this.min_y - 1
  }

  setBlock (p: any) {
    const loc = p.loc ?? p.location
    if (!loc) return
    const cx = Math.floor(loc.x) >> 4
    const cz = Math.floor(loc.z) >> 4
    const chunk = this.chunks.get(ck(cx, cz))
    if (!chunk) {
      if (process.env.MC_WIRE_DEBUG) console.log(`[setBlock] 无区块 ${cx},${cz} (loc ${loc.x},${loc.y},${loc.z})`)
      return
    }
    try {
      chunk.setBlockStateId({ x: Math.floor(loc.x) & 15, y: Math.floor(loc.y), z: Math.floor(loc.z) & 15 }, p.stateId ?? p.type ?? 0)
    } catch (e: any) {
      console.warn(`[setBlock] 失败 (${loc.x},${loc.y},${loc.z}): ${e.message}`)
    }
  }

  setBlocksBulk (p: any) {
    // 26.3 格式: chunkCoordinates{x,z=chunk坐标, y=section索引} + records[]= (stateId<<12)|(x<<8|z<<4|y)
    // (原版 SectionPos.sectionRelativePos: x 在高 4 位, y 在低 4 位)
    const cc = p.chunkCoordinates ?? {}
    const cx = cc.x, cz = cc.z, sectionY = cc.y
    if (cx === undefined) return
    const chunk = this.chunks.get(ck(cx, cz))
    if (!chunk) return
    try {
      for (const r of p.records ?? []) {
        const local = Number(BigInt.asIntN(32, BigInt(r)) & 0xfffn)
        const ly = local & 15
        const lz = (local >> 4) & 15
        const lx = (local >> 8) & 15
        const stateId = Number(BigInt(r) >> 12n)
        chunk.setBlockStateId({ x: lx, y: sectionY * 16 + ly, z: lz }, stateId)
      }
    } catch (e: any) {
      console.warn(`[setBlocksBulk] 失败: ${e.message}`)
    }
  }

  applyExplosion (p: any) {
    try {
      const ox = p.x ?? 0, oy = p.y ?? 0, oz = p.z ?? 0
      for (const r of p.affectedBlockOffsets ?? []) {
        const x = Math.floor(ox + r.x), y = Math.floor(oy + r.y), z = Math.floor(oz + r.z)
        const chunk = this.chunks.get(ck(x >> 4, z >> 4))
        chunk?.setBlockStateId({ x: x & 15, y, z: z & 15 }, 0)
      }
    } catch {}
  }

  // ---------- fabric 注册表 ----------

  applyFabricRegistrySync (raw: any) {
    try {
      const buf = Buffer.isBuffer(raw) ? raw : Buffer.from(raw?.data ?? raw ?? [])
      const regs = parseFabricRegistrySync(buf)
      for (const [reg, entries] of regs) this.fabricRegistries.set(reg, entries)
    } catch (e: any) {
      console.warn(`[world] fabric registry sync 解析失败: ${e.message}`)
    }
  }

  // ---------- 实体 ----------

  trackSpawn (p: any) {
    const t = this.entityNameById.get(p.type ?? p.entityType ?? -1) ?? `type_${p.type ?? '?'}`
    const v = p.velocity
    this.entities.set(p.entityId, {
      id: p.entityId, type: t,
      x: p.x, y: p.y, z: p.z,
      firstSeen: Date.now(), lastUpdate: Date.now(),
      vx: v?.x ?? 0, vy: v?.y ?? 0, vz: v?.z ?? 0,
      ...(v ? { sv: { x: v.x, y: v.y, z: v.z, at: Date.now() } } : {}),
      ...(/arrow|trident|fireball|spit|bullet|charge|potion|snowball|egg/.test(t) && p.objectData > 0 ? { ownerId: p.objectData } : {}), // 26.3: objectData 就是发射者实体 id
      meta: {},
    })
  }

  /** 位置变化 → 更新平滑速度 */
  private observeMove (e: TrackedEntity, nx: number, ny: number, nz: number) {
    const now = Date.now()
    const dt = Math.max(1, Math.round((now - e.lastUpdate) / 50)) // tick
    const a = now - e.lastUpdate > 300 ? 1 : 0.5 // 停了一阵再动: 直接取新值
    if (dt <= 10) {
      e.vx += a * ((nx - e.x) / dt - e.vx)
      e.vy += a * ((ny - e.y) / dt - e.vy)
      e.vz += a * ((nz - e.z) / dt - e.vz)
    }
    e.x = nx; e.y = ny; e.z = nz
    e.lastUpdate = now
  }

  /** 弹射物被弹开 (速度反向且骤减, 典型是被盾挡下: 原版 deflect 速度 ×-0.1) */
  onDeflect?: (e: TrackedEntity) => void

  setEntityVelocity (entityId: number, v: { x: number, y: number, z: number }) {
    const e = this.entities.get(entityId)
    if (!e) return
    const prev = e.sv
    e.sv = { x: v.x, y: v.y, z: v.z, at: Date.now() }
    if (prev && /arrow|trident/.test(e.type)) {
      const p0 = Math.hypot(prev.x, prev.y, prev.z), p1 = Math.hypot(v.x, v.y, v.z)
      if (p0 > 0.5 && p1 > 0.02 && p1 < p0 * 0.4 && prev.x * v.x + prev.z * v.z < 0) this.onDeflect?.(e)
    }
  }

  setEntityMeta (entityId: number, key: number, value: any) {
    const e = this.entities.get(entityId)
    if (!e) return
    const keys: string[] | undefined = mcData.entitiesByName[e.type]?.metadataKeys
    e.meta[keys?.[key] ?? String(key)] = value
  }

  trackMove (entityId: number, dx: number, dy: number, dz: number) {
    const e = this.entities.get(entityId)
    if (!e) return
    this.observeMove(e, e.x + dx / 4096, e.y + dy / 4096, e.z + dz / 4096)
  }

  trackTeleport (entityId: number, x: number, y: number, z: number) {
    const e = this.entities.get(entityId)
    if (!e) return
    this.observeMove(e, x, y, z)
  }

  setEntityItem (entityId: number, item: string, count: number) {
    const e = this.entities.get(entityId)
    if (e) { e.item = item; e.itemCount = count }
  }

  trackDestroy (ids: number[]) {
    for (const id of ids) this.entities.delete(id)
  }

  /**
   * 在已加载区块中找指定方块, 返回离 (cx,cy,cz) 最近的 maxHits 个。
   * 先按 section 调色板过滤 (绝大多数 section 不含目标, 直接跳过), 命中的 section 才逐格读 stateId。
   */
  findBlock (name: string, cx: number, cz: number, radius = 48, maxHits = 5, cy?: number): { x: number, y: number, z: number }[] {
    const def = mcData.blocksByName[name]
    if (!def) return []
    const lo = def.minStateId, hi = def.maxStateId
    const match = (s: number) => s >= lo && s <= hi
    const r2 = radius * radius
    const best: { x: number, y: number, z: number, d: number }[] = [] // 按距离升序, 长度 ≤ maxHits
    for (const [key, chunk] of this.chunks) {
      const [ccx, ccz] = key.split(',').map(Number)
      const wx0 = ccx * 16, wz0 = ccz * 16
      // 粗裁剪: 区块中心距 (cx,cz) 超过 radius+12 跳过
      if ((wx0 + 8 - cx) ** 2 + (wz0 + 8 - cz) ** 2 > (radius + 12) ** 2) continue
      const sections: any[] = chunk.sections ?? []
      for (let si = 0; si < sections.length; si++) {
        const states = sectionStates(sections[si])
        if (states && !states.some(match)) continue
        const data = sections[si].data
        const y0 = this.min_y + si * 16
        for (let i = 0; i < 4096; i++) {
          if (!match(data.get(i))) continue
          const wx = wx0 + (i & 15), wz = wz0 + ((i >> 4) & 15), y = y0 + (i >> 8)
          const h2 = (wx - cx) ** 2 + (wz - cz) ** 2
          if (h2 > r2) continue
          const d = cy === undefined ? h2 : h2 + (y - cy) ** 2
          if (best.length >= maxHits && d >= best[best.length - 1].d) continue
          let k = best.length
          while (k > 0 && best[k - 1].d > d) k--
          best.splice(k, 0, { x: wx, y, z: wz, d })
          if (best.length > maxHits) best.pop()
        }
      }
    }
    return best.map(({ x, y, z }) => ({ x, y, z }))
  }

  nearbyEntities (x: number, y: number, z: number, radius: number): TrackedEntity[] {
    const r2 = radius * radius
    return [...this.entities.values()].filter(e => {
      const dx = e.x - x, dy = e.y - y, dz = e.z - z
      return dx * dx + dy * dy + dz * dz <= r2
    })
  }
}

function ck (x: number, z: number) { return `${x},${z}` }

function buildEntityNameIndex (): Map<number, string> {
  const m = new Map<number, string>()
  for (const e of Object.values<any>(mcData.entitiesByName)) m.set(e.id, e.name)
  return m
}

/** fabric:registry/sync payload 解析（尽力而为，只提取 registry -> entry 名集合） */
function parseFabricRegistrySync (buf: Buffer): Map<string, Set<string>> {
  const result = new Map<string, Set<string>>()
  let o = 0
  const varint = () => {
    let num = 0, shift = 0
    while (o < buf.length) {
      const b = buf[o++]
      num |= (b & 0x7f) << shift
      if (!(b & 0x80)) break
      shift += 7
    }
    return num >>> 0
  }
  const str = () => {
    const len = varint()
    const s = buf.subarray(o, o + len).toString('utf8')
    o += len
    return s
  }
  const regCount = varint()
  for (let i = 0; i < regCount && o < buf.length; i++) {
    const regName = str()
    const attrCount = varint()
    for (let j = 0; j < attrCount; j++) { str(); o++ }
    const entryCount = varint()
    const entries = new Set<string>()
    for (let j = 0; j < entryCount && o < buf.length; j++) {
      const entryName = str()
      entries.add(entryName)
      const runCount = varint()
      for (let k = 0; k < runCount; k++) { varint(); varint() }
    }
    result.set(regName, entries)
  }
  return result
}
