/**
 * 寻路改动地形: 实际挖掉/放置了哪些方块 (RouteLog), 以及走不通时给 LLM 确认的挖/搭方案 (RouteProposal)。
 * 寻路默认不改地形; 方案经 LLM 确认后, 在原动作参数里加 allow_dig / allow_place 重新下达。
 */

export type Pos3 = [number, number, number]
export interface TerrainEdit { block: string, pos: Pos3 }

/** 一种改地形的走法 */
export interface RouteProposal {
  option: 'dig' | 'place' | 'dig+place'
  /** 采用此方案要在原动作参数里加的开关 */
  allow: { allow_dig?: true, allow_place?: true }
  /** 路径步数 */
  steps: number
  /** 要挖掉的方块 (按路径顺序) */
  dig: TerrainEdit[]
  /** 要放方块的位置: bridge = 搭桥 (脚下补支撑), pillar = 原地跳起垫高 */
  place: { pos: Pos3, how: 'bridge' | 'pillar' }[]
  /** 预计消耗的垫脚方块 */
  uses?: Record<string, number>
  /** 背包里垫脚方块还差多少个 */
  shortage?: number
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
  private seen = new Set<string>()

  add (kind: 'dug' | 'placed', block: string, x: number, y: number, z: number) {
    const k = `${kind}:${x},${y},${z}`
    if (this.seen.has(k)) return
    this.seen.add(k)
    this[kind].push({ block, pos: [x, y, z] })
  }

  merge (o: RouteLog) {
    for (const e of o.dug) this.add('dug', e.block, ...e.pos)
    for (const e of o.placed) this.add('placed', e.block, ...e.pos)
  }

  get empty () { return !this.dug.length && !this.placed.length }

  toJSON () { return { dug: this.dug, placed: this.placed } }

  /** 一句话说明, 附在动作 detail 末尾 */
  note () {
    const parts: string[] = []
    if (this.dug.length) parts.push(`途中挖掉 ${this.dug.length} 块: ${editSummary(this.dug)}`)
    if (this.placed.length) parts.push(`途中放置 ${this.placed.length} 块: ${editSummary(this.placed)}`)
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
  return `${'①②③'[i] ?? `${i + 1}.`} ${parts.join(' + ')}, 共 ${p.steps} 步 → 加 ${flags}`
}
