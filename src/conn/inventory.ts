/**
 * 库存与容器跟踪: 玩家背包(窗口0) + 打开中的容器窗口。
 * 26.3 Slot 为组件式格式, 这里只取 itemId/count。
 */
import { createRequire } from 'node:module'

const require2 = createRequire(import.meta.url)
const mcData: any = require2('minecraft-data')('26.3')

export interface ItemStack {
  itemId: number
  name: string
  count: number
}

export interface OpenWindow {
  windowId: number
  type: number
  title: string
  slots: (ItemStack | null)[]
}

const itemNameById: Map<number, string> = (() => {
  const m = new Map<number, string>()
  for (const it of mcData.itemsArray ?? mcData.items ?? []) {
    if (it?.id !== undefined) m.set(it.id, it.name)
  }
  return m
})()

export function parseSlot (s: any): ItemStack | null {
  if (!s || typeof s !== 'object' || !s.itemId) return null
  return {
    itemId: s.itemId,
    name: itemNameById.get(s.itemId) ?? `item_${s.itemId}`,
    count: s.itemCount ?? 1,
  }
}

export class Inventory {
  stateId = 0
  /** 玩家窗口: 0-4合成区(0=产物) 5-8盔甲 9-35背包 36-44快捷栏 45副手 */
  slots: (ItemStack | null)[] = Array(46).fill(null)
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
      this.slots = items.slice(0, 46)
      while (this.slots.length < 46) this.slots.push(null)
      this.cursor = parseSlot(p.carriedItem)
    } else {
      if (p.carriedItem !== undefined) this.cursor = parseSlot(p.carriedItem)
      const w = this.windows.get(p.windowId)
      if (w) w.slots = items
      // 容器窗口末尾 36 格就是玩家背包+快捷栏; 开着容器时服务器只更新容器窗口, 需同步回窗口 0
      const size = items.length - 36
      if (size > 0) for (let i = 0; i < 36; i++) this.slots[9 + i] = items[size + i]
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
        // 窗口大小以 window_items 为准 (先于 set_slot 到达); 末尾 36 格映射回玩家槽 9-44
        const size = w.slots.length - 36
        while (w.slots.length <= p.slot) w.slots.push(null)
        w.slots[p.slot] = item
        if (size > 0 && p.slot >= size && p.slot < size + 36) this.slots[9 + p.slot - size] = item
      }
    }
  }

  /** 服务器直接改玩家背包某格 (set_player_inventory): 背包下标 → 窗口 0 槽位 */
  handleSetPlayerInventory (p: any) {
    const i: number = p.slotId
    const slot = i < 9 ? 36 + i : i < 36 ? i : i < 40 ? 8 - (i - 36) : i === 40 ? 45 : -1
    if (slot >= 0) this.slots[slot] = parseSlot(p.contents)
  }

  handleSetCursor (p: any) { this.cursor = parseSlot(p.contents) }

  handleOpenWindow (p: any) {
    this.windows.set(p.windowId, { windowId: p.windowId, type: p.inventoryType, title: '', slots: [] })
    this.activeWindowId = p.windowId
  }

  close (windowId: number) {
    this.windows.delete(windowId)
    if (this.activeWindowId === windowId) this.activeWindowId = null
  }

  /** 快捷栏摘要 */
  hotbar (): (ItemStack | null)[] {
    return this.slots.slice(36, 45)
  }

  /** 简要列表: 非空槽位 */
  list (): { slot: number, name: string, count: number }[] {
    const out: { slot: number, name: string, count: number }[] = []
    this.slots.forEach((s, i) => {
      if (s) out.push({ slot: i, name: s.name, count: s.count })
    })
    return out
  }

  /** 手持物品 */
  held (): ItemStack | null { return this.slots[36 + this.heldSlot] ?? null }

  /** 背包+快捷栏 (9-44) 中满足条件的槽位, 快捷栏优先 */
  find (pred: (s: ItemStack) => boolean): { slot: number, item: ItemStack }[] {
    const out: { slot: number, item: ItemStack }[] = []
    for (const i of [36, 37, 38, 39, 40, 41, 42, 43, 44, ...Array.from({ length: 27 }, (_, k) => 9 + k)]) {
      const s = this.slots[i]
      if (s && pred(s)) out.push({ slot: i, item: s })
    }
    return out
  }

  /** 背包+快捷栏中某物品总数 */
  count (name: string): number {
    let n = 0
    for (let i = 9; i <= 44; i++) if (this.slots[i]?.name === name) n += this.slots[i]!.count
    return n
  }

  /** 物品名 → 总数 (背包+快捷栏+副手) */
  summary (): Record<string, number> {
    const out: Record<string, number> = {}
    for (let i = 9; i <= 45; i++) { const s = this.slots[i]; if (s) out[s.name] = (out[s.name] ?? 0) + s.count }
    return out
  }

  emptySlots (): number {
    let n = 0
    for (let i = 9; i <= 44; i++) if (!this.slots[i]) n++
    return n
  }

  findItem (name: string): { slot: number, item: ItemStack } | null {
    for (let i = 9; i < 46; i++) {
      const s = this.slots[i]
      if (s && s.name === name) return { slot: i, item: s }
    }
    // 也搜快捷栏之外? 9-35 是背包, 36-44 快捷栏, 全搜 9-45
    return null
  }
}
