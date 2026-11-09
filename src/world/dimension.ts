/**
 * 维度类型 (dimension_type 注册表): 高度范围 / 有无顶棚 / 能否睡床。
 * 配置阶段 registry_data 下发 (bot 回 select_known_packs 空列表, 服务器会带完整 NBT);
 * login / respawn 包 worldState.dimension 是该注册表的下标。缺数据时按原版维度兜底。
 */

export interface DimType {
  /** 注册表键 (去掉 minecraft: 前缀), 如 overworld / the_nether / the_end */
  key: string
  minY: number
  height: number
  hasCeiling: boolean
  /** 能安全睡床 (下界/末地睡床会爆炸) */
  bedWorks: boolean
  /** 水放不出来 (下界: 倒水会蒸发), 不能用落地水 */
  waterEvaporates: boolean
  /** 参数来自服务器注册表 (false = 按原版维度兜底) */
  fromRegistry?: boolean
}

const VANILLA: Record<string, Omit<DimType, 'key'>> = {
  overworld: { minY: -64, height: 384, hasCeiling: false, bedWorks: true, waterEvaporates: false },
  overworld_caves: { minY: -64, height: 384, hasCeiling: true, bedWorks: true, waterEvaporates: false },
  the_nether: { minY: 0, height: 256, hasCeiling: true, bedWorks: false, waterEvaporates: true },
  the_end: { minY: 0, height: 256, hasCeiling: false, bedWorks: false, waterEvaporates: false },
}

/** 按维度名 (minecraft:the_nether 等) 兜底 */
export function vanillaDim (name: string): DimType {
  const key = String(name).replace(/^minecraft:/, '')
  return { key, ...(VANILLA[key] ?? VANILLA.overworld) }
}

/** prismarine-nbt 的 {type, value} 结构 → 普通 JS 值 */
function plain (n: any): any {
  if (n === null || typeof n !== 'object') return n
  if (typeof n.type === 'string' && 'value' in n) {
    if (n.type === 'compound') return Object.fromEntries(Object.entries(n.value ?? {}).map(([k, v]) => [k, plain(v)]))
    if (n.type === 'list') return (n.value?.value ?? []).map((v: any) => plain({ type: n.value.type, value: v }))
    if (n.type === 'long') return Array.isArray(n.value) ? Number((BigInt(n.value[0]) << 32n) | BigInt(n.value[1] >>> 0)) : Number(n.value)
    return n.value
  }
  return n
}

const num = (x: any, d: number) => typeof x === 'number' && Number.isFinite(x) ? x : typeof x === 'bigint' ? Number(x) : d
const bool = (x: any, d: boolean) => typeof x === 'boolean' ? x : typeof x === 'number' ? x !== 0 : d

/** registry_data 的一条 dimension_type 记录 */
export function parseDimType (entry: { key: string, value?: any }): DimType {
  const base = vanillaDim(entry.key)
  const v = entry.value ? plain(entry.value) : null
  if (!v || typeof v !== 'object') return base
  // 睡床: 老格式 bed_works; 新格式环境属性 gameplay/bed_rule 的 explodes; 都没有就按原版维度
  const rule = v.attributes?.['minecraft:gameplay/bed_rule']
  const bedWorks = 'bed_works' in v ? bool(v.bed_works, base.bedWorks) : rule && typeof rule === 'object' && 'explodes' in rule ? !bool(rule.explodes, false) : base.bedWorks
  return {
    key: base.key,
    minY: num(v.min_y, base.minY),
    height: num(v.height, base.height),
    hasCeiling: bool(v.has_ceiling, base.hasCeiling),
    bedWorks,
    // 老格式 ultrawarm; 新格式环境属性 gameplay/water_evaporates
    waterEvaporates: 'ultrawarm' in v ? bool(v.ultrawarm, base.waterEvaporates) : bool(v.attributes?.['minecraft:gameplay/water_evaporates'], base.waterEvaporates),
    fromRegistry: true,
  }
}
