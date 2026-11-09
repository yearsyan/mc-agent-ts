/**
 * 寻路改动地形: 实际挖掉/放置了哪些方块 (RouteLog), 以及走不通时给 LLM 确认的挖/搭方案 (RouteProposal)。
 * 寻路默认不改地形; 方案经 LLM 确认后, 在原动作参数里加 allow_dig / allow_place 重新下达。
 */

export type Pos3 = [number, number, number]
export interface TerrainEdit { block: string, pos: Pos3 }
/** 方案里要挖的一格: 用什么挖、要多久、是不是自然方块 */
export interface DigStep extends TerrainEdit {
  /** 用背包里哪件工具 (null = 空手) */
  tool: string | null
  /** 预计耗时 (秒) */
  secs: number
  /** 自然地形方块 (false = 人造, 可能是别人的建筑) */
  natural: boolean
  /** 这件工具挖不出掉落物 (如空手挖石头) */
  noDrop?: true
}

/** 一种改地形的走法 */
export interface RouteProposal {
  /** 方案 id: 原动作参数加 confirm:"<id>" = 只批准本方案列出的改动 */
  id?: string
  option: 'dig' | 'place' | 'dig+place'
  /** 方案通往哪里 (分段寻路时是中途点, 不是最终目标) */
  toward?: { x: number, y: number, z: number, waypoint?: true }
  /** 采用此方案要在原动作参数里加的开关 */
  allow: { allow_dig?: true, allow_place?: true }
  /** 路径步数 */
  steps: number
  /** 要挖掉的方块 (按路径顺序) */
  dig: DigStep[]
  /** 预计挖掘总耗时 (秒) */
  dig_s?: number
  /** 要放方块的位置: bridge = 搭桥 (脚下补支撑), pillar = 原地跳起垫高 */
  place: { pos: Pos3, how: 'bridge' | 'pillar' }[]
  /** 预计消耗的垫脚方块 */
  uses?: Record<string, number>
  /** 背包里垫脚方块还差多少个 */
  shortage?: number
  /** 是否推荐 (自然方块 + 有合适工具/徒手很快 → 推荐挖; 方块够 → 推荐搭); 方案按推荐程度排序 */
  recommended: boolean
  /** 推荐/不推荐的理由 */
  why: string[]
}

/** 按方案确认的改动: 只允许挖/放这些格 (键 "x,y,z") */
export interface Approval { ids: string[], dig: Set<string>, place: Set<string> }
export const posKey = (x: number, y: number, z: number) => `${x},${y},${z}`

/** 合并若干方案为一份批准 */
export function approvalOf (ps: RouteProposal[]): Approval {
  return {
    ids: ps.map(p => p.id ?? '?'),
    dig: new Set(ps.flatMap(p => p.dig.map(d => posKey(...d.pos)))),
    place: new Set(ps.flatMap(p => p.place.map(d => posKey(...d.pos)))),
  }
}

/** 单格挖掘超过这个秒数算"慢" (如空手挖石头 7.5s) */
export const SLOW_DIG_S = 3

/** 给方案打推荐: 挖 = 全是自然方块且每格都不慢; 搭 = 方块够 */
export function judgeProposal (p: Omit<RouteProposal, 'recommended' | 'why'>): RouteProposal {
  const why: string[] = []
  let ok = true
  if (p.dig.length) {
    const art = p.dig.filter(d => !d.natural)
    const slow = p.dig.filter(d => d.natural && d.secs > SLOW_DIG_S)
    if (art.length) { ok = false; why.push(`含人造方块 ${art.length} 块 (${editSummary(art, 3)}), 可能是别人的建筑, 不推荐挖`) }
    if (slow.length) {
      ok = false
      const s = slow[0]
      why.push(`${countBy(slow)} 挖得慢: ${s.tool ? `用 ${s.tool}` : '空手'}每块约 ${s.secs.toFixed(1)}s${s.noDrop ? ' 且不掉落' : ''}, 缺合适的工具`)
    }
    if (!art.length && !slow.length) {
      const tools = [...new Set(p.dig.map(d => d.tool ?? '空手'))].join('/')
      why.push(`全是自然方块, ${tools}共约 ${(p.dig_s ?? 0).toFixed(1)}s 挖完`)
    }
  }
  if (p.place.length) {
    if (p.shortage) { ok = false; why.push(`垫脚方块还缺 ${p.shortage} 个`) } else why.push('背包里垫脚方块够用')
  }
  return { ...p, recommended: ok, why }
}

const fmtPos = (p: Pos3) => `(${p[0]},${p[1]},${p[2]})`

function countBy (list: { block: string }[]) {
  const m = new Map<string, number>()
  for (const e of list) m.set(e.block, (m.get(e.block) ?? 0) + 1)
  return [...m].map(([b, n]) => `${b}×${n}`).join(', ')
}

/** "stone×2, dirt×1 @ (1,2,3) (4,5,6) …共 9 处" */
export function editSummary (list: TerrainEdit[], maxPos = 6) {
  const ps = list.slice(0, maxPos).map(e => fmtPos(e.pos)).join(' ')
  return `${countBy(list)} @ ${ps}${list.length > maxPos ? ` …共 ${list.length} 处` : ''}`
}

/** 实际执行中改动的地形 (去重) */
export class RouteLog {
  readonly dug: TerrainEdit[] = []
  readonly placed: TerrainEdit[] = []
  /** 落地水: 倒过水的位置, 是否已收回 (没收回的同时记进 placed) */
  readonly waterDrops: { pos: Pos3, recovered: boolean }[] = []
  private seen = new Set<string>()

  waterDrop (x: number, y: number, z: number, recovered: boolean) {
    this.waterDrops.push({ pos: [x, y, z], recovered })
    if (!recovered) this.add('placed', 'water', x, y, z)
  }

  add (kind: 'dug' | 'placed', block: string, x: number, y: number, z: number) {
    const k = `${kind}:${x},${y},${z}`
    if (this.seen.has(k)) return
    this.seen.add(k)
    this[kind].push({ block, pos: [x, y, z] })
  }

  merge (o: RouteLog) {
    for (const e of o.dug) this.add('dug', e.block, ...e.pos)
    for (const e of o.placed) this.add('placed', e.block, ...e.pos)
    for (const w of o.waterDrops) if (!this.waterDrops.some(v => v.pos.join() === w.pos.join())) this.waterDrops.push(w)
  }

  get empty () { return !this.dug.length && !this.placed.length && !this.waterDrops.length }

  toJSON () { return { dug: this.dug, placed: this.placed, ...(this.waterDrops.length ? { water_drops: this.waterDrops } : {}) } }

  /** 一句话说明, 附在动作 detail 末尾 */
  note () {
    const parts: string[] = []
    if (this.dug.length) parts.push(`途中挖掉 ${this.dug.length} 块: ${editSummary(this.dug)}`)
    if (this.placed.length) parts.push(`途中放置 ${this.placed.length} 块: ${editSummary(this.placed)}`)
    const lost = this.waterDrops.filter(w => !w.recovered).length
    if (this.waterDrops.length) parts.push(`高处跳下用了 ${this.waterDrops.length} 次落地水${lost ? ` (${lost} 处没收回, 留在原地)` : ' (都已收回)'}`)
    return parts.join('; ')
  }
}

/** 动作结束时: 把改动记录写进 extra.route, 返回附上说明的 detail */
export function settleWithRoute (a: { extra?: Record<string, unknown> }, route: RouteLog, detail: string) {
  if (route.empty) return detail
  a.extra = { ...a.extra, route: route.toJSON() }
  const note = route.note()
  return detail ? `${detail}; ${note}` : note
}

/** 方案的改动量 (挑最省的方案用) */
export const proposalCost = (p: RouteProposal) => p.dig.length + p.place.length

export function proposalText (p: RouteProposal, i: number) {
  const parts: string[] = []
  if (p.dig.length) parts.push(`挖掉 ${p.dig.length} 块 (${editSummary(p.dig)})`)
  if (p.place.length) {
    const bridge = p.place.filter(x => x.how === 'bridge').length, pillar = p.place.length - bridge
    const how = [bridge && `搭桥 ${bridge}`, pillar && `垫高 ${pillar}`].filter(Boolean).join(' / ')
    const uses = p.uses && Object.keys(p.uses).length ? `, 用 ${Object.entries(p.uses).map(([b, n]) => `${b}×${n}`).join(', ')}` : ''
    const short = p.shortage ? `, 背包还缺 ${p.shortage} 个垫脚方块 (泥土/圆石等)` : ''
    parts.push(`放 ${p.place.length} 块 (${how}${uses}${short})`)
  }
  const flags = Object.keys(p.allow).map(k => `${k}:true`).join(', ')
  const confirm = p.id ? `confirm:"${p.id}" (只批准上面列出的改动)` : ''
  return `${'①②③'[i] ?? `${i + 1}.`} ${p.recommended ? '[推荐] ' : '[不推荐] '}${parts.join(' + ')}, 共 ${p.steps} 步\n   理由: ${p.why.join('; ')}\n   采用: 原参数加 ${confirm || flags}${confirm ? ` / 或 ${flags} (整趟都允许)` : ''}`
}
