/**
 * 库存与容器跟踪: 玩家背包(窗口0) + 打开中的容器窗口。
 * 26.3 Slot 为组件式格式 (只下发与物品默认值不同的组件): 这里取 itemId/count + 附魔/耐久/自定义名/铁砧累计花费。
 */
import { mcData } from '../version.js'

export interface Enchant { name: string, level: number }

export interface ItemStack {
  itemId: number
  name: string
  count: number
  /** 物品身上的附魔 */
  enchantments?: Enchant[]
  /** 附魔书里存的附魔 (enchanted_book) */
  stored?: Enchant[]
  /** 已损耗耐久 / 最大耐久 (有耐久的物品才有) */
  damage?: number
  maxDamage?: number
  /** 改过的名字 (铁砧) */
  customName?: string
  /** 铁砧累计惩罚 (每过一次铁砧翻倍) */
  repairCost?: number
}

export interface OpenWindow {
  windowId: number
  type: number
  title: string
  slots: (ItemStack | null)[]
  /** 窗口属性 (craft_progress_bar): 附魔台 0-2 等级要求/4-6 附魔提示/7-9 提示等级; 铁砧 0 = 花费等级 */
  props: Record<number, number>
}

// 附魔是动态注册表: 优先用服务器 registry_data 下发的顺序, 缺了按 minecraft-data 兜底
let enchantNames: string[] = []
export function setEnchantmentNames (names: string[]) { enchantNames = names }
export function enchantName (id: number): string {
  return enchantNames[id] ?? mcData.enchantmentsArray?.find((e: any) => e.id === id)?.name ?? `enchantment_${id}`
}

/** NBT 文本组件 → 纯文本 (自定义名之类) */
function nbtText (n: any): string {
  if (n == null) return ''
  if (typeof n !== 'object') return String(n)
  if (n.type === 'string') return String(n.value)
  if (n.type === 'compound') {
    const v = n.value ?? {}
    const extra = v.extra?.value?.value ?? []
    return nbtText(v.text ?? v[''] ?? v.translate) + extra.map((e: any) => nbtText(typeof e === 'object' && !e.type ? { type: 'compound', value: e } : e)).join('')
  }
  if (typeof n.value === 'string') return n.value
  return ''
}

const enchList = (d: any): Enchant[] => (d?.enchantments ?? []).map((e: any) => ({ name: enchantName(e.id), level: e.level }))

const itemNameById: Map<number, string> = (() => {
  const m = new Map<number, string>()
  for (const it of mcData.itemsArray ?? mcData.items ?? []) {
    if (it?.id !== undefined) m.set(it.id, it.name)
  }
  return m
})()

export function parseSlot (s: any): ItemStack | null {
  if (!s || typeof s !== 'object' || !s.itemId) return null
  const it: ItemStack = {
    itemId: s.itemId,
    name: itemNameById.get(s.itemId) ?? `item_${s.itemId}`,
    count: s.itemCount ?? 1,
  }
  const maxDur = mcData.items[s.itemId]?.maxDurability
  if (maxDur) { it.damage = 0; it.maxDamage = maxDur }
  for (const c of s.components ?? []) {
    try {
      if (c.type === 'enchantments') { const l = enchList(c.data); if (l.length) it.enchantments = l }
      else if (c.type === 'stored_enchantments') it.stored = enchList(c.data)
      else if (c.type === 'damage') it.damage = Number(c.data)
      else if (c.type === 'max_damage') it.maxDamage = Number(c.data)
      else if (c.type === 'custom_name') it.customName = nbtText(c.data)
      else if (c.type === 'repair_cost') it.repairCost = Number(c.data)
    } catch {}
  }
  return it
}

/** 物品一行描述: iron_sword「Bob」 [sharpness 3, unbreaking 2] 耐久 200/250 */
export function describeItem (it: ItemStack | null | undefined): string {
  if (!it) return '空'
  const ench = (l?: Enchant[]) => l?.length ? ` [${l.map(e => `${e.name} ${e.level}`).join(', ')}]` : ''
  return `${it.name}${it.count > 1 ? `×${it.count}` : ''}${it.customName ? `「${it.customName}」` : ''}${ench(it.enchantments)}${ench(it.stored)}` +
    (it.maxDamage ? ` 耐久 ${it.maxDamage - (it.damage ?? 0)}/${it.maxDamage}` : '')
}

/** 物品的附加信息 (给 list_inventory / get_container 输出; 没有则为空对象) */
export function itemExtras (it: ItemStack): Record<string, any> {
  const o: Record<string, any> = {}
  if (it.enchantments?.length) o.enchantments = it.enchantments.map(e => `${e.name} ${e.level}`)
  if (it.stored?.length) o.stored_enchantments = it.stored.map(e => `${e.name} ${e.level}`)
  if (it.maxDamage) o.durability = `${it.maxDamage - (it.damage ?? 0)}/${it.maxDamage}`
  if (it.customName) o.custom_name = it.customName
  if (it.repairCost) o.repair_cost = it.repairCost
  return o
}

/**
 * 玩家窗口 (窗口 0) 槽位布局: 0 合成产物, 1-4 合成格, 5-8 盔甲 (头/胸/腿/靴), 9-35 背包, 36-44 快捷栏, 45 副手。
 * 容器窗口 = 容器自身 size 格 + 末尾 36 格玩家物品 (27 背包 + 9 快捷栏, 顺序同窗口 0 的 9-44)。
 * 协议相关, 换版本要核对; 业务代码用这些常量, 不写裸数字。
 */
export const SLOT = {
  craftResult: 0,
  craftGrid: 1,
  armor: 5,
  main: 9,
  hotbar: 36,
  offhand: 45,
  /** 窗口 0 总格数 */
  count: 46,
} as const
export const HOTBAR_SIZE = 9
/** window_click mode 2 (与快捷栏交换) 的 button: 0-8 快捷栏, 40 = 副手 */
export const SWAP_OFFHAND_BUTTON = 40
/** 背包 27 + 快捷栏 9 (容器窗口末尾的玩家物品格数) */
export const PLAYER_STORAGE = 36
/** 最后一个玩家物品格 (快捷栏末格) */
export const LAST_STORAGE = SLOT.main + PLAYER_STORAGE - 1

/** 快捷栏下标 0-8 → 窗口 0 槽位 */
export const hotbarSlot = (i: number) => SLOT.hotbar + i
/** 窗口 0 槽位是否在快捷栏 */
export const isHotbar = (slot: number) => slot >= SLOT.hotbar && slot < SLOT.hotbar + HOTBAR_SIZE
/** 窗口 0 槽位 → 快捷栏下标 (不在快捷栏返回 -1) */
export const hotbarIndex = (slot: number) => isHotbar(slot) ? slot - SLOT.hotbar : -1
/** 容器窗口自身格数 (窗口总格数减去末尾玩家物品) */
export const containerSize = (windowSlots: number) => Math.max(0, windowSlots - PLAYER_STORAGE)
/** 玩家槽 (9-44) → 某窗口里的槽位 (该窗口自身有 ownSize 格, 如工作台 10、交易 3、单箱 27) */
export const toWindowSlot = (slot: number, ownSize: number) => ownSize + slot - SLOT.main
/** 背包+快捷栏的槽位, 快捷栏在前 */
const STORAGE_HOTBAR_FIRST = [
  ...Array.from({ length: HOTBAR_SIZE }, (_, k) => SLOT.hotbar + k),
  ...Array.from({ length: SLOT.hotbar - SLOT.main }, (_, k) => SLOT.main + k),
]

export class Inventory {
  stateId = 0
  /** 玩家窗口槽位, 布局见 SLOT */
  slots: (ItemStack | null)[] = Array(SLOT.count).fill(null)
  cursor: ItemStack | null = null
  windows = new Map<number, OpenWindow>()
  activeWindowId: number | null = null
  /** 当前选中的快捷栏下标 0-8 (服务器 held_item_slot 下发 / 我们发出 held_item_slot 时更新) */
  heldSlot = 0

  handleWindowItems (p: any) {
    if (process.env.MC_WIRE_DEBUG) console.log(`[window_items] window=${p.windowId} count=${p.items?.length ?? 0} stateId=${p.stateId}`)
    this.stateId = p.stateId ?? this.stateId
    const items = (p.items ?? []).map(parseSlot)
    if (p.windowId === 0) {
      this.slots = items.slice(0, SLOT.count)
      while (this.slots.length < SLOT.count) this.slots.push(null)
      this.cursor = parseSlot(p.carriedItem)
    } else {
      if (p.carriedItem !== undefined) this.cursor = parseSlot(p.carriedItem)
      const w = this.windows.get(p.windowId)
      if (w) w.slots = items
      // 容器窗口末尾就是玩家背包+快捷栏; 开着容器时服务器只更新容器窗口, 需同步回窗口 0
      const size = containerSize(items.length)
      if (size > 0) for (let i = 0; i < PLAYER_STORAGE; i++) this.slots[SLOT.main + i] = items[size + i]
    }
  }

  handleSetSlot (p: any) {
    this.stateId = p.stateId ?? this.stateId
    const item = parseSlot(p.item)
    if (p.windowId === 0) {
      if (p.slot >= 0 && p.slot < this.slots.length) this.slots[p.slot] = item
      if (p.slot === -1) this.cursor = item
    } else {
      const w = this.windows.get(p.windowId)
      if (w) {
        // 窗口大小以 window_items 为准 (先于 set_slot 到达); 末尾玩家物品格映射回窗口 0 的 9-44
        const size = containerSize(w.slots.length)
        while (w.slots.length <= p.slot) w.slots.push(null)
        w.slots[p.slot] = item
        if (size > 0 && p.slot >= size && p.slot < size + PLAYER_STORAGE) this.slots[SLOT.main + p.slot - size] = item
      }
    }
  }

  /**
   * 服务器直接改玩家背包某格 (set_player_inventory): 服务端 Inventory 下标 → 窗口 0 槽位。
   * 服务端下标: 0-8 快捷栏, 9-35 背包, 36-39 靴/腿/胸/头, 40 副手
   */
  handleSetPlayerInventory (p: any) {
    const i: number = p.slotId
    const slot = i < HOTBAR_SIZE ? hotbarSlot(i) : i < PLAYER_STORAGE ? i : i < PLAYER_STORAGE + 4 ? SLOT.armor + 3 - (i - PLAYER_STORAGE) : i === PLAYER_STORAGE + 4 ? SLOT.offhand : -1
    if (slot >= 0) this.slots[slot] = parseSlot(p.contents)
  }

  handleSetCursor (p: any) { this.cursor = parseSlot(p.contents) }

  handleOpenWindow (p: any) {
    this.windows.set(p.windowId, { windowId: p.windowId, type: p.inventoryType, title: '', slots: [], props: {} })
    this.activeWindowId = p.windowId
  }

  /** 窗口属性 (craft_progress_bar): 附魔台选项 / 铁砧花费 / 熔炉进度 */
  handleWindowProperty (p: any) {
    const w = this.windows.get(p.windowId)
    if (w) w.props[p.property] = p.value
  }

  close (windowId: number) {
    this.windows.delete(windowId)
    if (this.activeWindowId === windowId) this.activeWindowId = null
  }

  /** 快捷栏摘要 */
  hotbar (): (ItemStack | null)[] {
    return this.slots.slice(SLOT.hotbar, SLOT.hotbar + HOTBAR_SIZE)
  }

  /** 简要列表: 非空槽位 */
  list (): { slot: number, name: string, count: number, [k: string]: any }[] {
    const out: { slot: number, name: string, count: number }[] = []
    this.slots.forEach((s, i) => {
      if (s) out.push({ slot: i, name: s.name, count: s.count, ...itemExtras(s) })
    })
    return out
  }

  /** 手持物品 */
  held (): ItemStack | null { return this.slots[hotbarSlot(this.heldSlot)] ?? null }

  /** 副手物品 */
  offhand (): ItemStack | null { return this.slots[SLOT.offhand] ?? null }

  /** 背包+快捷栏 (9-44) 中满足条件的槽位, 快捷栏优先 */
  find (pred: (s: ItemStack) => boolean): { slot: number, item: ItemStack }[] {
    const out: { slot: number, item: ItemStack }[] = []
    for (const i of STORAGE_HOTBAR_FIRST) {
      const s = this.slots[i]
      if (s && pred(s)) out.push({ slot: i, item: s })
    }
    return out
  }

  /** 背包+快捷栏中某物品总数 */
  count (name: string): number {
    let n = 0
    for (let i = SLOT.main; i <= LAST_STORAGE; i++) if (this.slots[i]?.name === name) n += this.slots[i]!.count
    return n
  }

  /** 物品名 → 总数 (背包+快捷栏+副手) */
  summary (): Record<string, number> {
    const out: Record<string, number> = {}
    for (let i = SLOT.main; i <= SLOT.offhand; i++) { const s = this.slots[i]; if (s) out[s.name] = (out[s.name] ?? 0) + s.count }
    return out
  }

  emptySlots (): number {
    let n = 0
    for (let i = SLOT.main; i <= LAST_STORAGE; i++) if (!this.slots[i]) n++
    return n
  }

  findItem (name: string): { slot: number, item: ItemStack } | null {
    // 背包 + 快捷栏 + 副手
    for (let i = SLOT.main; i <= SLOT.offhand; i++) {
      const s = this.slots[i]
      if (s && s.name === name) return { slot: i, item: s }
    }
    return null
  }
}
