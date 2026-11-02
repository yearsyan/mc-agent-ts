/**
 * 游戏知识: 物品/方块属性, 工具选择, 挖掘耗时, 食物, 燃料, 垫脚方块, 敌对生物。
 * 数据来自 minecraft-data 26.3; 工具速度按物品名推断 (矿石的 material 是 incorrect_for_*_tool, 无法直接查表)。
 */
import { createRequire } from 'node:module'

const require2 = createRequire(import.meta.url)
export const mcData: any = require2('minecraft-data')('26.3')
const Block: any = require2('prismarine-block')(mcData)

export const itemName = (id: number): string => mcData.items[id]?.name ?? `item_${id}`
export const itemId = (name: string): number | undefined => mcData.itemsByName[name]?.id
export const blockInfo = (name: string): any => mcData.blocksByName[name]

/** 方块状态属性 (如门的 open/half), 值统一为字符串 */
export function blockProps (stateId: number): Record<string, string> {
  try {
    const p = Block.fromStateId(stateId, 0).getProperties()
    return Object.fromEntries(Object.entries(p).map(([k, v]) => [k, String(v)]))
  } catch { return {} }
}

// ---------- 工具 ----------

const TIER_SPEED: Record<string, number> = { wooden: 2, stone: 4, copper: 5, iron: 6, diamond: 8, netherite: 9, golden: 12 }
export type ToolKind = 'pickaxe' | 'axe' | 'shovel' | 'hoe' | 'sword' | 'shears'

export function toolKind (item: string | null | undefined): ToolKind | null {
  if (!item) return null
  if (item === 'shears') return 'shears'
  const m = item.match(/_(pickaxe|axe|shovel|hoe|sword)$/)
  return (m?.[1] as ToolKind) ?? null
}

function toolTierSpeed (item: string): number {
  return TIER_SPEED[item.split('_')[0]] ?? 1
}

/** 方块偏好的工具类别 (由 material 推断) */
export function preferredTool (blockName: string): ToolKind | null {
  const mat: string = blockInfo(blockName)?.material ?? ''
  for (const part of mat.split(';')) {
    if (part === 'mineable/pickaxe' || part.startsWith('incorrect_for_')) return 'pickaxe'
    if (part === 'mineable/axe') return 'axe'
    if (part === 'mineable/shovel') return 'shovel'
    if (part === 'mineable/hoe') return 'hoe'
    if (part === 'coweb' || part === 'sword_instantly_mines') return 'sword'
    if (part === 'leaves' || part === 'wool') return 'shears'
  }
  return null
}

/** 用某物品挖某方块的 tick 数 (无效率附魔/急迫, 站在地上); Infinity = 不可破坏 */
export function digTicks (blockName: string, item: string | null): number {
  const b = blockInfo(blockName)
  if (!b) return 20
  const h: number = b.hardness ?? 0
  if (h < 0) return Infinity
  if (h === 0) return 0
  const kind = toolKind(item)
  const want = preferredTool(blockName)
  let speed = 1
  if (kind && kind === want) {
    if (kind === 'shears') speed = blockName === 'cobweb' ? 15 : (blockName.endsWith('_leaves') ? 15 : 5)
    else if (kind === 'sword') speed = blockName === 'cobweb' ? 15 : 1.5
    else speed = toolTierSpeed(item!)
  }
  const damage = speed / h / (canHarvest(blockName, item) ? 30 : 100)
  return damage >= 1 ? 0 : Math.ceil(1 / damage)
}

/** 该物品能否让方块掉落 (需要特定工具的方块, 如石头/矿石) */
export function canHarvest (blockName: string, item: string | null): boolean {
  const tools = blockInfo(blockName)?.harvestTools
  if (!tools) return true
  const id = item ? itemId(item) : undefined
  return id !== undefined && !!tools[id]
}

/** 从候选物品中挑最佳挖掘工具; 返回 null 表示空手最好 */
export function bestToolFor (blockName: string, candidates: { slot: number, name: string }[]): { slot: number | null, name: string | null, ticks: number, harvest: boolean } {
  const score = (name: string | null) => (canHarvest(blockName, name) ? 0 : 1e7) + digTicks(blockName, name)
  let best = { slot: null as number | null, name: null as string | null }
  let bestScore = score(null)
  for (const c of candidates) {
    if (!toolKind(c.name)) continue
    const s = score(c.name)
    if (s < bestScore) { best = { slot: c.slot, name: c.name }; bestScore = s }
  }
  return { ...best, ticks: digTicks(blockName, best.name), harvest: canHarvest(blockName, best.name) }
}

const WEAPON_DAMAGE: Record<string, number> = { sword: 4, axe: 6 }
/** 近战武器评分 (越大越好); 非武器 0 */
export function weaponScore (item: string): number {
  const k = toolKind(item)
  if (k !== 'sword' && k !== 'axe') return 0
  // 剑攻速快, 持续输出优于斧; 同类比材质
  return (k === 'sword' ? 100 : 50) + WEAPON_DAMAGE[k] + toolTierSpeed(item)
}

// ---------- 食物 / 燃料 / 垫脚方块 ----------

const BAD_FOOD = new Set(['rotten_flesh', 'spider_eye', 'poisonous_potato', 'pufferfish', 'suspicious_stew', 'chorus_fruit', 'raw_chicken'])
const FOOD: Map<string, number> = new Map((mcData.foodsArray ?? Object.values(mcData.foods)).map((f: any) => [f.name, f.foodPoints + f.saturation]))

/** 食物评分; 不是食物返回 0, 有副作用的食物只在 desperate 时才给分 */
export function foodScore (item: string, desperate = false): number {
  const v = FOOD.get(item)
  if (!v) return 0
  if (BAD_FOOD.has(item)) return desperate ? 0.1 : 0
  return v
}

const FUEL_TICKS: [RegExp, number][] = [
  [/^lava_bucket$/, 20000], [/^coal_block$/, 16000], [/^(coal|charcoal)$/, 1600], [/^blaze_rod$/, 2400],
  [/_(log|wood|planks|stem|hyphae)$/, 300], [/^stick$/, 100], [/_(sapling)$/, 100],
]
export function fuelTicks (item: string): number {
  for (const [re, t] of FUEL_TICKS) if (re.test(item)) return t
  return 0
}

/** 可当垫脚/搭桥的廉价方块, 按优先级 */
export const SCAFFOLD_BLOCKS = ['dirt', 'cobblestone', 'cobbled_deepslate', 'netherrack', 'andesite', 'diorite', 'granite', 'tuff', 'stone', 'coarse_dirt', 'deepslate']

// ---------- 生物 ----------

const HOSTILE = new Set([
  'zombie', 'husk', 'drowned', 'zombie_villager', 'skeleton', 'stray', 'bogged', 'wither_skeleton', 'creeper', 'spider', 'cave_spider',
  'witch', 'slime', 'magma_cube', 'phantom', 'pillager', 'vindicator', 'evoker', 'ravager', 'vex', 'blaze', 'ghast', 'hoglin', 'zoglin',
  'piglin_brute', 'silverfish', 'endermite', 'guardian', 'elder_guardian', 'breeze', 'warden', 'creaking', 'shulker',
])
const RANGED = new Set(['skeleton', 'stray', 'bogged', 'pillager', 'witch', 'blaze', 'ghast', 'breeze', 'shulker'])
export const isHostile = (type: string) => HOSTILE.has(type)
export const isRanged = (type: string) => RANGED.has(type)
const PASSIVE = /(cow|pig|sheep|chicken|horse|donkey|mule|llama|wolf|cat|ocelot|villager|rabbit|fox|bee|goat|frog|camel|sniffer|allay|parrot|turtle|axolotl|armadillo|mooshroom|panda|strider)/
export const isPassive = (type: string) => PASSIVE.test(type) && !HOSTILE.has(type)

// ---------- 液体 ----------

/** 含水方块: 海带/海草/气泡柱所在格本身充满水, 游泳/溺水判断时都按水处理 */
const WATERY = new Set(['water', 'kelp', 'kelp_plant', 'seagrass', 'tall_seagrass', 'bubble_column'])
export const isWatery = (name: string | null | undefined) => !!name && WATERY.has(name)

// ---------- 时间 ----------

/** 一天中的 tick (0=日出后 6:00); 可睡觉区间 12542..23459 */
export const isNight = (dayTime: number) => dayTime >= 12542 && dayTime <= 23459
